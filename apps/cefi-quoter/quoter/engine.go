package quoter

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Market describes one book being quoted.
type Market struct {
	Symbol       string `json:"symbol"`
	InstrumentID string `json:"instrumentId"`
	BaseAssetID  string `json:"baseAssetId"`
	QuoteAssetID string `json:"quoteAssetId"`
	BaseSymbol   string `json:"baseSymbol"`
	QuoteSymbol  string `json:"quoteSymbol"`
	// Reference is the main source of fair value (BTC-USD, hyperliquid:xyz:GOOGL); Blend is every
	// source, with weights and multipliers (see reference/blend.go).
	Reference string                `json:"reference"`
	Blend     reference.BlendConfig `json:"blend"`
}

// Venue is the part of the exchange the quoter reads over REST: balances, and our resting orders
// (only after a reconnect or an unanswered request). An interface so tests can run without the
// network.
type Venue interface {
	Balances(ctx context.Context) (*tm.Balances, error)
	ActiveOrders(ctx context.Context) ([]tm.RestOrder, error)
}

const (
	// A request with no drop copy after this long triggers a resync from GET /orders/active.
	stuckAfter = 5 * time.Second
	// How long a book waits for its first EBBO before quoting into a book it can't see.
	ebboGrace = 3 * time.Second
	// The most a reference price may age while its feed is alive (a product that hasn't traded).
	refMaxPriceAge = time.Minute
	// How long a rejected level waits before it is created again.
	rejectCooldown = 2 * time.Second
	// How often to re-read balances while nothing is in flight, and at most how long to wait for a
	// quiet moment before reading anyway.
	balanceEvery    = 10 * time.Second
	balanceMaxStale = 30 * time.Second
	// Quote kept back from the bids' budget, in bps, so a bid's fee hold doesn't push a fully
	// deployed ladder over the balance.
	feeHeadroomBps = 50
)

var feeHeadroom = one.Sub(decimal.NewFromInt(feeHeadroomBps).Div(decimal.NewFromInt(10_000)))

// Connection names, for status and gating.
const (
	ConnDropCopy  = "dropcopy"
	ConnMarket    = "market"
	ConnReference = "reference"
	ConnOrders    = "orders"
)

// Engine quotes one book: it runs that book's loop and keeps the state the management API shows.
// A Desk runs one Engine per book, and every Engine draws on the Desk's one Ledger.
type Engine struct {
	market Market
	log    *slog.Logger
	venue  Venue
	ledger *Ledger
	pacer  *Pacer // shared by every book; nil sends unpaced
	tx     Transport
	book   *Book
	wake   chan struct{}

	mu          sync.Mutex
	params      Params
	enabled     bool
	started     time.Time
	since       time.Time // when the position started counting: the first start, or the last reset
	ref         *reference.Tick
	refProblem  string // why the blended reference has no price, if it hasn't
	bestBid     *decimal.Decimal
	bestAsk     *decimal.Decimal
	bestBidQty  decimal.Decimal
	bestAskQty  decimal.Decimal
	ebboAt      time.Time
	lastTake    time.Time
	takeView    *TakeView
	journal     *Journal
	conns       map[string]*ConnState
	budgetBase  decimal.Decimal
	budgetQuote decimal.Decimal
	pos         position
	stats       Stats
	events      []Event
	cooldown    map[string]time.Time
	needResync  bool
	resyncAt    time.Time
	lastSend    time.Time
	orphans     []string
	lastLadder  Ladder
	lastHalt    string
	bandRejects []time.Time // price-band rejects in the last minute, for the band reject limit
	rejects     []Reject    // the latest rejects and failed requests, oldest first
}

// Reject is one request the exchange refused (or that failed to send), kept so the screen can
// show where rejects come from.
type Reject struct {
	Time    time.Time `json:"time"`
	Book    string    `json:"book"`
	Request Action    `json:"request,omitempty"` // create, modify or cancel; empty when unknown
	Side    Side      `json:"side,omitempty"`
	Level   string    `json:"level,omitempty"` // L0, L1, ... or take
	Price   string    `json:"price,omitempty"`
	Qty     string    `json:"qty,omitempty"`
	Reason  string    `json:"reason"`
	Via     string    `json:"via"` // drop copy, FIX cancel reject, or send (the request itself failed)
}

const maxRejects = 500

type ConnState struct {
	Up     bool      `json:"up"`
	Reason string    `json:"reason,omitempty"`
	Since  time.Time `json:"since"`
}

type Stats struct {
	Creates  int `json:"creates"`
	Modifies int `json:"modifies"`
	Cancels  int `json:"cancels"`
	Rejects  int `json:"rejects"`
	// RateLimited is requests refused for the exchange's rate limit (counted in Rejects or Errors
	// too). RateLimitPauses is how many of those started a pause of every book: the times the
	// quoter hit the limit, counted on the book whose request hit it.
	RateLimited     int `json:"rateLimited"`
	RateLimitPauses int `json:"rateLimitPauses"`
	Errors          int `json:"errors"`
	Fills           int `json:"fills"`
	// Takes is IOC orders sent to cross the spread; TakeFills is how many of them traded.
	Takes     int `json:"takes"`
	TakeFills int `json:"takeFills"`
}

