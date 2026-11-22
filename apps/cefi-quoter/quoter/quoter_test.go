package quoter

import (
	"strings"
	"testing"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }
func dp(s string) *decimal.Decimal {
	v := d(s)
	return &v
}

func testParams() Params {
	return Params{
		SizeUnit: SizeInBase, SpreadBps: 10, Levels: 3, LevelSpreadMult: 2, QuoteSize: d("0.001"), LevelSizeMult: 1,
		ModifyThresholdBps: 2, MaxPosition: d("0"), SkewBps: 0, RefStaleMs: 3000, MinRequoteMs: 0,
	}
}

func TestIncrements(t *testing.T) {
	p, q := FormatBid(d("100000.74"), d("0.0012345"))
	if !p.Equal(d("100000.5")) || !q.Equal(d("0.00123")) {
		t.Fatalf("bid %s x %s", p, q)
	}
	p, _ = FormatAsk(d("100000.01"), d("0.001"))
	if !p.Equal(d("100000.5")) {
		t.Fatalf("ask rounds up: %s", p)
	}
	// Under the $1 minimum notional: no order rather than a bigger one.
	if _, q := FormatBid(d("50000"), d("0.00001")); !q.IsZero() {
		t.Fatalf("sub-minimum size should be zero, got %s", q)
	}
}

func TestLadderLevelsAndSkew(t *testing.T) {
	p := testParams()
	l := BuildLadder(LadderInput{Reference: d("50000"), Params: p, BudgetQuote: d("1000000"), BudgetBase: d("100")})
	if len(l.Bids) != 3 || len(l.Asks) != 3 {
		t.Fatalf("levels: %d bids %d asks", len(l.Bids), len(l.Asks))
	}
	// 10, 20, 40 bps either side of 50000.
	for i, want := range []string{"49950", "49900", "49800"} {
		if !l.Bids[i].Price.Equal(d(want)) {
			t.Fatalf("bid L%d %s want %s", i, l.Bids[i].Price, want)
		}
	}
	if !l.Asks[2].Price.Equal(d("50200")) {
		t.Fatalf("ask L2 %s", l.Asks[2].Price)
	}

	// Long half the limit with 10bps of skew: the mid drops 5bps.
	p.MaxPosition, p.SkewBps = d("0.01"), 10
	l = BuildLadder(LadderInput{Reference: d("50000"), Params: p, Position: d("0.005"), BudgetQuote: d("1000000"), BudgetBase: d("100")})
	if l.SkewBps != 5 || !l.Mid.Equal(d("49975")) {
		t.Fatalf("skew %v mid %s", l.SkewBps, l.Mid)
	}
}

func TestLadderCaps(t *testing.T) {
	p := testParams()
	p.MaxPosition = d("0.0025")
	// Long 0.002: only 0.0005 more may be bought, and 0.0045 sold before the short limit.
	l := BuildLadder(LadderInput{Reference: d("50000"), Params: p, Position: d("0.002"), BudgetQuote: d("1000000"), BudgetBase: d("100")})
	if len(l.Bids) != 1 || !l.Bids[0].Qty.Equal(d("0.0005")) {
		t.Fatalf("bids capped by position: %+v", l.Bids)
	}
	if len(l.Asks) != 3 {
		t.Fatalf("asks: %+v", l.Asks)
	}

	// Budget: 120 USDC funds the first two bids at ~50 each, then the third gets what's left.
	p.MaxPosition = d("0")
	l = BuildLadder(LadderInput{Reference: d("50000"), Params: p, BudgetQuote: d("120"), BudgetBase: d("0")})
	if len(l.Bids) != 3 || !l.Bids[2].Qty.Equal(d("0.0004")) || len(l.Asks) != 0 {
		t.Fatalf("budget caps: bids %+v asks %+v", l.Bids, l.Asks)
	}
}

func resting(id string, side Side, level int, price, qty string) Order {
	return Order{ExternalID: id, Side: side, Level: level, Price: d(price), Qty: d(qty), Leaves: d(qty)}
}

