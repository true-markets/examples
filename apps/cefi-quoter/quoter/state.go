package quoter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// State is what the quoter carries across a restart: each book's position and PnL, its activity
// counts and recent events, the trade journal, and the orders each book had resting. The desk
// saves it every couple of seconds when it changes, and once more on shutdown; the next start
// picks up where this one left off.
//
// A clean shutdown pulls every quote first, so nothing can fill while the quoter is down. A crash
// can leave quotes resting, and those can fill before the next start cancels them. The orders in
// the state say what was resting and how much of each had filled; on the next start the exchange's
// order history says how much has filled since, and that difference goes into the position (see
// RecoverMissedFills).
//
// Settings live in the books file, not here. The state belongs to one account on one environment.
type State struct {
	Version     int                  `json:"version"`
	Mode        string               `json:"mode"`
	Environment string               `json:"environment"`
	ClientID    string               `json:"clientId"`
	SavedAt     time.Time            `json:"savedAt"`
	Books       map[string]BookState `json:"books"`
	Journal     JournalState         `json:"journal"`
}

const stateVersion = 1

// BookState is one book's part of the state.
type BookState struct {
	// Since is when the position started counting: the book's first start, or its last reset. The
	// max position change is measured from here.
	Since    time.Time     `json:"since"`
	Position PositionState `json:"position"`
	Stats    Stats         `json:"stats"`
	Events   []Event       `json:"events"`
	Orders   []OrderState  `json:"orders"` // resting when the state was saved
}

type PositionState struct {
	Qty         decimal.Decimal `json:"qty"`
	AvgCost     decimal.Decimal `json:"avgCost"`
	RealizedPnl decimal.Decimal `json:"realizedPnl"`
	VolumeBase  decimal.Decimal `json:"volumeBase"`
	VolumeQuote decimal.Decimal `json:"volumeQuote"`
}

// OrderState is an order that was resting, and how much of it had filled.
type OrderState struct {
	ExternalID string          `json:"externalId"`
	OrderID    string          `json:"orderId,omitempty"`
	Side       Side            `json:"side"`
	Level      int             `json:"level"`
	TakeKind   TakeKind        `json:"takeKind,omitempty"`
	Price      decimal.Decimal `json:"price"`
	Executed   decimal.Decimal `json:"executed"`
}

// JournalState is the trade journal.
type JournalState struct {
	NextID int     `json:"nextId"`
	Trades []Trade `json:"trades"`
}

const (
	savedEvents = 50
	stateEvery  = 2 * time.Second // how often the desk writes the state, when it changed
)

// --- engine ----------------------------------------------------------------------------------

func (e *Engine) saveState() BookState {
	orders := e.book.Snapshot()
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.pos
	s := BookState{
		Since:    e.since,
		Position: PositionState{Qty: p.qty, AvgCost: p.avgCost, RealizedPnl: p.realized, VolumeBase: p.volBase, VolumeQuote: p.volQuote},
		Stats:    e.stats,
		Events:   append([]Event{}, e.events[max(0, len(e.events)-savedEvents):]...),
		Orders:   []OrderState{},
	}
	for _, o := range orders {
		price := o.Price
		if o.PendingPrice != nil {
			price = *o.PendingPrice
		}
		s.Orders = append(s.Orders, OrderState{ExternalID: o.ExternalID, OrderID: o.OrderID, Side: o.Side, Level: o.Level, TakeKind: o.TakeKind, Price: price, Executed: o.Executed})
	}
	return s
}

func (e *Engine) restoreState(s BookState, savedAt time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := s.Position
	e.pos = position{qty: p.Qty, avgCost: p.AvgCost, realized: p.RealizedPnl, volBase: p.VolumeBase, volQuote: p.VolumeQuote}
	e.stats = s.Stats
	if !s.Since.IsZero() {
		e.since = s.Since
	}
	e.events = append(s.Events, e.events...)
	e.eventLocked("info", fmt.Sprintf("restored from the state saved %s: position %s %s, realized PnL %s %s",
		savedAt.Local().Format("Jan 2 15:04:05"), p.Qty, e.market.BaseSymbol, p.RealizedPnl.StringFixed(2), QuoteUnit(e.market.QuoteSymbol)))
}

