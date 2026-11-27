package quoter

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// fakeExchange answers every request with the drop copy a real exchange would send, on its own
// goroutine, the way the WebSocket would. It holds funds per order and rejects any request that
// needs more than is free, like the exchange, so a test can tell if two books overspend.
type fakeExchange struct {
	mu       sync.Mutex
	desk     *Desk
	orders   map[string]*fakeOrder // by root external id
	balances map[string]decimal.Decimal
	log      []string
	// ext is other people's best bid and ask (price, qty), which a take fills against.
	extBid, extBidQty, extAsk, extAskQty decimal.Decimal
	// tradeFills is what GET /orders/trade lists: the account's fills with their fees.
	tradeFills []tm.TradeFill
}

func (f *fakeExchange) Trades(context.Context, int) ([]tm.TradeFill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]tm.TradeFill(nil), f.tradeFills...), nil
}

type fakeOrder struct {
	dc          tm.DropCopy
	base, quote string
}

func (o *fakeOrder) hold() (string, decimal.Decimal) {
	leaves := d(o.dc.LeavesQty)
	if o.dc.Side == "BUY" {
		return o.quote, leaves.Mul(d(o.dc.Price))
	}
	return o.base, leaves
}

func newFake(balances map[string]string) *fakeExchange {
	f := &fakeExchange{orders: map[string]*fakeOrder{}, balances: map[string]decimal.Decimal{}}
	for k, v := range balances {
		f.balances[k] = d(v)
	}
	return f
}

func (f *fakeExchange) freeLocked(asset string) decimal.Decimal {
	free := f.balances[asset]
	for _, o := range f.orders {
		if a, h := o.hold(); a == asset {
			free = free.Sub(h)
		}
	}
	return free
}

func (f *fakeExchange) send(dc tm.DropCopy) {
	raw, _ := json.Marshal(dc)
	go f.desk.OnDropCopy(tm.Message{Channel: "DROPCOPY", Update: "UPDATE", Data: raw})
}

// fakeBook is one book's order entry on the fake exchange.
type fakeBook struct {
	f *fakeExchange
	m Market
}

func (f *fakeExchange) transport(m Market) Transport { return &fakeBook{f: f, m: m} }

func (b *fakeBook) Name() string { return "fake" }
func (b *fakeBook) Ready() bool  { return true }

func (b *fakeBook) Create(_ context.Context, o *Order) (string, error) {
	f := b.f
	f.mu.Lock()
	defer f.mu.Unlock()
	n := &fakeOrder{base: b.m.BaseAssetID, quote: b.m.QuoteAssetID, dc: tm.DropCopy{
		ExternalID: o.ExternalID, OrderID: tm.Str("x" + o.ExternalID), InstrumentID: tm.Str(b.m.InstrumentID), Symbol: b.m.Symbol,
		Side: string(o.Side), Status: "ACTIVE", EventType: "NEW", Price: o.Price.String(), Quantity: o.Qty.String(),
		LeavesQty: o.Qty.String(), ExecutedQty: "0",
	}}
	if a, h := n.hold(); h.GreaterThan(f.freeLocked(a)) {
		f.log = append(f.log, "reject")
		return "", &tm.APIError{Status: 422, Message: "Insufficient balance"}
	}
	if o.Take {
		f.log = append(f.log, "take")
		px, avail := f.extAsk, f.extAskQty
		if o.Side == Sell {
			px, avail = f.extBid, f.extBidQty
		}
		crosses := px.IsPositive() && ((o.Side == Buy && !px.GreaterThan(o.Price)) || (o.Side == Sell && !px.LessThan(o.Price)))
		if qty := decimal.Min(o.Qty, avail); crosses && qty.IsPositive() {
			if o.Side == Buy {
				f.balances[n.base], f.balances[n.quote] = f.balances[n.base].Add(qty), f.balances[n.quote].Sub(qty.Mul(o.Price))
			} else {
				f.balances[n.base], f.balances[n.quote] = f.balances[n.base].Sub(qty), f.balances[n.quote].Add(qty.Mul(o.Price))
			}
			n.dc.Status, n.dc.EventType, n.dc.ExecutedQty, n.dc.LeavesQty, n.dc.TradePrice = "FILLED", "TRADE", qty.String(), "0", o.Price.String()
			if qty.LessThan(o.Qty) {
				n.dc.Status, n.dc.EventType = "CANCELED", "CANCELED" // the rest of the IOC
			}
		} else {
			n.dc.Status, n.dc.EventType, n.dc.LeavesQty = "CANCELED", "CANCELED", "0"
		}
		f.send(n.dc)
		return string(n.dc.OrderID), nil
	}
	f.log = append(f.log, "create")
	f.orders[o.ExternalID] = n
	f.send(n.dc)
	return string(n.dc.OrderID), nil
}