type Event struct {
	Time    time.Time `json:"time"`
	Kind    string    `json:"kind"` // info, warn, fill, take, reject, param
	Message string    `json:"message"`
}

func NewEngine(market Market, params Params, venue Venue, ledger *Ledger, tx Transport, book *Book, enabled bool, log *slog.Logger) *Engine {
	e := &Engine{
		market:   market,
		log:      log,
		venue:    venue,
		ledger:   ledger,
		tx:       tx,
		book:     book,
		wake:     make(chan struct{}, 1),
		params:   params,
		enabled:  enabled,
		started:  time.Now(),
		since:    time.Now(),
		conns:    map[string]*ConnState{},
		cooldown: map[string]time.Time{},
	}
	for _, c := range []string{ConnDropCopy, ConnMarket, ConnReference, ConnOrders} {
		e.conns[c] = &ConnState{Since: time.Now(), Reason: "connecting"}
	}
	if tx.Ready() {
		e.conns[ConnOrders] = &ConnState{Up: true, Since: time.Now()}
	}
	return e
}

// Nudge asks the loop to run a cycle now instead of at the next tick.
func (e *Engine) Nudge() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// --- inputs from the feeds ----------------------------------------------------------------

// OnReference takes a reference price tick.
func (e *Engine) OnReference(t reference.Tick) {
	e.mu.Lock()
	e.ref = &t
	e.refProblem = ""
	e.mu.Unlock()
	if e.journal != nil {
		e.journal.Mark(e.market.Symbol, t.Mid, time.Now())
	}
	e.Nudge()
}

// OnReferenceProblem says the reference has no price right now, and why: its sources disagree, or
// are all stale. The book stops quoting until a price comes back.
func (e *Engine) OnReferenceProblem(reason string) {
	e.mu.Lock()
	changed := e.refProblem != reason
	e.refProblem = reason
	e.mu.Unlock()
	if changed {
		e.Nudge()
	}
}

// OnEBBO takes the exchange's best bid and offer for this book.
func (e *Engine) OnEBBO(d tm.EBBO) {
	parse := func(level *struct {
		Price string `json:"price"`
		Qty   string `json:"qty"`
	}) *decimal.Decimal {
		if level == nil {
			return nil
		}
		p, err := decimal.NewFromString(level.Price)
		q, _ := decimal.NewFromString(level.Qty)
		if err != nil || !p.IsPositive() || !q.IsPositive() {
			return nil
		}
		return &p
	}
	e.mu.Lock()
	e.bestBid, e.bestAsk = parse(d.Info.BestBid), parse(d.Info.BestAsk)
	e.bestBidQty, e.bestAskQty = decimal.Zero, decimal.Zero
	if e.bestBid != nil {
		e.bestBidQty = dec(d.Info.BestBid.Qty)
	}
	if e.bestAsk != nil {
		e.bestAskQty = dec(d.Info.BestAsk.Qty)
	}
	e.ebboAt = time.Now()
	e.mu.Unlock()
}

// OnDropCopy takes one drop copy for this book's instrument.
func (e *Engine) OnDropCopy(d tm.DropCopy) {
	e.log.Debug("drop copy", "event", d.EventType, "status", d.Status, "external_id", d.ExternalID, "price", d.Price, "qty", d.Quantity, "leaves", d.LeavesQty)

	// The order book, the position and the shared balance move together: a cycle (or another
	// book) never sees a fill's order gone with its position or its cost not yet counted.
	e.mu.Lock()
	var res DropCopyResult
	e.ledger.Atomically(func(debit func(string, decimal.Decimal)) {
		res = e.book.ApplyDropCopy(d)
		if res.Fill != nil {
			e.applyFillLocked(*res.Fill, debit)
		}
	})
	if res.Reject != "" {
		e.stats.Rejects++
		r := Reject{Request: res.Request, Side: res.Side, Level: levelName(res.Level), Reason: res.Reject, Via: "drop copy"}
		if res.Price.IsPositive() {
			r.Price, r.Qty = res.Price.String(), res.Qty.String()
		}
		e.rejectLocked(r)
		e.cooldown[cooldownKey(res.Side, res.Level)] = time.Now().Add(rejectCooldown)
		if isBalanceReject(res.Reject) {
			e.ledger.MarkDirty()
		}
		if isRateLimitReject(res.Reject) {
			e.rateLimitedLocked(res.Reject)
		} else {
			e.eventLocked("reject", fmt.Sprintf("%s %s rejected: %s", res.Side, levelName(res.Level), res.Reject))
			e.bandRejectLocked(res.Reject)
		}
	}
	if res.Orphan != "" {
		e.orphans = append(e.orphans, res.Orphan)
	}
	e.mu.Unlock()
	e.Nudge()
}