// ResetPosition starts the book's position, PnL, volume and activity counts again from zero, as
// if the quoter had just started. The max position change is measured from here on.
func (e *Engine) ResetPosition() {
	e.mu.Lock()
	was := e.pos.qty
	e.pos, e.stats, e.since = position{}, Stats{}, time.Now()
	e.eventLocked("info", fmt.Sprintf("position reset (was %s %s): counting from zero again", was, e.market.BaseSymbol))
	e.mu.Unlock()
	e.Nudge()
}

// ResetRejects starts the book's reject, error and rate-limit counts again from zero. Everything
// else (position, PnL, requests, fills) keeps counting.
func (e *Engine) ResetRejects() {
	e.mu.Lock()
	e.stats.Rejects, e.stats.Errors, e.stats.RateLimited, e.stats.RateLimitPauses = 0, 0, 0, 0
	e.rejects = nil
	e.eventLocked("info", "reject, error and rate-limit counts reset")
	e.mu.Unlock()
}

// applyRecoveredFill counts a fill that happened while the quoter was down. The ledger isn't
// debited: the balances read at start already include it.
func (e *Engine) applyRecoveredFill(f Fill) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pos.apply(f.Side, f.Qty, f.Price)
	e.stats.Fills++
	if f.Level == TakeLevel {
		e.stats.TakeFills++
	}
	if e.journal != nil {
		e.journal.AddRecovered(e.market, f)
	}
	e.eventLocked("fill", fmt.Sprintf("%s %s %s @ %s (%s), filled while the quoter was down", f.Side, f.Qty, e.market.BaseSymbol, f.Price, levelName(f.Level)))
}

// --- desk ------------------------------------------------------------------------------------