func (b *fakeBook) Modify(_ context.Context, ext, _, _ string, price, qty decimal.Decimal) error {
	f := b.f
	f.mu.Lock()
	defer f.mu.Unlock()
	o := f.orders[ext]
	next := *o
	next.dc.Price, next.dc.Quantity, next.dc.LeavesQty, next.dc.EventType = price.String(), qty.String(), qty.Sub(d(o.dc.ExecutedQty)).String(), "MODIFIED"
	a, newHold := next.hold()
	_, oldHold := o.hold()
	if newHold.Sub(oldHold).GreaterThan(f.freeLocked(a)) {
		f.log = append(f.log, "reject")
		o.dc.EventType, o.dc.Text = "REJECTED", "Insufficient balance"
		f.send(o.dc)
		return nil
	}
	f.log = append(f.log, "modify")
	*o = next
	f.send(o.dc)
	return nil
}

func (b *fakeBook) Cancel(_ context.Context, ext, _, _ string) error {
	f := b.f
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, "cancel")
	o := f.orders[ext]
	if o == nil {
		return nil
	}
	o.dc.Status, o.dc.EventType, o.dc.LeavesQty = "CANCELED", "CANCELED", "0"
	delete(f.orders, ext)
	f.send(o.dc)
	return nil
}

// fill fully fills the first resting order on a side of a book.
func (f *fakeExchange) fill(symbol string, side Side) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, o := range f.orders {
		if o.dc.Symbol != symbol || o.dc.Side != string(side) {
			continue
		}
		qty, price := d(o.dc.LeavesQty), d(o.dc.Price)
		if side == Buy {
			f.balances[o.base], f.balances[o.quote] = f.balances[o.base].Add(qty), f.balances[o.quote].Sub(qty.Mul(price))
		} else {
			f.balances[o.base], f.balances[o.quote] = f.balances[o.base].Sub(qty), f.balances[o.quote].Add(qty.Mul(price))
		}
		o.dc.Status, o.dc.EventType, o.dc.ExecutedQty, o.dc.LeavesQty, o.dc.TradePrice = "FILLED", "TRADE", o.dc.Quantity, "0", o.dc.Price
		delete(f.orders, id)
		f.send(o.dc)
		return
	}
}

func (f *fakeExchange) counts() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]int{}
	for _, k := range f.log {
		out[k]++
	}
	return out
}

func (f *fakeExchange) resting(symbol string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, o := range f.orders {
		if symbol == "" || o.dc.Symbol == symbol {
			n++
		}
	}
	return n
}

func (f *fakeExchange) held(asset string) decimal.Decimal {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.balances[asset].Sub(f.freeLocked(asset))
}

func (f *fakeExchange) Balances(context.Context) (*tm.Balances, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := &tm.Balances{}
	for asset, total := range f.balances {
		b.Balances = append(b.Balances, struct {
			AssetID      tm.Str `json:"asset_id"`
			Balance      string `json:"balance"`
			Unsettled    string `json:"unsettled"`
			OrderHold    string `json:"order_hold"`
			TransferHold string `json:"transfer_hold"`
		}{AssetID: tm.Str(asset), Balance: total.String(), OrderHold: total.Sub(f.freeLocked(asset)).String()})
	}
	return b, nil
}

func (f *fakeExchange) ActiveOrders(context.Context) ([]tm.RestOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []tm.RestOrder
	for _, o := range f.orders {
		var r tm.RestOrder
		r.ID, r.ExternalID, r.Status = o.dc.OrderID, o.dc.ExternalID, "ACTIVE"
		r.OrderInfo.InstrumentID, r.OrderInfo.Price, r.OrderInfo.Qty, r.OrderInfo.Side = o.dc.InstrumentID, o.dc.Price, o.dc.Quantity, o.dc.Side
		r.LeavesQty, r.ExecutedQty = o.dc.LeavesQty, o.dc.ExecutedQty
		out = append(out, r)
	}
	return out, nil
}