// OnCancelReject takes a FIX OrderCancelReject. Every book gets it; only the book that sent
// the request recognizes the ClOrdID.
func (e *Engine) OnCancelReject(clOrdID, _ string, responseTo, text string) {
	if !e.book.Knows(clOrdID) {
		return
	}
	r := Reject{Request: Cancel, Reason: text, Via: "FIX cancel reject"}
	if responseTo == "2" {
		r.Request = Modify
	}
	if o, ok := e.book.ByClOrdID(clOrdID); ok {
		r.Side, r.Level = o.Side, levelName(o.Level)
		if r.Request == Modify && o.PendingPrice != nil {
			r.Price = o.PendingPrice.String()
			if o.PendingQty != nil {
				r.Qty = o.PendingQty.String()
			}
		}
	}
	e.book.CancelRejected(clOrdID, responseTo)
	e.mu.Lock()
	e.rejectLocked(r)
	if isRateLimitReject(text) {
		e.rateLimitedLocked(text)
	} else {
		e.eventLocked("warn", "FIX cancel/replace rejected: "+text)
		e.bandRejectLocked(text)
	}
	e.mu.Unlock()
}

// rateLimitedLocked handles a request the exchange refused for its rate limit: every book stops
// sending for a while (see Pacer). One event per pause, not one per reject: a burst that hit the
// limit brings back a reject for every request still on the wire.
func (e *Engine) rateLimitedLocked(text string) {
	e.stats.RateLimited++
	if d := e.pacer.Limited(); d > 0 {
		e.stats.RateLimitPauses++
		e.eventLocked("warn", fmt.Sprintf("rate limited by the exchange (%s); every book pauses sending for %s", text, d))
	}
}

// SetConn records a connection going up or down.
func (e *Engine) SetConn(name string, up bool, reason string) {
	e.mu.Lock()
	prev := e.conns[name]
	if prev == nil || prev.Up != up {
		e.conns[name] = &ConnState{Up: up, Reason: reason, Since: time.Now()}
		if up {
			e.eventLocked("info", name+" connected")
		} else {
			e.eventLocked("warn", name+" down: "+reason)
		}
		// While the drop copy was down we heard nothing about our orders. Read them back.
		if name == ConnDropCopy && up {
			e.needResync = true
		}
	} else {
		prev.Reason = reason
	}
	e.mu.Unlock()
	e.Nudge()
}

// --- management -----------------------------------------------------------------------------

func (e *Engine) Market() Market { return e.market }

func (e *Engine) Enabled() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.enabled
}

// Idle reports a stopped book with nothing resting: safe to remove.
func (e *Engine) Idle() bool {
	return !e.Enabled() && e.book.Len() == 0
}

func (e *Engine) Params() Params {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.params
}

// UpdateParams applies a partial JSON update.
func (e *Engine) UpdateParams(patch []byte) (Params, error) {
	e.mu.Lock()
	next, err := e.params.Merge(patch)
	if err != nil {
		e.mu.Unlock()
		return e.params, err
	}
	changes := diffParams(e.params, next)
	e.params = next
	if len(changes) > 0 {
		e.eventLocked("param", "set "+strings.Join(changes, ", "))
	}
	e.mu.Unlock()
	e.Nudge()
	return next, nil
}

// SetEnabled starts or stops quoting. Stopping pulls every quote.
func (e *Engine) SetEnabled(on bool) {
	e.mu.Lock()
	if e.enabled != on {
		e.enabled = on
		if on {
			e.bandRejects = nil // a fresh start gets a fresh count
			e.eventLocked("info", "quoting started")
		} else {
			e.eventLocked("info", "quoting stopped; pulling quotes")
		}
	}
	e.mu.Unlock()
	e.Nudge()
}

// --- the loop -------------------------------------------------------------------------------

// Run is the quote loop. It runs a cycle whenever something changes (a reference tick, a drop
// copy, a parameter) and at least every 250ms.
func (e *Engine) Run(ctx context.Context) {
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-tick.C:
		}
		e.cycle(ctx)
	}
}

