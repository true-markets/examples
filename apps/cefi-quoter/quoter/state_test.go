package quoter

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

func fillBook(e *Engine, side Side, qty, price string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.applyFillLocked(Fill{Side: side, Qty: d(qty), Price: d(price), Level: 0, Time: time.Now()}, func(string, decimal.Decimal) {})
}

type fakeHistory []tm.RestOrder

func (h fakeHistory) RecentOrders(context.Context) ([]tm.RestOrder, error) { return h, nil }

// A restart picks up the position, PnL, counts, events and trades where the last run left them,
// through the state file's JSON.
func TestStateCarriesAcrossARestart(t *testing.T) {
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	e := addBook(t, desk, "BTC-USDC", testParams())
	tick(desk, "BTC-USD", "50000")
	waitFor(t, "reference", func() bool { return e.Status().Reference != nil })
	fillBook(e, Buy, "0.002", "49990")
	fillBook(e, Sell, "0.001", "50010")
	since := e.Status().Position.Since

	raw, err := json.Marshal(desk.State())
	if err != nil {
		t.Fatal(err)
	}
	var saved State
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	saved.SavedAt = time.Now()

	next := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	if err := next.Restore(&saved); err != nil {
		t.Fatal(err)
	}
	e2 := addBook(t, next, "BTC-USDC", testParams())
	s := e2.Status()
	if !s.Position.Qty.Equal(d("0.001")) || !s.Position.RealizedPnl.Equal(d("0.02")) || s.Stats.Fills != 2 || !s.Position.Since.Equal(since) {
		t.Fatalf("position %+v stats %+v", s.Position, s.Stats)
	}
	restored := false
	for _, ev := range s.Events {
		restored = restored || strings.Contains(ev.Message, "restored from the state")
	}
	if !restored {
		t.Fatalf("no restore event in %+v", s.Events)
	}
	if r := next.Trades(10); r.Total.Trades != 2 {
		t.Fatalf("trades %+v", r.Total)
	}

	// Another account's state is refused.
	saved.ClientID = "someone-else"
	other := NewDesk(DeskConfig{Environment: "test", ClientID: "me", Log: next.log})
	if err := other.Restore(&saved); err == nil {
		t.Fatal("restored another client's state")
	}
}

// Quotes a crash left resting kept filling while the quoter was down; the next start counts that.
func TestRecoverMissedFills(t *testing.T) {
	saved := &State{Environment: "test", SavedAt: time.Now().Add(-time.Minute), Books: map[string]BookState{
		"BTC-USDC": {
			Since:    time.Now().Add(-time.Hour),
			Position: PositionState{Qty: d("0.001"), AvgCost: d("50000")},
			Orders: []OrderState{
				{ExternalID: "cq-1", OrderID: "100", Side: Buy, Level: 0, Price: d("49900"), Executed: d("0.0005")},
				{ExternalID: "cq-2", OrderID: "101", Side: Sell, Level: 0, Price: d("50100"), Executed: d("0")},
				{ExternalID: "cq-3", Side: Sell, Level: 1, Price: d("50200")}, // create in flight: no exchange id yet
			},
		},
	}}
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	if err := desk.Restore(saved); err != nil {
		t.Fatal(err)
	}
	e := addBook(t, desk, "BTC-USDC", testParams())
	var filled, untouched tm.RestOrder
	filled.ID, filled.ExternalID, filled.ExecutedQty = "100", "cq-1", "0.0015" // 0.001 more since the save
	filled.OrderInfo.Price = "49900"
	untouched.ID, untouched.ExternalID, untouched.ExecutedQty = "101", "cq-2", "0"
	notes := desk.RecoverMissedFills(context.Background(), fakeHistory{filled, untouched})
	if len(notes) != 2 || !strings.Contains(notes[0], "BUY 0.001 @ 49900") || !strings.Contains(notes[1], "cq-3 isn't in the recent order history") {
		t.Fatalf("notes %q", notes)
	}
	if s := e.Status(); !s.Position.Qty.Equal(d("0.002")) || s.Stats.Fills != 1 {
		t.Fatalf("position %+v", s.Position)
	}
	r := desk.Trades(10)
	if len(r.Trades) != 1 || !r.Trades[0].Recovered || r.Total.EdgeBps != nil {
		t.Fatalf("journal %+v total %+v", r.Trades, r.Total)
	}
	// Checked once: a second call finds nothing to do.
	if again := desk.RecoverMissedFills(context.Background(), fakeHistory{filled}); len(again) != 0 {
		t.Fatalf("checked twice: %q", again)
	}
}

