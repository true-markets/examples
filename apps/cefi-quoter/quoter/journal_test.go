package quoter

import (
	"testing"
	"time"
)

func TestJournalMarkouts(t *testing.T) {
	j := NewJournal()
	m := Market{Symbol: "BTC-USDC", QuoteSymbol: "USDC"}
	t0 := time.Now().Add(-time.Hour)
	// A bid filled 10 bps under fair value, and an ask filled 5 bps over it.
	j.Add(m, Fill{Side: Buy, Level: 0, Price: d("49950"), Qty: d("0.002"), Time: t0}, d("50000"))
	j.Add(m, Fill{Side: Sell, Level: TakeLevel, TakeKind: ProfitTake, Price: d("50025"), Qty: d("0.002"), Time: t0}, d("50000"))

	r := j.Report(0)
	if len(r.Trades) != 2 || r.Trades[0].Kind != "profit take" || r.Trades[1].Kind != "maker" {
		t.Fatalf("%+v", r.Trades)
	}
	if e := r.Trades[1].EdgeBps; e < 10.0 || e > 10.02 {
		t.Fatalf("bid edge %v, want about 10 bps", e)
	}
	// 30 seconds on, the market has fallen through the bid: it marks out at -10 bps. The ask gains.
	j.Mark("BTC-USDC", d("49900"), t0.Add(31*time.Second))
	r = j.Report(0)
	bid, ask := r.Trades[1], r.Trades[0]
	if bid.Markouts[0] == nil || *bid.Markouts[0] > -10 || *bid.Markouts[0] < -10.02 || bid.Markouts[1] != nil {
		t.Fatalf("bid mark-outs %v", bid.Markouts)
	}
	if *ask.Markouts[0] < 24.9 {
		t.Fatalf("ask mark-out %v", *ask.Markouts[0])
	}
	// Five minutes on, both are marked at both horizons and the summary adds up.
	j.Mark("BTC-USDC", d("50000"), t0.Add(301*time.Second))
	s := j.Report(0).Total
	if s.Trades != 2 || s.Marked[0] != 2 || s.Marked[1] != 2 || s.EdgeBps == nil || s.Retention[1] == nil {
		t.Fatalf("summary %+v", s)
	}
	// Back at the fill-time mid, every fill kept all its edge.
	if r := *s.Retention[1]; r < 0.99 || r > 1.01 {
		t.Fatalf("retention at 300s %v, want 1", r)
	}
	if len(j.pending["BTC-USDC"]) != 0 {
		t.Fatal("fully marked trades should leave the pending list")
	}
}

func TestTakeViewSaysWhatsInTheWay(t *testing.T) {
	in := longBook("50025") // a bid 5 bps over fair; at 80% of the limit a profit take needs 6.6
	view, d := evaluateTakes(in)
	if d != nil || view.Sell.Blocker != "no edge" || view.Sell.Kind != ProfitTake || *view.Sell.EdgeBps < 4.9 {
		t.Fatalf("sell side %+v", view.Sell)
	}
	if view.Buy.Kind != Takeout || view.Buy.Blocker != "off" {
		t.Fatalf("buy side %+v", view.Buy)
	}
	in = longBook("50035")
	view, d = evaluateTakes(in)
	if d == nil || view.Sell.Blocker != "" || !view.Sell.Size.Equal(d.Qty) {
		t.Fatalf("ready side %+v", view.Sell)
	}
}