func (e *Engine) cycle(ctx context.Context) {
	e.cancelOrphans(ctx)
	e.maybeResync(ctx)

	if ready := e.tx.Ready(); ready != e.connUp(ConnOrders) {
		reason := ""
		if !ready {
			reason = e.tx.Name() + " order entry not connected"
		}
		e.SetConn(ConnOrders, ready, reason)
	}

	e.mu.Lock()
	// The ladder is worked out even when not quoting, so the management screen can show what the
	// quoter would quote before you start it.
	p := e.params
	if e.ref != nil && e.ledger.Fetched(e.market.BaseAssetID, e.market.QuoteAssetID) {
		e.lastLadder = e.ladderLocked(p)
	} else {
		e.lastLadder = Ladder{}
	}
	ladder := e.lastLadder
	orders := e.book.Snapshot()
	// How close each side is to a take, worked out every cycle (even when stopped) for the screen.
	view, take := e.takeLocked(p, ladder.Mid, orders)
	e.takeView = view

	halt, pull := e.haltReasonLocked()
	// Logged when the reason changes, not every cycle: "(1.2s)" ticking up isn't a new reason.
	if kind, _, _ := strings.Cut(halt, " ("); kind != e.lastHalt {
		if halt != "" {
			e.log.Info("not quoting", "reason", halt)
		} else {
			e.log.Info("quoting")
		}
		e.lastHalt = kind
	}
	if halt != "" {
		e.mu.Unlock()
		if pull {
			e.pullQuotes(ctx, halt)
		}
		return
	}
	if time.Since(e.lastSend) < time.Duration(p.MinRequoteMs)*time.Millisecond {
		e.mu.Unlock()
		return
	}
	// A take goes first: it decides whether to cross before the ladder spends the free balance.
	quotes := orders[:0:0]
	for _, o := range orders {
		if !o.Take {
			quotes = append(quotes, o) // takes are IOCs: the ladder neither moves nor cancels them
		}
	}
	in := PlanInput{
		Bids:         ladder.Bids,
		Asks:         ladder.Asks,
		Orders:       quotes,
		BestBid:      e.bestBid,
		BestAsk:      e.bestAsk,
		ThresholdBps: p.ModifyThresholdBps,
		CoolingDown:  e.coolingDownLocked,
	}
	steps := Plan(in)
	e.mu.Unlock()

	if take != nil {
		e.executeTake(ctx, take, quotes)
		// The take just changed what's free and what's resting: plan again on the next cycle.
		steps = nil
	}
	if len(steps) == 0 {
		if take != nil {
			e.mu.Lock()
			e.lastSend = time.Now()
			e.mu.Unlock()
		}
		return
	}
	e.execute(ctx, steps)
	e.mu.Lock()
	e.lastSend = time.Now()
	e.mu.Unlock()
}

// ladderLocked builds the target ladder. Each side's budget is what this book's orders hold now
// plus what's free in the shared ledger, capped by the book's allocation. Two books on the same
// quote asset each see the same free balance here; Reserve decides who gets it when they send.
func (e *Engine) ladderLocked(p Params) Ladder {
	p = p.InBase(e.ref.Mid) // sizes set in the quote currency become base at this price
	e.budgetQuote = e.ledger.Budget(e.book, e.market.QuoteAssetID, p.MaxQuoteAlloc).Mul(feeHeadroom)
	e.budgetBase = e.ledger.Budget(e.book, e.market.BaseAssetID, p.MaxBaseAlloc)
	return BuildLadder(LadderInput{
		Reference:   e.ref.Mid,
		Params:      p,
		Position:    e.pos.qty,
		BudgetQuote: e.budgetQuote,
		BudgetBase:  e.budgetBase,
	})
}

// haltReasonLocked says why the quoter shouldn't send new quotes right now ("" if it should),
// and whether the quotes already resting must come down (pull) or can stay while we wait.
func (e *Engine) haltReasonLocked() (reason string, pull bool) {
	switch {
	case !e.enabled:
		return "stopped", true
	case !e.conns[ConnOrders].Up:
		// Nothing can be sent. Over FIX, CancelOnDisconnect has already pulled the quotes.
		return "order entry not connected", false
	case !e.conns[ConnDropCopy].Up:
		// Quoting blind: we'd never hear about fills or rejects.
		return "drop copy not connected", true
	case !e.conns[ConnMarket].Up:
		return "market data not connected", true
	case e.refProblem != "":
		return e.refProblem, true
	case e.ref == nil:
		return "waiting for the reference price", true
	case time.Since(e.ref.Seen) > time.Duration(e.params.RefStaleMs)*time.Millisecond:
		return fmt.Sprintf("reference feed silent (%s)", time.Since(e.ref.Seen).Round(100*time.Millisecond)), true
	case time.Since(e.ref.Time) > refMaxPriceAge:
		return fmt.Sprintf("reference hasn't traded in %s", time.Since(e.ref.Time).Round(time.Second)), true
	case e.refGapLocked() != "":
		return e.refGapLocked(), true
	case !e.ledger.Fetched(e.market.BaseAssetID, e.market.QuoteAssetID):
		return "waiting for balances", false
	case e.ebboAt.IsZero() && time.Since(e.started) < ebboGrace:
		return "waiting for the book's best bid and offer", false
	case e.needResync:
		return "reading back orders", false
	case e.pacer.PausedFor() > 0:
		// Resting quotes stay: pulling them would take requests the limit doesn't have.
		return fmt.Sprintf("rate limited (%s)", e.pacer.PausedFor().Round(100*time.Millisecond)), false
	}
	return "", false
}