// Restore hands the desk the state saved by the last run. Call it before adding the books: each
// book picks up its own part as it's added. A state from another account or environment is
// refused.
func (d *Desk) Restore(s *State) error {
	if s == nil {
		return nil
	}
	if s.Environment != d.cfg.Environment || (s.ClientID != "" && d.cfg.ClientID != "" && s.ClientID != d.cfg.ClientID) {
		return fmt.Errorf("the state file is for %s client %s, not %s client %s", s.Environment, s.ClientID, d.cfg.Environment, d.cfg.ClientID)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.saved = s
	d.journal.Restore(s.Journal, time.Now())
	return nil
}

// restoreBookLocked gives a newly added book its saved state, if there is one.
func (d *Desk) restoreBookLocked(db *deskBook, symbol string) {
	if d.saved == nil {
		return
	}
	bs, ok := d.saved.Books[symbol]
	if !ok {
		return
	}
	delete(d.saved.Books, symbol)
	db.engine.restoreState(bs, d.saved.SavedAt)
	db.resting = bs.Orders
}

// State is everything worth carrying across a restart, now.
func (d *Desk) State() State {
	s := State{Version: stateVersion, Mode: d.cfg.Mode, Environment: d.cfg.Environment, ClientID: d.cfg.ClientID, Books: map[string]BookState{}}
	d.mu.Lock()
	books := map[string]*deskBook{}
	for sym, db := range d.books {
		books[sym] = db
	}
	// Saved books that couldn't be added this run (a reference that's gone, say) keep their state.
	if d.saved != nil {
		for sym, bs := range d.saved.Books {
			s.Books[sym] = bs
		}
	}
	d.mu.Unlock()
	for sym, db := range books {
		s.Books[sym] = db.engine.saveState()
	}
	s.Journal = d.journal.Snapshot()
	return s
}

// SaveState writes the state if it changed since the last write (or always, if force).
func (d *Desk) SaveState(force bool) {
	if d.cfg.SaveState == nil {
		return
	}
	s := d.State()
	raw, _ := json.Marshal(s) // SavedAt is still zero here, so an unchanged state compares equal
	d.mu.Lock()
	same := bytes.Equal(raw, d.lastState)
	d.mu.Unlock()
	if same && !force {
		return
	}
	s.SavedAt = time.Now()
	if err := d.cfg.SaveState(s); err != nil {
		d.log.Warn("saving the state failed", "err", err)
		return
	}
	d.mu.Lock()
	d.lastState = raw
	d.mu.Unlock()
}

// ResetPosition starts one book's position and PnL from zero.
func (d *Desk) ResetPosition(symbol string) error {
	e := d.Engine(symbol)
	if e == nil {
		return fmt.Errorf("%s isn't added", symbol)
	}
	e.ResetPosition()
	d.SaveState(false)
	return nil
}

// ResetRejects starts one book's reject counts from zero, or every book's when symbol is "" (which
// also forgets when the rate limit was last hit).
func (d *Desk) ResetRejects(symbol string) error {
	engines := d.engines()
	if symbol != "" {
		e := d.Engine(symbol)
		if e == nil {
			return fmt.Errorf("%s isn't added", symbol)
		}
		engines = []*Engine{e}
	} else {
		d.pacer.Forget()
	}
	for _, e := range engines {
		e.ResetRejects()
	}
	d.SaveState(false)
	return nil
}

// OrderHistory is the exchange's record of recent orders, finished ones included.
type OrderHistory interface {
	RecentOrders(ctx context.Context) ([]tm.RestOrder, error)
}

// RecoverMissedFills counts what filled while the quoter was down, on the orders the last run
// left resting (a crash, or a shutdown whose cancels weren't all confirmed). Call it after those
// orders are canceled and the books are added. It returns a line per finding, for the log.
//
// For each order, the exchange says how much has filled in all; the state says how much had
// filled when it was saved; the difference is a fill nobody counted. It's priced at the order's
// last price, which is what a resting post-only order trades at.
func (d *Desk) RecoverMissedFills(ctx context.Context, h OrderHistory) []string {
	d.mu.Lock()
	type pending struct {
		e      *Engine
		orders []OrderState
	}
	var work []pending
	for _, db := range d.books {
		if len(db.resting) > 0 {
			work = append(work, pending{db.engine, db.resting})
			db.resting = nil
		}
	}
	d.mu.Unlock()
	if len(work) == 0 {
		return nil
	}
	history, err := h.RecentOrders(ctx)
	if err != nil {
		return []string{"couldn't read the order history to check for fills while the quoter was down: " + err.Error()}
	}
	byID, byExt := map[string]tm.RestOrder{}, map[string]tm.RestOrder{}
	for _, o := range history {
		byID[string(o.ID)] = o
		byExt[o.ExternalID] = o
	}
	var out []string
	for _, w := range work {
		for _, o := range w.orders {
			ro, ok := byID[o.OrderID]
			if !ok || o.OrderID == "" {
				ro, ok = byExt[o.ExternalID]
			}
			if !ok {
				out = append(out, fmt.Sprintf("%s: order %s isn't in the recent order history; check whether it filled while the quoter was down", w.e.market.Symbol, o.ExternalID))
				continue
			}
			executed, err := decimal.NewFromString(ro.ExecutedQty)
			if err != nil {
				continue
			}
			missed := executed.Sub(o.Executed)
			if !missed.IsPositive() {
				continue
			}
			price := o.Price
			if p, _ := ro.CurrentTerms(); p != "" {
				if v, err := decimal.NewFromString(p); err == nil && v.IsPositive() {
					price = v
				}
			}
			w.e.applyRecoveredFill(Fill{Side: o.Side, Qty: missed, Price: price, Level: o.Level, TakeKind: o.TakeKind, Time: time.Now()})
			out = append(out, fmt.Sprintf("%s: %s %s @ %s filled while the quoter was down; counted in the position", w.e.market.Symbol, o.Side, missed, price))
		}
	}
	return out
}
