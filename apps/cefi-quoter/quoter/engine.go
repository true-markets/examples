package quoter

import (
	"context"
	"encoding/json"
	"errors"
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
	Reference    string `json:"reference"` // the Coinbase product for fair value, e.g. BTC-USD
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
	tx     Transport
	book   *Book
	wake   chan struct{}

	mu          sync.Mutex
	params      Params
	enabled     bool
	started     time.Time
	ref         *reference.Tick
	bestBid     *decimal.Decimal
	bestAsk     *decimal.Decimal
	ebboAt      time.Time
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
}

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
	Errors   int `json:"errors"`
	Fills    int `json:"fills"`
}

type Event struct {
	Time    time.Time `json:"time"`
	Kind    string    `json:"kind"` // info, warn, fill, reject, param
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
	e.mu.Unlock()
	e.Nudge()
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
	e.ebboAt = time.Now()
	e.mu.Unlock()
}

// OnDropCopy takes one drop copy for this book's instrument.
func (e *Engine) OnDropCopy(d tm.DropCopy) {
	res := e.book.ApplyDropCopy(d)
	e.log.Debug("drop copy", "event", d.EventType, "status", d.Status, "external_id", d.ExternalID, "price", d.Price, "qty", d.Quantity, "leaves", d.LeavesQty)

	e.mu.Lock()
	if res.Fill != nil {
		e.applyFillLocked(*res.Fill)
	}
	if res.Reject != "" {
		e.stats.Rejects++
		e.cooldown[cooldownKey(res.Side, res.Level)] = time.Now().Add(rejectCooldown)
		if isBalanceReject(res.Reject) {
			e.ledger.MarkDirty()
		}
		e.eventLocked("reject", fmt.Sprintf("%s L%d rejected: %s", res.Side, res.Level, res.Reject))
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
	e.book.CancelRejected(clOrdID, responseTo)
	e.mu.Lock()
	e.eventLocked("warn", "FIX cancel/replace rejected: "+text)
	e.mu.Unlock()
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
	in := PlanInput{
		Bids:         ladder.Bids,
		Asks:         ladder.Asks,
		Orders:       e.book.Snapshot(),
		BestBid:      e.bestBid,
		BestAsk:      e.bestAsk,
		ThresholdBps: p.ModifyThresholdBps,
		CoolingDown:  e.coolingDownLocked,
	}
	steps := Plan(in)
	e.mu.Unlock()

	if len(steps) == 0 {
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
	case e.ref == nil:
		return "waiting for the reference price", true
	case time.Since(e.ref.Seen) > time.Duration(e.params.RefStaleMs)*time.Millisecond:
		return fmt.Sprintf("reference feed silent (%s)", time.Since(e.ref.Seen).Round(100*time.Millisecond)), true
	case time.Since(e.ref.Time) > refMaxPriceAge:
		return fmt.Sprintf("reference hasn't traded in %s", time.Since(e.ref.Time).Round(time.Second)), true
	case !e.ledger.Fetched(e.market.BaseAssetID, e.market.QuoteAssetID):
		return "waiting for balances", false
	case e.ebboAt.IsZero() && time.Since(e.started) < ebboGrace:
		return "waiting for the book's best bid and offer", false
	case e.needResync:
		return "reading back orders", false
	}
	return "", false
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
		if errors.Is(err, tm.ErrRateLimited) {
			return // nothing else will get through until the window resets
		}
	}
}

func (e *Engine) after(s Step, externalID string, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch s.Kind {
	case Create:
		e.stats.Creates++
	case Modify:
		e.stats.Modifies++
	case Cancel:
		e.stats.Cancels++
	}
	if err == nil {
		e.log.Debug("sent", "kind", s.Kind, "side", s.Side, "level", s.Level, "price", s.Price, "qty", s.Qty)
		return
	}
	e.stats.Errors++
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
	what := fmt.Sprintf("%s %s L%d", s.Kind, s.Side, s.Level)
	if s.Kind != Cancel {
		what += fmt.Sprintf(" %s @ %s", s.Qty, s.Price)
	}
	e.eventLocked("warn", fmt.Sprintf("%s: %v", what, err))
	e.log.Warn("request failed", "kind", s.Kind, "side", s.Side, "level", s.Level, "price", s.Price, "qty", s.Qty, "external_id", externalID, "err", err)
}

// pullQuotes cancels every order not already busy.
func (e *Engine) pullQuotes(ctx context.Context, reason string) {
	var steps []Step
	for _, o := range e.book.Snapshot() {
		if o.InFlight == None {
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
	for _, id := range orphans {
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
	fills, orphans := e.book.Resync(active, stuckAfter)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.needResync = false
	for _, f := range fills {
		e.applyFillLocked(f)
	}
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

func (e *Engine) applyFillLocked(f Fill) {
	e.pos.apply(f.Side, f.Qty, f.Price)
	e.stats.Fills++
	// Debit what the fill spent, so no book is sized against funds that are gone. Never credit
	// what it bought until the next balance read: it can land unsettled.
	if f.Side == Buy {
		e.ledger.Debit(e.market.QuoteAssetID, f.Qty.Mul(f.Price))
	} else {
		e.ledger.Debit(e.market.BaseAssetID, f.Qty)
	}
	e.eventLocked("fill", fmt.Sprintf("%s %s %s @ %s (L%d)", f.Side, f.Qty, e.market.BaseSymbol, f.Price, f.Level))
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

func cooldownKey(side Side, level int) string { return fmt.Sprintf("%s:%d", side, level) }

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