// refGapLocked trips the reference guard: the book's best bid sits well above the reference, or
// its best ask well below. Someone crossing that far is more likely right about the price than
// handing out money: the token may carry a multiplier (after a split, or dividends paid as
// shares) that the reference doesn't, or the reference itself may be wrong or pushed around.
// Quoting on would sell to that bid, or buy from that ask, far through fair value.
func (e *Engine) refGapLocked() string {
	g := e.params.MaxRefGapBps
	if g <= 0 || e.ref == nil || !e.ref.Mid.IsPositive() {
		return ""
	}
	mid := e.ref.Mid
	bps := func(x decimal.Decimal) float64 { return x.Sub(mid).Div(mid).Mul(tenK).InexactFloat64() }
	switch {
	case e.bestBid != nil && bps(*e.bestBid) > g:
		return fmt.Sprintf("reference guard: the book's best bid is %.0f bps above the reference; check the reference for a corporate action or multiplier", bps(*e.bestBid))
	case e.bestAsk != nil && -bps(*e.bestAsk) > g:
		return fmt.Sprintf("reference guard: the book's best ask is %.0f bps below the reference; check the reference for a corporate action or multiplier", -bps(*e.bestAsk))
	}
	return ""
}

func (e *Engine) connUp(name string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.conns[name].Up
}

// execute sends steps one at a time, in the order Plan chose. Sequential on purpose: each REST
// call returns once the exchange has taken the request, so a hold the previous step released
// is free by the time the next step needs it.
//
// Creates and modifies take their funds from the shared ledger first (Reserve). If another book
// spent some of the free balance since this cycle's ladder was built, the order goes out smaller,
// or not at all, instead of being rejected by the exchange.
func (e *Engine) execute(ctx context.Context, steps []Step) {
	e.mu.Lock()
	p := e.params
	var mid decimal.Decimal
	if e.ref != nil {
		mid = e.ref.Mid
	}
	e.mu.Unlock()
	p = p.InBase(mid)
	for _, s := range steps {
		if ctx.Err() != nil {
			return
		}
		// Out of requests for now: the rest waits for the next cycle, planned again with fresh
		// prices. Plan's order (cancels, then modifies that free funds, then the rest) means what
		// does go out is safe on its own. Cancels always go: the exchange doesn't rate limit them.
		if s.Kind != Cancel && !e.pacer.Take() {
			return
		}
		asset, alloc := e.market.QuoteAssetID, p.MaxQuoteAlloc
		if s.Side == Sell {
			asset, alloc = e.market.BaseAssetID, p.MaxBaseAlloc
		}
		var err error
		switch s.Kind {
		case Create:
			var o *Order
			e.ledger.Reserve(e.book, asset, alloc, func(room decimal.Decimal) {
				if qty := fit(s.Side, s.Price, s.Qty, decimal.Zero, room); qty.IsPositive() {
					s.Qty = qty
					o = e.book.BeginCreate(s.Side, s.Level, s.Price, qty)
				}
			})
			if o == nil {
				continue // no funds left for it; the next cycle sizes the ladder to what's free
			}
			var id string
			id, err = e.tx.Create(ctx, o)
			if err == nil && id != "" {
				e.book.SetOrderID(o.ExternalID, id)
			}
			e.after(s, o.ExternalID, err)
		case Modify:
			var cl, orig string
			ok := false
			e.ledger.Reserve(e.book, asset, alloc, func(room decimal.Decimal) {
				o, found := e.book.Get(s.ExternalID)
				if !found {
					return
				}
				leaves := fit(s.Side, s.Price, s.Qty.Sub(o.Executed), o.ReservedHold(), room)
				if !leaves.IsPositive() {
					return
				}
				s.Qty = leaves.Add(o.Executed)
				cl, orig, ok = e.book.BeginModify(s.ExternalID, s.Price, s.Qty)
			})
			if !ok {
				continue
			}
			err = e.tx.Modify(ctx, s.ExternalID, cl, orig, s.Price, s.Qty)
			e.after(s, s.ExternalID, err)
		case Cancel:
			cl, orig, ok := e.book.BeginCancel(s.ExternalID)
			if !ok {
				continue
			}
			err = e.tx.Cancel(ctx, s.ExternalID, cl, orig)
			e.after(s, s.ExternalID, err)
		}
		if err != nil && isRateLimitErr(err) {
			return // nothing else will get through until the window resets
		}
	}
}

func (e *Engine) after(s Step, externalID string, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case s.Level == TakeLevel:
		// counted in stats.Takes when sent
	case s.Kind == Create:
		e.stats.Creates++
	case s.Kind == Modify:
		e.stats.Modifies++
	case s.Kind == Cancel:
		e.stats.Cancels++
	}
	if err == nil {
		e.log.Debug("sent", "kind", s.Kind, "side", s.Side, "level", s.Level, "price", s.Price, "qty", s.Qty)
		return
	}
	e.stats.Errors++
	r := Reject{Request: s.Kind, Side: s.Side, Level: levelName(s.Level), Reason: err.Error(), Via: "send"}
	if s.Kind != Cancel {
		r.Price, r.Qty = s.Price.String(), s.Qty.String()
	}
	e.rejectLocked(r)
	if isRateLimitErr(err) {
		e.book.SendFailed(externalID, s.Kind)
		e.rateLimitedLocked(err.Error())
		return
	}
	if notSent(err) {
		e.book.SendFailed(externalID, s.Kind)
		if s.Kind == Create {
			e.cooldown[cooldownKey(s.Side, s.Level)] = time.Now().Add(rejectCooldown)
		}
		if isBalanceReject(err.Error()) {
			e.ledger.MarkDirty()
		}
		if s.Kind == Cancel {
			// A cancel refused usually means the order already filled or was canceled.
			e.needResync = true
		}
	}
	// What was asked for goes in the log too: a refusal usually comes down to the price or size.
	what := fmt.Sprintf("%s %s %s", s.Kind, s.Side, levelName(s.Level))
	if s.Kind != Cancel {
		what += fmt.Sprintf(" %s @ %s", s.Qty, s.Price)
	}
	e.eventLocked("warn", fmt.Sprintf("%s: %v", what, err))
	e.bandRejectLocked(err.Error())
	e.log.Warn("request failed", "kind", s.Kind, "side", s.Side, "level", s.Level, "price", s.Price, "qty", s.Qty, "external_id", externalID, "err", err)
}

