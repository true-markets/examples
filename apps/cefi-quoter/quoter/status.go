package quoter

import (
	"fmt"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
)

// Status is everything the management API shows about one book right now.
type Status struct {
	Market    Market           `json:"market"`
	Enabled   bool             `json:"enabled"`
	State     string           `json:"state"` // quoting, waiting or stopped
	Reason    string           `json:"reason,omitempty"`
	Params    Params           `json:"params"`
	Reference *Price           `json:"reference"`
	BestBid   *decimal.Decimal `json:"bestBid"`
	BestAsk   *decimal.Decimal `json:"bestAsk"`
	Mid       *decimal.Decimal `json:"mid"` // reference after skew
	SkewBps   float64          `json:"skewBps"`
	Position  PositionStatus   `json:"position"`
	Balances  BalanceStatus    `json:"balances"`
	Orders    []OrderStatus    `json:"orders"`
	Targets   []Target         `json:"targets"`
	Stats     Stats            `json:"stats"`
	Events    []Event          `json:"events"`
	Warnings  []string         `json:"warnings"`
	Taking    *TakeView        `json:"taking"` // how close each side is to a take
	// Blend is the reference's sources right now: each one's price, its part in the blend, and
	// anything that looks like a corporate action. Set by the desk.
	Blend *reference.BlendView `json:"blend,omitempty"`
}

type Price struct {
	Mid   decimal.Decimal `json:"mid"`
	Bid   decimal.Decimal `json:"bid"`
	Ask   decimal.Decimal `json:"ask"`
	AgeMs int64           `json:"ageMs"`
}

type PositionStatus struct {
	Qty         decimal.Decimal `json:"qty"`
	AvgCost     decimal.Decimal `json:"avgCost"`
	RealizedPnl decimal.Decimal `json:"realizedPnl"`
	// Unrealized marks the open position to the reference mid.
	UnrealizedPnl decimal.Decimal `json:"unrealizedPnl"`
	VolumeBase    decimal.Decimal `json:"volumeBase"`
	VolumeQuote   decimal.Decimal `json:"volumeQuote"`
	// Since is when the position started counting: the book's first start, or its last reset.
	// It carries across restarts.
	Since time.Time `json:"since"`
}

// BalanceStatus is this book's view of the shared balances. Free is shared by every book on the
// asset; Budget and Held are this book's own.
type BalanceStatus struct {
	FreeBase    decimal.Decimal `json:"freeBase"`
	FreeQuote   decimal.Decimal `json:"freeQuote"`
	BudgetBase  decimal.Decimal `json:"budgetBase"`
	BudgetQuote decimal.Decimal `json:"budgetQuote"`
	HeldBase    decimal.Decimal `json:"heldBase"`
	HeldQuote   decimal.Decimal `json:"heldQuote"`
	ReadAt      *time.Time      `json:"readAt"`
}

type OrderStatus struct {
	ExternalID   string           `json:"externalId"`
	OrderID      string           `json:"orderId,omitempty"`
	Side         Side             `json:"side"`
	Level        int              `json:"level"` // -1 for a take
	Take         bool             `json:"take,omitempty"`
	Price        decimal.Decimal  `json:"price"`
	Qty          decimal.Decimal  `json:"qty"`
	Leaves       decimal.Decimal  `json:"leaves"`
	Executed     decimal.Decimal  `json:"executed"`
	PendingPrice *decimal.Decimal `json:"pendingPrice,omitempty"`
	PendingQty   *decimal.Decimal `json:"pendingQty,omitempty"`
	Status       string           `json:"status"`
	AgeMs        int64            `json:"pendingMs,omitempty"`
}