var testCatalog = []Listing{
	{Symbol: "BTC-USDC", InstrumentID: "7", BaseAssetID: "btc", QuoteAssetID: "usdc", BaseSymbol: "BTC", QuoteSymbol: "USDC", Reference: "BTC-USD"},
	{Symbol: "ETH-USDC", InstrumentID: "8", BaseAssetID: "eth", QuoteAssetID: "usdc", BaseSymbol: "ETH", QuoteSymbol: "USDC", Reference: "ETH-USD"},
}

// startDesk runs a desk on the fake exchange with every shared connection up.
func startDesk(t *testing.T, fx *fakeExchange) *Desk {
	t.Helper()
	desk := NewDesk(DeskConfig{
		Mode: "paper", Environment: "test", IDPrefix: "cq", Defaults: testParams(), Catalog: testCatalog,
		Venue: fx, NewTransport: fx.transport, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	fx.desk = desk
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go desk.Run(ctx)
	for _, c := range []string{ConnDropCopy, ConnMarket, ConnReference} {
		desk.SetConn(c, true, "")
	}
	return desk
}

func addBook(t *testing.T, desk *Desk, symbol string, p Params) *Engine {
	t.Helper()
	if _, err := desk.Add(context.Background(), symbol, nil, &p, false); err != nil {
		t.Fatal(err)
	}
	e := desk.Engine(symbol)
	// The fake exchange sends no EBBO; an empty book is fine to quote into.
	e.mu.Lock()
	e.ebboAt = time.Now()
	e.mu.Unlock()
	return e
}

func tick(desk *Desk, product, mid string) {
	m := d(mid)
	desk.OnTick(reference.Tick{Reference: product, Mid: m, Bid: m.Sub(one), Ask: m.Add(one), Time: time.Now(), Seen: time.Now()})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func settled(e *Engine) bool { return len(e.book.Stuck(0)) == 0 }

func TestEngineQuotesWithModifies(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.MaxPosition, p.SkewBps = d("0.01"), 10
	e := addBook(t, desk, "BTC-USDC", p)
	tick(desk, "BTC-USD", "50000")

	// Stopped: a ladder is shown, nothing is sent.
	waitFor(t, "preview ladder", func() bool { return len(e.Status().Targets) == 6 })
	if fx.resting("") != 0 || e.Status().State != "stopped" {
		t.Fatal("sent orders while stopped")
	}

	e.SetEnabled(true)
	waitFor(t, "six resting orders", func() bool { return fx.resting("") == 6 && e.book.Len() == 6 && settled(e) })

	// The reference moves 10bps: every order is modified in place; nothing is canceled or re-created.
	tick(desk, "BTC-USD", "50050")
	waitFor(t, "modifies", func() bool { return fx.counts()["modify"] == 6 && settled(e) })
	if c := fx.counts(); c["cancel"] != 0 || c["create"] != 6 {
		t.Fatalf("expected modifies only, got %v", c)
	}
	for _, o := range e.book.Snapshot() {
		if o.Side == Buy && o.Level == 0 && !o.Price.Equal(d("49999.9")) {
			t.Fatalf("bid L0 at %s", o.Price)
		}
	}

	// A bid fills: we are long, the level is replaced, and the skew lowers the mid.
	fx.fill("BTC-USDC", Buy)
	waitFor(t, "fill applied and level replaced", func() bool {
		s := e.Status()
		return s.Position.Qty.Equal(d("0.001")) && fx.resting("") == 6 && settled(e)
	})
	if s := e.Status(); s.SkewBps != 1 || s.Stats.Fills != 1 {
		t.Fatalf("skew %v fills %d", s.SkewBps, s.Stats.Fills)
	}

	// A parameter change applies on the next cycle.
	if _, err := desk.UpdateParams("BTC-USDC", []byte(`{"levels": 1}`)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "ladder shrinks to one level", func() bool { return fx.resting("") == 2 })

	// Stopping pulls everything.
	e.SetEnabled(false)
	waitFor(t, "quotes pulled", func() bool { return fx.resting("") == 0 && e.book.Len() == 0 })

	// A stale reference also pulls quotes.
	e.SetEnabled(true)
	waitFor(t, "requoted", func() bool { return fx.resting("") == 2 })
	old := time.Now().Add(-time.Minute)
	desk.OnTick(reference.Tick{Reference: "BTC-USD", Mid: d("50050"), Time: old, Seen: old})
	waitFor(t, "pulled on stale reference", func() bool { return fx.resting("") == 0 })
	if s := e.Status(); s.State != "waiting" {
		t.Fatalf("state %s reason %s", s.State, s.Reason)
	}
	if fx.counts()["reject"] != 0 {
		t.Fatalf("rejects: %v", fx.counts())
	}
	// The desk adds the book up, and the journal has the fill.
	ds := desk.Status()
	if len(ds.Totals) != 1 || ds.Totals[0].Stats.Fills != 1 || !ds.Totals[0].VolumeQuote.IsPositive() || ds.Trades.Trades != 1 {
		t.Fatalf("totals %+v trades %+v", ds.Totals, ds.Trades)
	}
	if tr := desk.Trades(10); len(tr.Trades) != 1 || tr.Trades[0].Kind != "maker" || tr.Trades[0].Side != Buy {
		t.Fatalf("trades %+v", tr.Trades)
	}
}

// Two books on one quote asset, with enough USDC for about one of their bid ladders. Separate
// quoters would each size against the whole balance, and the exchange would reject whichever
// orders arrived second. The shared ledger hands each dollar out once: no request is rejected,
// and together the books never hold more than there is.
func TestBooksShareOneBalance(t *testing.T) {
	fx := newFake(map[string]string{"btc": "0", "eth": "0", "usdc": "160"})
	desk := startDesk(t, fx)
	p := testParams()
	p.Levels, p.QuoteSize = 3, d("0.001") // BTC bids: ~$50 a level, $150 for the ladder
	btc := addBook(t, desk, "BTC-USDC", p)
	p.QuoteSize = d("0.02") // ETH bids: ~$50 a level
	eth := addBook(t, desk, "ETH-USDC", p)
	tick(desk, "BTC-USD", "50000")
	tick(desk, "ETH-USD", "2500")
	waitFor(t, "both previews", func() bool { return len(btc.Status().Targets) > 0 && len(eth.Status().Targets) > 0 })

	desk.SetEnabled(true)
	waitFor(t, "both books quoting", func() bool {
		return fx.resting("BTC-USDC") > 0 && fx.resting("ETH-USDC") > 0 && settled(btc) && settled(eth)
	})
	// Keep both books moving so they keep competing for the same dollars.
	for i := 0; i < 20; i++ {
		tick(desk, "BTC-USD", decimal.NewFromInt(int64(50000+i*7)).String())
		tick(desk, "ETH-USD", decimal.NewFromInt(int64(2500-i)).String())
		time.Sleep(15 * time.Millisecond)
		if held := fx.held("usdc"); held.GreaterThan(d("160")) {
			t.Fatalf("books hold %s USDC of 160", held)
		}
	}
	waitFor(t, "settled", func() bool { return settled(btc) && settled(eth) })
	if c := fx.counts(); c["reject"] != 0 {
		t.Fatalf("the exchange rejected requests: %v", c)
	}
	// An allocation is a hard cap for one book, whatever is free.
	if _, err := desk.UpdateParams("ETH-USDC", []byte(`{"maxQuoteAlloc": "50"}`)); err != nil {
		t.Fatal(err)
	}
	tick(desk, "ETH-USD", "2490")
	waitFor(t, "ETH within its allocation", func() bool {
		buy, _ := eth.book.Holds()
		return settled(eth) && buy.LessThanOrEqual(d("50"))
	})
	if s := desk.Status(); len(s.Warnings) == 0 {
		t.Fatal("expected a warning that BTC-USDC shares USDC with no allocation")
	}

	// A stopped book with nothing resting can be removed; a running one can't.
	if err := desk.Remove("ETH-USDC"); err == nil {
		t.Fatal("removed a running book")
	}
	eth.SetEnabled(false)
	waitFor(t, "ETH pulled", func() bool { return eth.book.Len() == 0 })
	if err := desk.Remove("ETH-USDC"); err != nil {
		t.Fatal(err)
	}
	if desk.Engine("ETH-USDC") != nil || len(desk.Status().Books) != 1 {
		t.Fatal("ETH-USDC still listed")
	}
}

// A book sized in the quote currency keeps its dollar sizes as the price moves: the asks' cap
// holds at $200, and each level stays about $50.
func TestSizesInQuoteFollowThePrice(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.SizeUnit, p.QuoteSize, p.MaxBaseAlloc = SizeInQuote, d("50"), d("200") // 0.001 BTC a level at 50,000
	e := addBook(t, desk, "BTC-USDC", p)
	tick(desk, "BTC-USD", "50000")
	e.SetEnabled(true)
	waitFor(t, "quoting", func() bool { return fx.resting("") > 0 && settled(e) })
	for _, mid := range []string{"50000", "80000"} {
		tick(desk, "BTC-USD", mid)
		waitFor(t, "settled at "+mid, func() bool { return settled(e) && len(e.Status().Targets) > 0 })
		time.Sleep(50 * time.Millisecond)
		_, sell := e.book.Holds()
		if usd := sell.Mul(d(mid)); usd.GreaterThan(d("200")) {
			t.Fatalf("asks hold $%s at %s, over the $200 cap", usd, mid)
		}
	}
	// At 80,000, $50 is 0.000625 BTC, rounded down to the lot (0.0001 at this price): 0.0006.
	for _, tg := range e.Status().Targets {
		if tg.Level == 0 && !tg.Qty.Equal(d("0.0006")) {
			t.Fatalf("level 0 %s at 80,000, want 0.0006 ($50)", tg.Qty)
		}
	}
}

func TestLedgerReserve(t *testing.T) {
	l := NewLedger()
	a, b := NewBook("cq", "1"), NewBook("cq", "2")
	l.Register(a, "btc", "usdc")
	l.Register(b, "eth", "usdc")
	bal := &tm.Balances{}
	bal.Balances = append(bal.Balances, struct {
		AssetID      tm.Str `json:"asset_id"`
		Balance      string `json:"balance"`
		Unsettled    string `json:"unsettled"`
		OrderHold    string `json:"order_hold"`
		TransferHold string `json:"transfer_hold"`
	}{AssetID: "usdc", Balance: "1000", OrderHold: "100"}) // 100 held by an order that isn't ours
	l.OnBalances(bal)
	if !l.Free("usdc").Equal(d("900")) {
		t.Fatalf("free %s", l.Free("usdc"))
	}
	// Book a takes 600; book b sees only what's left.
	l.Reserve(a, "usdc", decimal.Zero, func(room decimal.Decimal) {
		if !room.Equal(d("900")) {
			t.Fatalf("room %s", room)
		}
		a.BeginCreate(Buy, 0, d("100"), d("6"))
	})
	l.Reserve(b, "usdc", decimal.Zero, func(room decimal.Decimal) {
		if !room.Equal(d("300")) {
			t.Fatalf("room for b %s", room)
		}
	})
	// An allocation caps what a book may hold in total.
	l.Reserve(a, "usdc", d("650"), func(room decimal.Decimal) {
		if !room.Equal(d("50")) {
			t.Fatalf("room within allocation %s", room)
		}
	})
	// A fill spends from the balance and shrinks the hold at once: free doesn't move.
	o := a.Snapshot()[0]
	a.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "1", Status: "ACTIVE", EventType: "NEW", Price: "100", Quantity: "6", LeavesQty: "6", ExecutedQty: "0"})
	a.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "1", Status: "ACTIVE", EventType: "TRADE", Price: "100", Quantity: "6", LeavesQty: "4", ExecutedQty: "2", TradeQty: "2", TradePrice: "100"})
	l.Debit("usdc", d("200"))
	if !l.Free("usdc").Equal(d("300")) {
		t.Fatalf("free after fill %s", l.Free("usdc"))
	}
}