// pullQuotes cancels every order not already busy.
func (e *Engine) pullQuotes(ctx context.Context, reason string) {
	var steps []Step
	for _, o := range e.book.Snapshot() {
		if o.InFlight == None && !o.Take {
			steps = append(steps, Step{Kind: Cancel, ExternalID: o.ExternalID, Side: o.Side, Level: o.Level, Reason: reason})
		}
	}
	if len(steps) > 0 && e.tx.Ready() {
		e.execute(ctx, steps)
	}
}

// Shutdown pulls every quote and waits up to timeout for the cancels to be confirmed.
func (e *Engine) Shutdown(ctx context.Context, timeout time.Duration) int {
	e.SetEnabled(false)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		e.pullQuotes(ctx, "shutting down")
		if e.book.Len() == 0 {
			return 0
		}
		time.Sleep(100 * time.Millisecond)
	}
	return e.book.Len()
}

func (e *Engine) cancelOrphans(ctx context.Context) {
	e.mu.Lock()
	orphans := e.orphans
	e.orphans = nil
	e.mu.Unlock()
	for _, id := range orphans { // cancels: not rate limited
		e.log.Warn("canceling an order of ours we weren't tracking", "external_id", id)
		_ = e.tx.Cancel(ctx, id, e.book.NewID(), id)
	}
}

