package quoter

import (
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// fillOrder applies a fill on an exchange order, the way a drop copy does.
func fillOrder(e *Engine, side Side, qty, price, orderID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.applyFillLocked(Fill{OrderID: orderID, Side: side, Qty: d(qty), Price: d(price), Level: 0, Time: time.Now()}, func(string, decimal.Decimal) {})
}

// The journal charges each fill its order's fee rate on its own notional, once, and adds the fees
// up by book.
func TestJournalAppliesFeesByOrder(t *testing.T) {
	j := NewJournal()
	m := Market{Symbol: "BTC-USDC", QuoteSymbol: "USDC"}
	j.Add(m, Fill{OrderID: "1", Side: Buy, Qty: d("0.002"), Price: d("50000"), Time: time.Now()}, d("50010"))
	j.Add(m, Fill{OrderID: "1", Side: Buy, Qty: d("0.001"), Price: d("50000"), Time: time.Now()}, d("50010"))
	j.Add(m, Fill{OrderID: "2", Side: Sell, Qty: d("0.001"), Price: d("51000"), Time: time.Now()}, d("50990"))
	j.Add(m, Fill{Side: Sell, Qty: d("0.001"), Price: d("51000"), Time: time.Now()}, d("50990")) // no order id: never gets a fee

	if !j.WaitingForFees(time.Now()) {
		t.Fatal("fills without fees should be waiting")
	}
	// Order 1's second match isn't listed yet; it fills at the same rate, so it's charged anyway.
	added := j.ApplyFees([]tm.TradeFill{{OrderID: "1", MatchID: "a", FeeBps: "2", Liquidity: "MAKER"}})
	var sum decimal.Decimal
	for _, f := range added["BTC-USDC"] {
		sum = sum.Add(f.Fee)
	}
	if !sum.Equal(d("0.03")) { // 150 notional at 2 bps
		t.Fatalf("added %s", sum)
	}
	if again := j.ApplyFees([]tm.TradeFill{{OrderID: "1", FeeBps: "2"}}); len(again) != 0 {
		t.Fatalf("charged twice: %v", again)
	}
	j.ApplyFees([]tm.TradeFill{{OrderID: "2", FeeBps: "5", Liquidity: "TAKER"}})
	if j.WaitingForFees(time.Now()) {
		t.Fatal("still waiting")
	}

	r := j.Report(0)
	if r.Total.Fees < 0.0554 || r.Total.Fees > 0.0556 || r.Total.FeesPending != 0 { // 0.03 + 51 × 5 bps
		t.Fatalf("fees %v pending %d", r.Total.Fees, r.Total.FeesPending)
	}
	if r.Total.FeeBps == nil || *r.Total.FeeBps < 2.7 || *r.Total.FeeBps > 2.8 { // 0.0555 over 201 notional
		t.Fatalf("fee bps %v", r.Total.FeeBps)
	}
	if tr := r.Trades[1]; tr.Liquidity != "TAKER" || tr.FeeBps == nil || *tr.FeeBps != 5 {
		t.Fatalf("trade %+v", tr)
	}
}

// The desk reads the account's fills while one is waiting for its fee, and the fee lands on the
// trade and in the book's position; it carries across a restart.
func TestDeskReadsFeesIntoThePosition(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	e := addBook(t, desk, "BTC-USDC", testParams())
	tick(desk, "BTC-USD", "50000")
	fx.mu.Lock()
	fx.tradeFills = []tm.TradeFill{{OrderID: "x1", FeeBps: "4", Liquidity: "MAKER"}}
	fx.mu.Unlock()
	fillOrder(e, Buy, "0.002", "50000", "x1")
	waitFor(t, "the fee", func() bool { return e.Status().Position.Fees.Equal(d("0.04")) })
	if s := desk.Status().Totals[0]; !s.Fees.Equal(d("0.04")) {
		t.Fatalf("totals %+v", s)
	}

	saved := e.saveState()
	e2 := addBook(t, startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"})), "BTC-USDC", testParams())
	e2.restoreState(saved, time.Now())
	if !e2.Status().Position.Fees.Equal(d("0.04")) {
		t.Fatalf("restored fees %s", e2.Status().Position.Fees)
	}
}

// A fee that turns up after a reset, for a fill from before it, isn't counted in the new position.
func TestFeeFromBeforeAResetIsLeftOut(t *testing.T) {
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	e := addBook(t, desk, "BTC-USDC", testParams())
	before := time.Now()
	time.Sleep(2 * time.Millisecond)
	if err := desk.ResetPosition("BTC-USDC"); err != nil {
		t.Fatal(err)
	}
	e.AddFee(FeeAt{Fee: d("1"), At: before})
	e.AddFee(FeeAt{Fee: d("0.5"), At: time.Now()})
	if !e.Status().Position.Fees.Equal(d("0.5")) {
		t.Fatalf("fees %s", e.Status().Position.Fees)
	}
}