func TestPlanModifiesInPlace(t *testing.T) {
	orders := []Order{
		resting("b0", Buy, 0, "49950", "0.001"),
		resting("a0", Sell, 0, "50050", "0.001"),
	}
	// The market moved up 10bps.
	bids := []Target{{Buy, 0, d("50000"), d("0.001")}}
	asks := []Target{{Sell, 0, d("50100"), d("0.001")}}
	steps := Plan(PlanInput{Bids: bids, Asks: asks, Orders: orders, ThresholdBps: 2})
	if len(steps) != 2 {
		t.Fatalf("want 2 modifies, got %+v", steps)
	}
	for _, s := range steps {
		if s.Kind != Modify {
			t.Fatalf("expected only modifies, got %+v", s)
		}
	}
	// The ask moves away from the spread and holds no more base; it goes before the bid, which
	// moves toward the spread and holds more quote.
	if steps[0].ExternalID != "a0" || steps[1].ExternalID != "b0" {
		t.Fatalf("order: %+v", steps)
	}
}

func TestPlanReleasesBeforeReserving(t *testing.T) {
	// Fully deployed bids. The ladder moves down and the inner level grows while the outer one
	// shrinks: the shrink must go first or the grow is rejected for insufficient balance.
	orders := []Order{
		resting("b0", Buy, 0, "100", "1"),
		resting("b1", Buy, 1, "99", "3"),
	}
	bids := []Target{{Buy, 0, d("100"), d("2")}, {Buy, 1, d("99"), d("2")}}
	steps := Plan(PlanInput{Bids: bids, Orders: orders, ThresholdBps: 1})
	if len(steps) != 2 || steps[0].ExternalID != "b1" || steps[1].ExternalID != "b0" {
		t.Fatalf("shrink before grow: %+v", steps)
	}
	if !steps[1].Qty.Equal(d("2")) {
		t.Fatalf("total qty %s", steps[1].Qty)
	}
}

func TestPlanThresholdPartialFillAndCancel(t *testing.T) {
	o := resting("b0", Buy, 0, "50000", "0.002")
	// Half filled: 0.001 rests. Target is still 0.002 resting, so the total goes to 0.003.
	o.Executed, o.Leaves = d("0.001"), d("0.001")
	extra := resting("b1", Buy, 1, "49000", "0.001")
	bids := []Target{{Buy, 0, d("50005"), d("0.002")}} // 1bp move: under the threshold
	steps := Plan(PlanInput{Bids: bids, Orders: []Order{o, extra}, ThresholdBps: 2})
	if len(steps) != 2 {
		t.Fatalf("%+v", steps)
	}
	if steps[0].Kind != Cancel || steps[0].ExternalID != "b1" {
		t.Fatalf("cancel first: %+v", steps[0])
	}
	if steps[1].Kind != Modify || !steps[1].Price.Equal(d("50000")) || !steps[1].Qty.Equal(d("0.003")) {
		t.Fatalf("top up at the same price: %+v", steps[1])
	}
}

func TestPlanClamps(t *testing.T) {
	// Our ask rests at 50010 (moving to 50005); the exchange's best ask is 50020. A bid targeted at
	// 50010 must stop one tick under 50005.
	ask := resting("a0", Sell, 0, "50010", "0.001")
	ask.PendingPrice = dp("50005")
	ask.InFlight = Modify
	bids := []Target{{Buy, 0, d("50010"), d("0.001")}}
	steps := Plan(PlanInput{Bids: bids, Orders: []Order{ask}, BestAsk: dp("50020"), ThresholdBps: 2})
	if len(steps) != 1 || steps[0].Kind != Create || !steps[0].Price.Equal(d("50004.9")) {
		t.Fatalf("%+v", steps)
	}
	// An order with a request out is never touched.
	bids = []Target{{Buy, 0, d("49000"), d("0.001")}}
	busy := resting("b0", Buy, 0, "48000", "0.001")
	busy.InFlight = Modify
	if steps := Plan(PlanInput{Bids: bids, Orders: []Order{busy}, ThresholdBps: 2}); len(steps) != 0 {
		t.Fatalf("busy order touched: %+v", steps)
	}
}