// maybeResync reads our resting orders back over REST when the drop copy has just reconnected or
// a request has gone unanswered. This is the only order read over REST once running: the drop
// copy carries everything else.
func (e *Engine) maybeResync(ctx context.Context) {
	e.mu.Lock()
	need := e.needResync || len(e.book.Stuck(stuckAfter)) > 0
	if !need || time.Since(e.resyncAt) < 2*time.Second || !e.conns[ConnDropCopy].Up {
		e.mu.Unlock()
		return
	}
	e.resyncAt = time.Now()
	e.mu.Unlock()

	active, err := e.venue.ActiveOrders(ctx)
	if err != nil {
		e.log.Warn("resync failed", "err", err)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	var orphans []string
	e.ledger.Atomically(func(debit func(string, decimal.Decimal)) {
		var fills []Fill
		fills, orphans = e.book.Resync(active, stuckAfter)
		for _, f := range fills {
			e.applyFillLocked(f, debit)
		}
	})
	e.needResync = false
	e.orphans = append(e.orphans, orphans...)
	e.eventLocked("info", fmt.Sprintf("read back %d resting orders", e.book.Len()))
}

// --- position and PnL ----------------------------------------------------------------------

// position tracks what this quoter has bought and sold since it started, at average cost.
type position struct {
	qty      decimal.Decimal // + long, - short, in base
	avgCost  decimal.Decimal
	realized decimal.Decimal // in quote
	volBase  decimal.Decimal
	volQuote decimal.Decimal
}

func (p *position) apply(side Side, qty, price decimal.Decimal) {
	signed := qty
	if side == Sell {
		signed = qty.Neg()
	}
	p.volBase = p.volBase.Add(qty)
	p.volQuote = p.volQuote.Add(qty.Mul(price))
	switch {
	case p.qty.IsZero() || p.qty.Sign() == signed.Sign():
		// Adding to the position: blend the cost.
		total := p.qty.Abs().Add(qty)
		p.avgCost = p.qty.Abs().Mul(p.avgCost).Add(qty.Mul(price)).Div(total)
		p.qty = p.qty.Add(signed)
	default:
		// Reducing it: realize PnL on the part closed.
		closed := decimal.Min(qty, p.qty.Abs())
		pnl := price.Sub(p.avgCost).Mul(closed)
		if p.qty.IsNegative() {
			pnl = pnl.Neg()
		}
		p.realized = p.realized.Add(pnl)
		wasLong := p.qty.IsPositive()
		p.qty = p.qty.Add(signed)
		switch {
		case p.qty.IsZero():
			p.avgCost = decimal.Zero
		case p.qty.IsPositive() != wasLong:
			p.avgCost = price // flipped through flat: the remainder was opened at this price
		}
	}
}

func (e *Engine) applyFillLocked(f Fill, debit func(assetID string, amount decimal.Decimal)) {
	e.pos.apply(f.Side, f.Qty, f.Price)
	e.stats.Fills++
	switch {
	case e.journal == nil:
	case e.ref != nil && e.ref.Mid.IsPositive():
		e.journal.Add(e.market, f, e.ref.Mid)
	default:
		e.journal.AddUnpriced(e.market, f) // counted, but with nothing to measure its edge against
	}
	if f.Level == TakeLevel {
		e.stats.TakeFills++
	}
	// Debit what the fill spent, so no book is sized against funds that are gone. Never credit
	// what it bought until the next balance read: it can land unsettled.
	if f.Side == Buy {
		debit(e.market.QuoteAssetID, f.Qty.Mul(f.Price))
	} else {
		debit(e.market.BaseAssetID, f.Qty)
	}
	e.eventLocked("fill", fmt.Sprintf("%s %s %s @ %s (%s)", f.Side, f.Qty, e.market.BaseSymbol, f.Price, levelName(f.Level)))
	e.log.Info("fill", "side", f.Side, "qty", f.Qty, "price", f.Price, "level", f.Level, "position", e.pos.qty)
}

// --- helpers --------------------------------------------------------------------------------

func (e *Engine) eventLocked(kind, msg string) {
	e.events = append(e.events, Event{Time: time.Now(), Kind: kind, Message: msg})
	if len(e.events) > 200 {
		e.events = e.events[len(e.events)-200:]
	}
	if kind == "warn" || kind == "reject" {
		e.log.Warn(msg)
	} else {
		e.log.Info(msg)
	}
}

func (e *Engine) coolingDownLocked(side Side, level int) bool {
	return time.Now().Before(e.cooldown[cooldownKey(side, level)])
}

// fit is the largest size, up to want, that the exchange will accept and whose hold fits in the
// order's current hold plus room. Zero if not even the minimum fits.
func fit(side Side, price, want, current, room decimal.Decimal) decimal.Decimal {
	if !price.IsPositive() || !want.IsPositive() {
		return decimal.Zero
	}
	limit := current.Add(room)
	if side == Buy {
		limit = current.Add(room.Mul(feeHeadroom)).Div(price)
	}
	return formatSize(price, decimal.Min(want, limit), IncrementsFor(price))
}

func levelName(level int) string {
	if level == TakeLevel {
		return "take"
	}
	return fmt.Sprintf("L%d", level)
}

func cooldownKey(side Side, level int) string { return fmt.Sprintf("%s:%d", side, level) }

// rejectLocked keeps a reject for the screen.
func (e *Engine) rejectLocked(r Reject) {
	r.Time, r.Book = time.Now(), e.market.Symbol
	e.rejects = append(e.rejects, r)
	if len(e.rejects) > maxRejects {
		e.rejects = e.rejects[len(e.rejects)-maxRejects:]
	}
}

// Rejects returns the book's kept rejects, newest first.
func (e *Engine) Rejects() []Reject {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Reject, len(e.rejects))
	for i, r := range e.rejects {
		out[len(out)-1-i] = r
	}
	return out
}

// bandRejectLocked counts a reject for the exchange's price band ("Order outside book price
// bands") and stops the book when the band reject limit is reached within a minute. The band is
// centered on the exchange's own reference price, so a run of them means that and the quoter's
// reference disagree: the quoter would keep sending orders the exchange refuses, and whichever
// price is wrong, quoting on one side only isn't market making. Stopping pulls every quote and
// stays stopped until someone starts the book again.
func (e *Engine) bandRejectLocked(text string) {
	limit := e.params.BandRejectLimit
	if !isBandReject(text) || limit <= 0 || !e.enabled {
		return
	}
	now := time.Now()
	kept := e.bandRejects[:0]
	for _, t := range e.bandRejects {
		if now.Sub(t) < bandRejectWindow {
			kept = append(kept, t)
		}
	}
	e.bandRejects = append(kept, now)
	if len(e.bandRejects) < limit {
		return
	}
	e.bandRejects = nil
	e.enabled = false
	e.eventLocked("warn", fmt.Sprintf("stopped: %d orders rejected for the exchange's price band within a minute; the exchange's reference price and this book's reference disagree. Check both, then start the book again", limit))
}

const bandRejectWindow = time.Minute

func isBandReject(text string) bool {
	return strings.Contains(strings.ToLower(text), "price band")
}

func isBalanceReject(text string) bool {
	t := strings.ToLower(text)
	return strings.Contains(t, "insufficient") || strings.Contains(t, "balance")
}

func dec(s string) decimal.Decimal {
	d, err := decimal.NewFromString(s)
	if err != nil {
		return decimal.Zero
	}
	return d
}

func diffParams(a, b Params) []string {
	var aj, bj map[string]any
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	_ = json.Unmarshal(ab, &aj)
	_ = json.Unmarshal(bb, &bj)
	var out []string
	for _, s := range Schema() {
		if fmt.Sprint(aj[s.Key]) != fmt.Sprint(bj[s.Key]) {
			out = append(out, fmt.Sprintf("%s=%v", s.Key, bj[s.Key]))
		}
	}
	return out
}

