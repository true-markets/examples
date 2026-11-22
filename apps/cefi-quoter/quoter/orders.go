package quoter

import (
	"crypto/rand"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

type Side string

const (
	Buy  Side = "BUY"
	Sell Side = "SELL"
)

// Action is what we last asked the exchange to do to an order and haven't heard back about.
type Action string

const (
	None   Action = ""
	Create Action = "create"
	Modify Action = "modify"
	Cancel Action = "cancel"
)

// Order is one of our resting orders, as we know it.
//
// The rule that keeps this simple: at most one request per order is in flight. While InFlight is
// set we send nothing else for that order and wait for the drop copy to answer. That costs one
// round trip of reaction time in a fast market and buys a state machine with no ambiguity about
// which answer belongs to which request.
type Order struct {
	ExternalID string // our id for the order (its first ClOrdID); the key everywhere
	OrderID    string // the exchange's id, once we've heard it
	Side       Side
	Level      int

	Price    decimal.Decimal // what the exchange has confirmed
	Qty      decimal.Decimal // the order's total quantity, filled part included
	Leaves   decimal.Decimal // still resting
	Executed decimal.Decimal // filled so far

	// The modify in flight, if any. Prices and sizes for decisions use these while they're set.
	PendingPrice *decimal.Decimal
	PendingQty   *decimal.Decimal

	InFlight Action
	SentAt   time.Time

	// FIX only: every replace gets a new ClOrdID chained to the previous one. clOrdID is the
	// head of that chain (what the next replace or cancel must point at).
	clOrdID string
}

// EffectivePrice is the price the order rests at, or will once its modify lands.
func (o *Order) EffectivePrice() decimal.Decimal {
	if o.PendingPrice != nil {
		return *o.PendingPrice
	}
	return o.Price
}

// EffectiveLeaves is what the exchange holds funds against, counting a modify in flight.
func (o *Order) EffectiveLeaves() decimal.Decimal {
	if o.PendingQty != nil {
		return decimal.Max(o.PendingQty.Sub(o.Executed), decimal.Zero)
	}
	return decimal.Max(o.Leaves, decimal.Zero)
}

// Hold is what this order ties up: quote notional for a bid, base quantity for an ask.
func (o *Order) Hold() decimal.Decimal {
	if o.Side == Buy {
		return o.EffectivePrice().Mul(o.EffectiveLeaves())
	}
	return o.EffectiveLeaves()
}

// ReservedHold is what to count as held while a request is out: the larger of the hold the
// exchange has confirmed and the one a modify in flight asks for. Until the drop copy answers,
// either could be what the exchange holds.
func (o *Order) ReservedHold() decimal.Decimal {
	confirmed := decimal.Max(o.Leaves, decimal.Zero)
	if o.Side == Buy {
		confirmed = confirmed.Mul(o.Price)
	}
	return decimal.Max(confirmed, o.Hold())
}

// Status is the order's state in the exchange's words, for display.
func (o *Order) Status() string {
	switch o.InFlight {
	case Create:
		return "NEW_PENDING"
	case Modify:
		return "MODIFY_PENDING"
	case Cancel:
		return "CANCEL_PENDING"
	}
	return "ACTIVE"
}

// Fill is one execution of one of our orders.
type Fill struct {
	ExternalID string
	Side       Side
	Level      int
	Price      decimal.Decimal
	Qty        decimal.Decimal
	Time       time.Time
}

// DropCopyResult is what one drop copy changed, for the engine to act on.
type DropCopyResult struct {
	Fill   *Fill
	Reject string // set when an order or a request was rejected
	Level  int
	Side   Side
	Orphan string // an order with our prefix that we aren't tracking: cancel it
	Gone   bool   // the order left the book
}

// Book is every order this quoter is managing. Drop copies (on the WebSocket goroutine) and the
// quote loop both touch it, so every method locks.
type Book struct {
	mu           sync.Mutex
	prefix       string
	instrumentID string
	orders       map[string]*Order // by ExternalID
	chain        map[string]string // FIX: any ClOrdID in a replace chain -> ExternalID
	chainPrev    map[string]string // FIX: replace ClOrdID -> the ClOrdID it replaced
	deadLinks    map[string]bool   // FIX: replace ClOrdIDs the exchange rejected
}

func NewBook(prefix, instrumentID string) *Book {
	return &Book{
		prefix:       prefix,
		instrumentID: instrumentID,
		orders:       map[string]*Order{},
		chain:        map[string]string{},
		chainPrev:    map[string]string{},
		deadLinks:    map[string]bool{},
	}
}

// NewID makes a client order id: our prefix plus random characters, 18 characters in all (the
// exchange's limit). The prefix is how we recognize our own orders after a restart.
func (b *Book) NewID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	n := 18 - len(b.prefix)
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return b.prefix + string(buf)
}