func (e *Engine) Status() Status {
	orders := e.book.Snapshot()
	e.mu.Lock()
	defer e.mu.Unlock()

	reason, _ := e.haltReasonLocked()
	state := "quoting"
	switch {
	case !e.enabled:
		state = "stopped"
	case reason != "":
		state = "waiting"
	}
	s := Status{
		Market:   e.market,
		Enabled:  e.enabled,
		State:    state,
		Reason:   reason,
		Params:   e.params,
		BestBid:  e.bestBid,
		BestAsk:  e.bestAsk,
		SkewBps:  e.lastLadder.SkewBps,
		Stats:    e.stats,
		Events:   append([]Event(nil), e.events...),
		Orders:   []OrderStatus{},
		Targets:  append(append([]Target{}, e.lastLadder.Bids...), e.lastLadder.Asks...),
		Warnings: []string{},
		Taking:   e.takeView,
	}
	if e.ref != nil {
		s.Reference = &Price{Mid: e.ref.Mid, Bid: e.ref.Bid, Ask: e.ref.Ask, AgeMs: time.Since(e.ref.Time).Milliseconds()}
		if e.lastLadder.Mid.IsPositive() {
			m := e.lastLadder.Mid
			s.Mid = &m
		}
	}
	if e.params.ModifyThresholdBps > e.params.SpreadBps {
		s.Warnings = append(s.Warnings, "the modify threshold is wider than the spread, so an order can lag its target by more than the spread and sit on the wrong side of the mid; lower modifyThresholdBps or widen spreadBps")
	}
	p := e.pos
	s.Position = PositionStatus{Qty: p.qty, AvgCost: p.avgCost, RealizedPnl: p.realized, VolumeBase: p.volBase, VolumeQuote: p.volQuote, Since: e.since}
	if e.ref != nil && !p.qty.IsZero() {
		s.Position.UnrealizedPnl = e.ref.Mid.Sub(p.avgCost).Mul(p.qty)
	}
	s.Balances = BalanceStatus{
		FreeBase: e.ledger.Free(e.market.BaseAssetID), FreeQuote: e.ledger.Free(e.market.QuoteAssetID),
		BudgetBase: e.budgetBase, BudgetQuote: e.budgetQuote,
	}
	if t := e.ledger.ReadAt(); !t.IsZero() {
		s.Balances.ReadAt = &t
	}
	for _, o := range orders {
		os := OrderStatus{
			ExternalID: o.ExternalID, OrderID: o.OrderID, Side: o.Side, Level: o.Level, Take: o.Take,
			Price: o.Price, Qty: o.Qty, Leaves: o.Leaves, Executed: o.Executed,
			PendingPrice: o.PendingPrice, PendingQty: o.PendingQty, Status: o.Status(),
		}
		if o.InFlight != None {
			os.AgeMs = time.Since(o.SentAt).Milliseconds()
		}
		s.Orders = append(s.Orders, os)
		if o.Side == Buy {
			s.Balances.HeldQuote = s.Balances.HeldQuote.Add(o.Hold())
		} else {
			s.Balances.HeldBase = s.Balances.HeldBase.Add(o.Hold())
		}
	}
	if mid := e.lastLadder.Mid; mid.IsPositive() {
		if len(e.lastLadder.Bids) == 0 {
			s.Warnings = append(s.Warnings, "no bids: "+e.emptySideReasonLocked(Buy, mid))
		}
		if len(e.lastLadder.Asks) == 0 {
			s.Warnings = append(s.Warnings, "no asks: "+e.emptySideReasonLocked(Sell, mid))
		}
	}
	return s
}