func ebbo(desk *Desk, symbol, bid, bidQty, ask, askQty string) {
	raw, _ := json.Marshal(map[string]any{"symbol": symbol, "info": map[string]any{
		"best_bid": map[string]string{"price": bid, "qty": bidQty},
		"best_ask": map[string]string{"price": ask, "qty": askQty},
	}})
	desk.OnMarket(tm.Message{Channel: "EBBO", Data: raw})
}

// A long book whose bids filled, then a buyer far above fair value: the profit taker sells into
// that bid with an IOC and the position comes back toward flat, without touching our own asks.
func TestProfitTakerGetsALongBookOut(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.MaxPosition, p.ProfitTaker, p.TakeEdgeBps, p.TakeFlattenFloorBps, p.TakeMaxSize = d("0.004"), true, 25, 2, d("0.01")
	e := addBook(t, desk, "BTC-USDC", p)
	ebbo(desk, "BTC-USDC", "49990", "1", "50010", "1")
	tick(desk, "BTC-USD", "50000")
	e.SetEnabled(true)
	waitFor(t, "quoting", func() bool { return fx.resting("") == 6 && settled(e) })

	// Two bids fill: long 0.002, bought just under 50,000.
	fx.fill("BTC-USDC", Buy)
	waitFor(t, "first fill", func() bool { return e.Status().Position.Qty.Equal(d("0.001")) && settled(e) })
	fx.fill("BTC-USDC", Buy)
	waitFor(t, "long 0.002", func() bool { return e.Status().Position.Qty.Equal(d("0.002")) && settled(e) })
	if fx.counts()["take"] != 0 {
		t.Fatal("took with no edge on offer")
	}

	// Someone bids 50,100 for 0.0015 BTC: 20 bps over fair, well past the 13.5 bps a half-full
	// book needs. The profit taker sells 0.0015 into it.
	fx.mu.Lock()
	fx.extBid, fx.extBidQty = d("50100"), d("0.0015")
	fx.mu.Unlock()
	ebbo(desk, "BTC-USDC", "50100", "0.0015", "50110", "1")
	deadline := time.Now().Add(3 * time.Second)
	for !(fx.counts()["take"] == 1 && e.Status().Position.Qty.Equal(d("0.0005"))) {
		if time.Now().After(deadline) {
			st := e.Status()
			t.Fatalf("no profit take: counts %v position %s avg %s events %v", fx.counts(), st.Position.Qty, st.Position.AvgCost, st.Events[max(0, len(st.Events)-6):])
		}
		time.Sleep(10 * time.Millisecond)
	}
	s := e.Status()
	if s.Stats.Takes != 1 || s.Stats.TakeFills != 1 || !s.Position.RealizedPnl.IsPositive() {
		t.Fatalf("takes %d fills %d realized %s", s.Stats.Takes, s.Stats.TakeFills, s.Position.RealizedPnl)
	}
	// The cool-down holds the next one off even though the bid is still there.
	if fx.counts()["take"] != 1 {
		t.Fatalf("took again inside the cool-down: %v", fx.counts())
	}
}