// --- taking (see taker.go) -------------------------------------------------------------------

// takeLocked works out both sides' take proximity, and the take to send this cycle (or nil). One
// take at a time, none within the cool-down of the last, and none while the book isn't quoting.
func (e *Engine) takeLocked(set Params, mid decimal.Decimal, orders []Order) (*TakeView, *takeDecision) {
	if e.ref == nil || !mid.IsPositive() {
		return nil, nil
	}
	// What other people show at the best prices: our own quotes there aren't liquidity we can take.
	external := func(best *decimal.Decimal, qty decimal.Decimal, side Side) decimal.Decimal {
		if best == nil {
			return decimal.Zero
		}
		for _, o := range orders {
			if !o.Take && o.Side == side && o.EffectivePrice().Equal(*best) {
				qty = qty.Sub(o.EffectiveLeaves())
			}
		}
		return decimal.Max(qty, decimal.Zero)
	}
	view, d := evaluateTakes(takeInput{
		Params:    set.InBase(e.ref.Mid),
		Mid:       mid,
		Position:  e.pos.qty,
		AvgCost:   e.pos.avgCost,
		BestBid:   e.bestBid,
		BestAsk:   e.bestAsk,
		BidQty:    external(e.bestBid, e.bestBidQty, Buy),
		AskQty:    external(e.bestAsk, e.bestAskQty, Sell),
		FreeBase:  e.ledger.Free(e.market.BaseAssetID),
		FreeQuote: e.ledger.Free(e.market.QuoteAssetID),
	})
	// What holds back a take that the book itself would allow.
	hold := ""
	if halt, _ := e.haltReasonLocked(); halt != "" {
		hold = "not quoting"
	} else if left := time.Duration(set.TakeCoolDownMs)*time.Millisecond - time.Since(e.lastTake); left > 0 {
		hold = "cool-down"
	} else {
		for _, o := range orders {
			if o.Take {
				hold = "take in flight"
			}
		}
	}
	if hold != "" {
		for _, ts := range []*TakeSide{&view.Buy, &view.Sell} {
			if ts.Blocker == "" || ts.Blocker == blockedNoFunds {
				ts.Blocker = hold
			}
		}
		d = nil
	}
	return &view, d
}

// executeTake sends a take as an IOC, after reserving its funds like any order. If a profit take
// has the edge but our own quotes on that side hold everything, it pulls the outermost of them
// first; the take goes out on a later cycle, once the cancel has freed the funds.
func (e *Engine) executeTake(ctx context.Context, d *takeDecision, quotes []Order) {
	if d.Unfunded {
		var outer *Order
		for i := range quotes {
			o := &quotes[i]
			if o.Side != d.Side {
				continue
			}
			if o.InFlight == Cancel {
				return // already freeing funds
			}
			if o.InFlight == None && (outer == nil || o.Level > outer.Level) {
				outer = o
			}
		}
		if outer == nil {
			return
		}
		e.mu.Lock()
		e.eventLocked("info", fmt.Sprintf("%s %s: pulling %s L%d to free funds", d.Kind, d.Side, outer.Side, outer.Level))
		e.mu.Unlock()
		e.execute(ctx, []Step{{Kind: Cancel, ExternalID: outer.ExternalID, Side: outer.Side, Level: outer.Level, Reason: "freeing funds for a profit take"}})
		return
	}
	set := e.Params()
	asset, alloc := e.market.QuoteAssetID, set.MaxQuoteAlloc
	if d.Side == Sell {
		asset, alloc = e.market.BaseAssetID, set.InBase(d.Price).MaxBaseAlloc
	}
	if d.Kind == ProfitTake {
		alloc = decimal.Zero // getting out isn't held to the book's allocation, only to what's free
	}
	if !e.pacer.Take() {
		return
	}
	var o *Order
	e.ledger.Reserve(e.book, asset, alloc, func(room decimal.Decimal) {
		if qty := fit(d.Side, d.Price, d.Qty, decimal.Zero, room); qty.IsPositive() {
			o = e.book.BeginTake(d.Side, d.Price, qty, d.Kind)
		}
	})
	if o == nil {
		return
	}
	e.mu.Lock()
	e.lastTake = time.Now()
	e.stats.Takes++
	e.eventLocked("take", fmt.Sprintf("%s %s %s %s @ %s, %.1f bps over the skewed mid", d.Kind, d.Side, o.Qty, e.market.BaseSymbol, o.Price, d.EdgeBps))
	e.mu.Unlock()
	id, err := e.tx.Create(ctx, o)
	if err == nil && id != "" {
		e.book.SetOrderID(o.ExternalID, id)
	}
	e.after(Step{Kind: Create, Side: d.Side, Level: TakeLevel, Price: o.Price, Qty: o.Qty}, o.ExternalID, err)
}