// emptySideReasonLocked says which limit leaves a side with no level: the max position change or the
// budget, whichever can't fit one minimum-size order (the exchange's $1 minimum) at this price.
func (e *Engine) emptySideReasonLocked(side Side, mid decimal.Decimal) string {
	set, base, quote := e.params, e.market.BaseSymbol, e.market.QuoteSymbol
	p := set.InBase(mid)
	minSize := MinSize(mid)
	minUSD := minSize.Mul(mid).StringFixed(2)
	// Sizes are quoted back in the unit the book is set to, so the numbers match the form.
	unit, minText := base, minSize.String()+" "+base+", about $"+minUSD
	if set.SizeUnit == SizeInQuote {
		unit, minText = QuoteUnit(quote), "about $"+minUSD
	}
	least := minSize.String()
	if set.SizeUnit == SizeInQuote {
		least = minSize.Mul(mid).Ceil().String()
	}
	if p.QuoteSize.LessThan(minSize) {
		return fmt.Sprintf("quoteSize %s %s is under one minimum order (%s) at this price; raise it to at least %s", set.QuoteSize, unit, minText, least)
	}
	if p.MaxPosition.IsPositive() {
		if p.MaxPosition.LessThan(minSize) {
			return fmt.Sprintf("max position change %s %s is less than one minimum order (%s) at this price, so no level fits under it; raise it to at least %s", set.MaxPosition, unit, minText, least)
		}
		room := p.MaxPosition.Sub(e.pos.qty)
		if side == Sell {
			room = p.MaxPosition.Add(e.pos.qty)
		}
		if room.LessThan(minSize) {
			return fmt.Sprintf("the max position change is reached (%s %s bought minus sold since %s, limit ±%s %s); reset the position to count from here", e.pos.qty, base, e.since.Local().Format("Jan 2 15:04"), set.MaxPosition, unit)
		}
	}
	if side == Buy && e.budgetQuote.LessThan(minSize.Mul(mid)) {
		return fmt.Sprintf("the bids may hold %s %s, under one minimum order (about $%s); add %s or raise maxQuoteAlloc", e.budgetQuote.StringFixed(2), QuoteUnit(quote), minUSD, quote)
	}
	if side == Sell && e.budgetBase.LessThan(minSize) {
		return fmt.Sprintf("the asks may hold %s %s, under one minimum order (%s %s); add %s or raise the base allocation", e.budgetBase, base, minSize, base, base)
	}
	return "no level fits the size, max position change and budget"
}

// Summary is one line per book for the book list.
type Summary struct {
	Market    Market           `json:"market"`
	Enabled   bool             `json:"enabled"`
	State     string           `json:"state"`
	Reason    string           `json:"reason,omitempty"`
	Reference *decimal.Decimal `json:"reference"`
	Position  decimal.Decimal  `json:"position"`
	// AvgCost and PositionSince explain the open PnL: (reference − avg cost) × position, counting
	// the book's own fills since PositionSince.
	AvgCost       decimal.Decimal `json:"avgCost"`
	PositionSince time.Time       `json:"positionSince"`
	RealizedPnl   decimal.Decimal `json:"realizedPnl"`
	UnrealizedPnl decimal.Decimal `json:"unrealizedPnl"`
	Orders        int             `json:"orders"`
	Fills         int             `json:"fills"`
	HeldBase      decimal.Decimal `json:"heldBase"`
	HeldQuote     decimal.Decimal `json:"heldQuote"`
	BudgetBase    decimal.Decimal `json:"budgetBase"`
	BudgetQuote   decimal.Decimal `json:"budgetQuote"`
	MaxQuoteAlloc decimal.Decimal `json:"maxQuoteAlloc"`
	MaxBaseAlloc  decimal.Decimal `json:"maxBaseAlloc"`
	VolumeQuote   decimal.Decimal `json:"volumeQuote"`
	Stats         Stats           `json:"stats"`
	BaseCapped    bool            `json:"-"`
}

func (e *Engine) Summary() Summary {
	s := e.Status()
	out := Summary{
		Market: s.Market, Enabled: s.Enabled, State: s.State, Reason: s.Reason,
		Position: s.Position.Qty, AvgCost: s.Position.AvgCost, PositionSince: s.Position.Since,
		RealizedPnl: s.Position.RealizedPnl, UnrealizedPnl: s.Position.UnrealizedPnl,
		Orders: len(s.Orders), Fills: s.Stats.Fills, HeldBase: s.Balances.HeldBase, HeldQuote: s.Balances.HeldQuote,
		BudgetBase: s.Balances.BudgetBase, BudgetQuote: s.Balances.BudgetQuote,
		MaxQuoteAlloc: s.Params.MaxQuoteAlloc, MaxBaseAlloc: s.Params.MaxBaseAlloc,
		BaseCapped:  s.Params.MaxBaseAlloc.IsPositive(),
		VolumeQuote: s.Position.VolumeQuote, Stats: s.Stats,
	}
	if s.Reference != nil {
		m := s.Reference.Mid
		out.Reference = &m
	}
	return out
}