func TestBookLifecycle(t *testing.T) {
	b := NewBook("cq", "7")
	o := b.BeginCreate(Buy, 0, d("100"), d("2"))
	if len(o.ExternalID) != 18 || !b.IsOurs(o.ExternalID) {
		t.Fatalf("id %q", o.ExternalID)
	}
	b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, OrderID: "900", InstrumentID: "7", EventType: "NEW", Status: "ACTIVE", Price: "100", Quantity: "2", LeavesQty: "2", ExecutedQty: "0"})
	if b.Snapshot()[0].InFlight != None {
		t.Fatal("NEW should settle the create")
	}

	// Modify, then a fill lands while it's in flight, then the modify is confirmed.
	if _, _, ok := b.BeginModify(o.ExternalID, d("101"), d("2")); !ok {
		t.Fatal("modify refused")
	}
	if _, _, ok := b.BeginModify(o.ExternalID, d("102"), d("2")); ok {
		t.Fatal("a second request while one is in flight must be refused")
	}
	res := b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "TRADE", Status: "MODIFY_PENDING", Price: "100", Quantity: "2", LeavesQty: "1.5", ExecutedQty: "0.5", TradePrice: "100", TradeQty: "0.5"})
	if res.Fill == nil || !res.Fill.Qty.Equal(d("0.5")) {
		t.Fatalf("fill: %+v", res)
	}
	// The same message again (say, replayed after a reconnect) is not a second fill.
	if res := b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "TRADE", LeavesQty: "1.5", ExecutedQty: "0.5"}); res.Fill != nil {
		t.Fatal("duplicate fill counted")
	}
	got := b.Snapshot()[0]
	if got.InFlight != Modify || !got.EffectivePrice().Equal(d("101")) {
		t.Fatalf("trade must not settle the modify: %+v", got)
	}
	b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "MODIFIED", Status: "ACTIVE", Price: "101", Quantity: "2", LeavesQty: "1.5", ExecutedQty: "0.5"})
	got = b.Snapshot()[0]
	if got.InFlight != None || !got.Price.Equal(d("101")) || got.PendingPrice != nil {
		t.Fatalf("after MODIFIED: %+v", got)
	}

	// A rejected modify leaves the order resting at its old terms.
	b.BeginModify(o.ExternalID, d("50"), d("2"))
	res = b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "REJECTED", Text: "Insufficient balance", LeavesQty: "1.5", ExecutedQty: "0.5"})
	got = b.Snapshot()[0]
	if res.Reject == "" || got.InFlight != None || !got.Price.Equal(d("101")) {
		t.Fatalf("after reject: %+v %+v", res, got)
	}

	// Filled out.
	res = b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "TRADE", Status: "FILLED", LeavesQty: "0", ExecutedQty: "2", TradePrice: "101"})
	if !res.Gone || res.Fill == nil || !res.Fill.Qty.Equal(d("1.5")) || b.Len() != 0 {
		t.Fatalf("filled: %+v len %d", res, b.Len())
	}

	// Another book's orders are ignored; an untracked order with our prefix is an orphan.
	if res := b.ApplyDropCopy(tm.DropCopy{ExternalID: "cqxxxxxxxxxxxxxxxx", InstrumentID: "8", Status: "ACTIVE"}); res.Orphan != "" {
		t.Fatal("other instrument treated as ours")
	}
	if res := b.ApplyDropCopy(tm.DropCopy{ExternalID: "cqxxxxxxxxxxxxxxxx", InstrumentID: "7", Status: "ACTIVE"}); res.Orphan == "" {
		t.Fatal("orphan not reported")
	}
}

func TestBookFIXChain(t *testing.T) {
	b := NewBook("cq", "7")
	o := b.BeginCreate(Sell, 0, d("100"), d("1"))
	b.ApplyDropCopy(tm.DropCopy{ExternalID: o.ExternalID, InstrumentID: "7", EventType: "NEW", LeavesQty: "1", ExecutedQty: "0"})
	cl1, orig1, _ := b.BeginModify(o.ExternalID, d("101"), d("1"))
	if orig1 != o.ExternalID {
		t.Fatalf("first replace points at the root, got %s", orig1)
	}
	// The drop copy echoes the replace's ClOrdID; it still finds the order.
	b.ApplyDropCopy(tm.DropCopy{ExternalID: cl1, InstrumentID: "7", EventType: "MODIFIED", Price: "101", Quantity: "1", LeavesQty: "1", ExecutedQty: "0"})
	cl2, orig2, _ := b.BeginModify(o.ExternalID, d("102"), d("1"))
	if orig2 != cl1 {
		t.Fatalf("second replace points at the first, got %s", orig2)
	}
	// Rejected: the next request must point back at cl1, not the dead cl2.
	b.CancelRejected(cl2, "2")
	b.ApplyDropCopy(tm.DropCopy{ExternalID: cl2, InstrumentID: "7", EventType: "REJECTED", LeavesQty: "1", ExecutedQty: "0"})
	_, orig3, ok := b.BeginCancel(o.ExternalID)
	if !ok || orig3 != cl1 {
		t.Fatalf("cancel points at %s, want %s", orig3, cl1)
	}
}