// IsOurs reports whether an external id carries our prefix.
func (b *Book) IsOurs(externalID string) bool { return strings.HasPrefix(externalID, b.prefix) }

// Snapshot copies every order, sorted by side then level.
func (b *Book) Snapshot() []Order {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Order, 0, len(b.orders))
	for _, o := range b.orders {
		c := *o
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Side != out[j].Side {
			return out[i].Side == Buy
		}
		return out[i].Level < out[j].Level
	})
	return out
}

// Get copies one order.
func (b *Book) Get(externalID string) (Order, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.orders[externalID]
	if o == nil {
		return Order{}, false
	}
	return *o, true
}

// Holds is what this book's orders hold: quote for the bids, base for the asks.
func (b *Book) Holds() (buy, sell decimal.Decimal) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, o := range b.orders {
		if o.Side == Buy {
			buy = buy.Add(o.ReservedHold())
		} else {
			sell = sell.Add(o.ReservedHold())
		}
	}
	return buy, sell
}

// Knows reports whether a FIX ClOrdID belongs to one of this book's orders.
func (b *Book) Knows(clOrdID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.chain[clOrdID]
	return ok
}

// InstrumentID is the instrument this book's orders are on.
func (b *Book) InstrumentID() string { return b.instrumentID }

func (b *Book) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.orders)
}

// --- before sending -----------------------------------------------------------------------
//
// Every request is recorded BEFORE it is sent. The drop copy for a request can arrive before the
// request's own HTTP response does (by a fraction of a millisecond), so state set after sending
// can overwrite an answer that already came in.

// BeginCreate registers a new order about to be sent.
func (b *Book) BeginCreate(side Side, level int, price, qty decimal.Decimal) *Order {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := &Order{
		ExternalID: b.newIDLocked(),
		Side:       side,
		Level:      level,
		Price:      price,
		Qty:        qty,
		Leaves:     qty,
		InFlight:   Create,
		SentAt:     time.Now(),
	}
	o.clOrdID = o.ExternalID
	b.orders[o.ExternalID] = o
	b.chain[o.ExternalID] = o.ExternalID
	c := *o
	return &c
}

func (b *Book) newIDLocked() string {
	for {
		id := b.NewID()
		if _, taken := b.orders[id]; !taken {
			return id
		}
	}
}

// BeginModify marks an order as modifying. It returns the FIX ClOrdIDs for the replace (REST
// ignores them), or ok=false if the order is gone or already busy.
func (b *Book) BeginModify(externalID string, price, qty decimal.Decimal) (newClOrdID, origClOrdID string, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.orders[externalID]
	if o == nil || o.InFlight != None {
		return "", "", false
	}
	o.PendingPrice, o.PendingQty = &price, &qty
	o.InFlight, o.SentAt = Modify, time.Now()
	newClOrdID = b.newIDLocked()
	origClOrdID = o.clOrdID
	b.chain[newClOrdID] = externalID
	b.chainPrev[newClOrdID] = origClOrdID
	// FIX chains each replace off the last one not rejected, so the head moves now, not on the ack.
	o.clOrdID = newClOrdID
	return newClOrdID, origClOrdID, true
}

// BeginCancel marks an order as canceling and returns the FIX ClOrdIDs for the cancel.
func (b *Book) BeginCancel(externalID string) (newClOrdID, origClOrdID string, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.orders[externalID]
	if o == nil || o.InFlight != None {
		return "", "", false
	}
	o.InFlight, o.SentAt = Cancel, time.Now()
	newClOrdID = b.newIDLocked()
	b.chain[newClOrdID] = externalID
	return newClOrdID, o.clOrdID, true
}

// SendFailed undoes a Begin* when the exchange definitely did not take the request (it answered
// with a rejection). If a drop copy already moved the order on, that answer stands.
func (b *Book) SendFailed(externalID string, action Action) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.orders[externalID]
	if o == nil || o.InFlight != action {
		return
	}
	switch action {
	case Create:
		b.removeLocked(o)
	case Modify:
		b.clearModifyLocked(o)
		o.InFlight = None
	case Cancel:
		o.InFlight = None
	}
}