// When our own asks hold every coin we have, an unfunded profit take pulls the outermost ask to
// free some; the take itself goes out on a later cycle, once the cancel lands.
func TestUnfundedProfitTakePullsTheOutermostQuote(t *testing.T) {
	fx := newFake(map[string]string{"btc": "0.003", "usdc": "100000"})
	desk := startDesk(t, fx)
	e := addBook(t, desk, "BTC-USDC", testParams())
	tick(desk, "BTC-USD", "50000")
	e.SetEnabled(true)
	waitFor(t, "quoting", func() bool { return fx.resting("") == 6 && settled(e) })
	e.SetEnabled(false) // hold the loop still: nothing else should send
	waitFor(t, "stopped", func() bool { return fx.resting("") == 0 && settled(e) })
	e.SetEnabled(true)
	waitFor(t, "quoting again", func() bool { return fx.resting("") == 6 && settled(e) })
	var outer string
	for _, o := range e.book.Snapshot() {
		if o.Side == Sell && o.Level == 2 {
			outer = o.ExternalID
		}
	}
	e.executeTake(context.Background(), &takeDecision{Kind: ProfitTake, Side: Sell, Price: d("50100"), Unfunded: true}, e.book.Snapshot())
	// That ask is canceled. (The ladder then places a new L2, which is fine: the take runs first
	// on the next cycle and reserves the freed coins before the ladder can.)
	waitFor(t, "the outermost ask pulled", func() bool { _, ok := e.book.Get(outer); return !ok })
}