func TestPositionPnL(t *testing.T) {
	var p position
	p.apply(Buy, d("1"), d("100"))
	p.apply(Buy, d("1"), d("110"))
	if !p.avgCost.Equal(d("105")) {
		t.Fatalf("avg %s", p.avgCost)
	}
	p.apply(Sell, d("3"), d("120")) // closes 2 at +15, opens 1 short at 120
	if !p.realized.Equal(d("30")) || !p.qty.Equal(d("-1")) || !p.avgCost.Equal(d("120")) {
		t.Fatalf("after flip: %+v", p)
	}
	p.apply(Buy, d("1"), d("100")) // short covered 20 lower
	if !p.realized.Equal(d("50")) || !p.qty.IsZero() {
		t.Fatalf("after cover: %+v", p)
	}
}

func TestParamsMerge(t *testing.T) {
	p := testParams()
	next, err := p.Merge([]byte(`{"spreadBps": 25, "quoteSize": "0.002"}`))
	if err != nil || next.SpreadBps != 25 || !next.QuoteSize.Equal(d("0.002")) || next.Levels != 3 {
		t.Fatalf("%v %+v", err, next)
	}
	if _, err := p.Merge([]byte(`{"levels": 50}`)); err == nil {
		t.Fatal("levels over the max accepted")
	}
	if _, err := p.Merge([]byte(`{"nope": 1}`)); err == nil {
		t.Fatal("unknown key accepted")
	}
	if len(Schema()) != 21 {
		t.Fatalf("schema has %d params", len(Schema()))
	}
}

func TestSizesInQuote(t *testing.T) {
	p := testParams()
	p.SizeUnit, p.QuoteSize, p.MaxPosition, p.MaxBaseAlloc = SizeInQuote, d("50"), d("1000"), d("200")
	b := p.InBase(d("50000"))
	if !b.QuoteSize.Equal(d("0.001")) || !b.MaxPosition.Equal(d("0.02")) || !b.MaxBaseAlloc.Equal(d("0.004")) || b.SizeUnit != SizeInBase {
		t.Fatalf("%+v", b)
	}
	if !b.MaxQuoteAlloc.Equal(p.MaxQuoteAlloc) || b.SpreadBps != p.SpreadBps {
		t.Fatal("only the sizes should change")
	}
	// No price yet: size nothing rather than read 50 dollars as 50 coins.
	if z := p.InBase(decimal.Zero); !z.QuoteSize.IsZero() {
		t.Fatalf("sized %s with no price", z.QuoteSize)
	}
	// Base books are left alone.
	if q := testParams().InBase(d("50000")); !q.QuoteSize.Equal(d("0.001")) {
		t.Fatal("converted a base book")
	}
	if _, err := testParams().Merge([]byte(`{"sizeUnit": "dollars"}`)); err == nil {
		t.Fatal("a size unit that isn't base or quote was accepted")
	}
}

// The warning for an empty side names the limit that empties it.
func TestEmptySideReason(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.QuoteSize, p.MaxPosition = d("0.008"), d("0.00001") // at 50,000 the minimum order is 0.0001
	e := addBook(t, desk, "BTC-USDC", p)
	tick(desk, "BTC-USD", "50000")
	waitFor(t, "warnings", func() bool { return len(e.Status().Warnings) == 2 })
	for _, w := range e.Status().Warnings {
		if !strings.Contains(w, "max position change 0.00001 BTC is less than one minimum order") {
			t.Fatalf("warning doesn't name maxPosition: %s", w)
		}
	}
}