// SetOrderID records the exchange's id from a create response.
func (b *Book) SetOrderID(externalID, orderID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if o := b.orders[externalID]; o != nil && o.OrderID == "" {
		o.OrderID = orderID
	}
}

// --- drop copy ----------------------------------------------------------------------------

// ApplyDropCopy folds one DROPCOPY message into the book. The drop copy is the only thing that
// moves an order out of a pending state: an HTTP 200 means the exchange received a request, the
// drop copy says what it did with it.
func (b *Book) ApplyDropCopy(d tm.DropCopy) DropCopyResult {
	b.mu.Lock()
	defer b.mu.Unlock()

	if d.InstrumentID != "" && string(d.InstrumentID) != b.instrumentID {
		return DropCopyResult{} // drop copy is account wide; another book's orders aren't ours
	}
	o := b.findLocked(d.ExternalID, string(d.OrderID))
	if o == nil {
		if b.IsOurs(d.ExternalID) && d.Status != "CANCELED" && d.Status != "FILLED" && d.Status != "REJECTED" {
			return DropCopyResult{Orphan: d.ExternalID}
		}
		return DropCopyResult{}
	}
	res := DropCopyResult{Side: o.Side, Level: o.Level}
	if d.OrderID != "" {
		o.OrderID = string(d.OrderID)
	}

	// A fill is the growth in executed_qty, not the trade_qty field: a repeated message (say,
	// after a reconnect) then can't count the same fill twice.
	if exec, err := decimal.NewFromString(d.ExecutedQty); err == nil && exec.GreaterThan(o.Executed) {
		qty := exec.Sub(o.Executed)
		price := firstDecimal(d.TradePrice, d.ExecutedVwap, d.Price)
		res.Fill = &Fill{ExternalID: o.ExternalID, Side: o.Side, Level: o.Level, Price: price, Qty: qty, Time: time.Now()}
		o.Executed = exec
	}
	if v, err := decimal.NewFromString(d.LeavesQty); err == nil {
		o.Leaves = v
	}

	switch d.EventType {
	case "NEW":
		if o.InFlight == Create {
			o.InFlight = None
		}
	case "TRADE":
		// A trade proves a create was accepted. It says nothing about a modify in flight.
		if o.InFlight == Create {
			o.InFlight = None
		}
	case "MODIFIED":
		b.clearModifyLocked(o)
		if o.InFlight == Modify {
			o.InFlight = None
		}
	case "REJECTED":
		res.Reject = d.Text
		if res.Reject == "" {
			res.Reject = "rejected"
		}
		switch o.InFlight {
		case Modify:
			// The modify was refused; the order rests on at its old terms. Unless it filled or was
			// canceled underneath the modify, in which case it is gone.
			b.clearModifyLocked(o)
			// FIX: the rejected replace's ClOrdID is dead. The message names it; if it doesn't, it
			// is the head (a FIX OrderCancelReject may already have walked the head back).
			if _, isReplace := b.chainPrev[d.ExternalID]; isReplace {
				b.deadLinks[d.ExternalID] = true
			} else if _, isReplace := b.chainPrev[o.clOrdID]; isReplace && !b.deadLinks[o.clOrdID] && d.ExternalID == "" {
				b.deadLinks[o.clOrdID] = true
			}
			b.walkBackLocked(o)
			o.InFlight = None
		case Cancel:
			o.InFlight = None
		default:
			b.removeLocked(o)
			res.Gone = true
			return res
		}
	}

	// The message carries the order's whole current state. Once nothing is in flight, the
	// exchange's price and quantity are the truth.
	if o.InFlight == None {
		if v, err := decimal.NewFromString(d.Price); err == nil && v.IsPositive() {
			o.Price = v
		}
		if v, err := decimal.NewFromString(d.Quantity); err == nil && v.IsPositive() {
			o.Qty = v
		}
	}

	if d.Status == "CANCELED" || d.Status == "FILLED" || d.Status == "REJECTED" || d.EventType == "CANCELED" ||
		(o.InFlight == None && d.LeavesQty != "" && !o.Leaves.IsPositive()) {
		b.removeLocked(o)
		res.Gone = true
	}
	return res
}