// A mark-out that came due while the quoter was down stays empty; one still to come is taken.
func TestJournalRestoreSkipsMarkoutsMissedWhileDown(t *testing.T) {
	now := time.Now()
	j := NewJournal()
	j.Restore(JournalState{NextID: 2, Trades: []Trade{
		{ID: 1, Time: now.Add(-10 * time.Minute), Symbol: "BTC-USDC", Side: Buy, Price: d("100"), Qty: d("1"), Notional: d("100"), Markouts: make([]*float64, 2)},
		// Its 30 s mark-out came due 10 s before the restart: missed, even though that's recent.
		{ID: 2, Time: now.Add(-40 * time.Second), Symbol: "BTC-USDC", Side: Buy, Price: d("100"), Qty: d("1"), Notional: d("100"), Markouts: make([]*float64, 2)},
	}}, now)
	j.Mark("BTC-USDC", d("101"), now)
	j.Mark("BTC-USDC", d("101"), now.Add(260*time.Second)) // trade 2's five minutes
	r := j.Report(0)
	old, recent := r.Trades[1], r.Trades[0]
	if old.Markouts[0] != nil || old.Markouts[1] != nil {
		t.Fatalf("old trade marked late: %v", old.Markouts)
	}
	if recent.Markouts[0] != nil || recent.Markouts[1] == nil {
		t.Fatalf("recent trade: 30s should be missed, 300s taken: %v", recent.Markouts)
	}
	j.Add(Market{Symbol: "BTC-USDC"}, Fill{Side: Buy, Qty: d("1"), Price: d("100"), Time: now}, d("100"))
	if r := j.Report(1); r.Trades[0].ID != 3 {
		t.Fatalf("ids continue from the saved journal: %d", r.Trades[0].ID)
	}
}

func TestResetPosition(t *testing.T) {
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	e := addBook(t, desk, "BTC-USDC", testParams())
	fillBook(e, Buy, "0.002", "50000")
	before := e.Status().Position.Since
	time.Sleep(5 * time.Millisecond)
	if err := desk.ResetPosition("BTC-USDC"); err != nil {
		t.Fatal(err)
	}
	s := e.Status()
	if !s.Position.Qty.IsZero() || s.Stats.Fills != 0 || !s.Position.Since.After(before) {
		t.Fatalf("after reset %+v %+v", s.Position, s.Stats)
	}
}

// The book summary carries what the open PnL is made of: the position, its average cost, and
// when the position started counting.
func TestSummaryExplainsOpenPnl(t *testing.T) {
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	e := addBook(t, desk, "BTC-USDC", testParams())
	fillBook(e, Buy, "0.002", "50000")
	fillBook(e, Buy, "0.002", "51000")
	s := e.Summary()
	if !s.Position.Equal(d("0.004")) || !s.AvgCost.Equal(d("50500")) {
		t.Fatalf("position %s avg %s", s.Position, s.AvgCost)
	}
	if !s.PositionSince.Equal(e.Status().Position.Since) || s.PositionSince.IsZero() {
		t.Fatalf("since %v", s.PositionSince)
	}
}

// The book summary carries what the book is quoting against the exchange: the EBBO, its resting
// quotes, the skew and its cap, and the take view, for the desk's quoting table.
func TestSummaryShowsQuoting(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.MaxPosition, p.SkewBps = d("0.01"), 10
	e := addBook(t, desk, "BTC-USDC", p)
	ebbo(desk, "BTC-USDC", "49990", "1", "50010", "1")
	tick(desk, "BTC-USD", "50000")
	e.SetEnabled(true)
	waitFor(t, "six resting orders", func() bool { return fx.resting("") == 6 && settled(e) })
	s := e.Summary()
	if s.BestBid == nil || !s.BestBid.Equal(d("49990")) || s.BestAsk == nil || !s.BestAsk.Equal(d("50010")) {
		t.Fatalf("bbo %v %v", s.BestBid, s.BestAsk)
	}
	if len(s.Quotes) != 6 || s.SkewMaxBps != 10 || s.Mid == nil || s.Taking == nil {
		t.Fatalf("quotes %d skew max %v mid %v taking %v", len(s.Quotes), s.SkewMaxBps, s.Mid, s.Taking)
	}
}