// CancelRejected handles a FIX OrderCancelReject (35=9). For a replace, the chain head walks back
// past the rejected ClOrdID. The drop copy still decides the order's state.
func (b *Book) CancelRejected(clOrdID, responseTo string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if responseTo != "2" {
		return
	}
	b.deadLinks[clOrdID] = true
	if o := b.orders[b.chain[clOrdID]]; o != nil {
		b.walkBackLocked(o)
	}
}

// walkBackLocked moves the FIX chain head back past every rejected replace. Two replaces in
// flight that both reject land the head on the original, whichever reject arrives first.
func (b *Book) walkBackLocked(o *Order) {
	for b.deadLinks[o.clOrdID] {
		prev, ok := b.chainPrev[o.clOrdID]
		if !ok {
			break
		}
		o.clOrdID = prev
	}
}

func (b *Book) clearModifyLocked(o *Order) {
	o.PendingPrice, o.PendingQty = nil, nil
}

func (b *Book) findLocked(externalID, orderID string) *Order {
	if externalID != "" {
		if root, ok := b.chain[externalID]; ok {
			if o := b.orders[root]; o != nil {
				return o
			}
		}
	}
	if orderID != "" {
		for _, o := range b.orders {
			if o.OrderID == orderID {
				return o
			}
		}
	}
	return nil
}

func (b *Book) removeLocked(o *Order) {
	delete(b.orders, o.ExternalID)
	for id, root := range b.chain {
		if root == o.ExternalID {
			delete(b.chain, id)
			delete(b.chainPrev, id)
			delete(b.deadLinks, id)
		}
	}
}

// --- resync -------------------------------------------------------------------------------

// Stuck lists orders whose request has gone unanswered for longer than d.
func (b *Book) Stuck(d time.Duration) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, o := range b.orders {
		if o.InFlight != None && time.Since(o.SentAt) > d {
			out = append(out, o.ExternalID)
		}
	}
	return out
}

// Resync replaces what we believe with what the exchange says is resting (GET /orders/active).
// Used after the drop copy reconnects and when a request goes unanswered: anything we track that
// isn't resting is gone, and anything resting with our prefix that we don't track is an orphan.
// Fills found here (executed grew while we weren't listening) are returned so position stays right.
func (b *Book) Resync(active []tm.RestOrder, graceFor time.Duration) (fills []Fill, orphans []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	seen := map[string]bool{}
	for _, r := range active {
		if string(r.OrderInfo.InstrumentID) != b.instrumentID || !b.IsOurs(r.ExternalID) {
			continue
		}
		o := b.findLocked(r.ExternalID, string(r.ID))
		if o == nil {
			orphans = append(orphans, r.ExternalID)
			continue
		}
		seen[o.ExternalID] = true
		o.OrderID = string(r.ID)
		price, qty := r.CurrentTerms()
		if exec, err := decimal.NewFromString(r.ExecutedQty); err == nil && exec.GreaterThan(o.Executed) {
			fills = append(fills, Fill{ExternalID: o.ExternalID, Side: o.Side, Level: o.Level, Price: o.Price, Qty: exec.Sub(o.Executed), Time: time.Now()})
			o.Executed = exec
		}
		if v, err := decimal.NewFromString(r.LeavesQty); err == nil {
			o.Leaves = v
		}
		// A request older than the grace period that the exchange's state doesn't show pending is
		// treated as answered; the order is as the exchange says.
		if o.InFlight != None && time.Since(o.SentAt) > graceFor {
			o.InFlight = None
			b.clearModifyLocked(o)
		}
		if o.InFlight == None {
			if v, err := decimal.NewFromString(price); err == nil && v.IsPositive() {
				o.Price = v
			}
			if v, err := decimal.NewFromString(qty); err == nil && v.IsPositive() {
				o.Qty = v
			}
		}
	}
	for _, o := range b.orders {
		if seen[o.ExternalID] {
			continue
		}
		// A create sent a moment ago may not show in the list yet.
		if o.InFlight == Create && time.Since(o.SentAt) < graceFor {
			continue
		}
		b.removeLocked(o)
	}
	return fills, orphans
}

func firstDecimal(values ...string) decimal.Decimal {
	for _, v := range values {
		if d, err := decimal.NewFromString(v); err == nil && d.IsPositive() {
			return d
		}
	}
	return decimal.Zero
}
