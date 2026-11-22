package quoter

import (
	"testing"

	"github.com/shopspring/decimal"
)

func takeParams() Params {
	p := testParams()
	p.ProfitTaker, p.Takeout = true, false
	p.TakeEdgeBps, p.TakeFlattenFloorBps, p.TakerFeeBps = 25, 2, 0
	p.TakeMaxSize, p.MaxPosition = d("0.01"), d("0.01")
	return p
}

// A book 0.008 BTC long (80% of the limit), bought at 49,900, with fair value at 50,000.
func longBook(bid string) takeInput {
	return takeInput{
		Params: takeParams(), Mid: d("50000"), Position: d("0.008"), AvgCost: d("49900"),
		BestBid: dp(bid), BestAsk: dp("50100"), BidQty: d("1"), AskQty: d("1"),
		FreeBase: d("1"), FreeQuote: d("100000"),
	}
}

func TestProfitTakeEdgeFallsAsThePositionFills(t *testing.T) {
	// At 80% of the limit the profit take needs 25 - 0.8*(25-2) = 6.6 bps.
	if got := takeThreshold(takeParams(), Sell, d("0.008")); got < 6.59 || got > 6.61 {
		t.Fatalf("threshold %v, want 6.6", got)
	}
	// A bid 5 bps over fair isn't enough; 7 bps is.
	if d := decideTake(longBook("50025")); d != nil {
		t.Fatalf("took at 5 bps: %+v", d)
	}
	got := decideTake(longBook("50035"))
	if got == nil || got.Kind != ProfitTake || got.Side != Sell || !got.Qty.Equal(d("0.008")) {
		t.Fatalf("want a profit take selling the whole 0.008, got %+v", got)
	}
}

func TestProfitTakeNeverClosesBelowCost(t *testing.T) {
	in := longBook("50035")
	in.AvgCost = d("50040") // bought above where the bid is now
	if got := decideTake(in); got != nil {
		t.Fatalf("closed below cost: %+v", got)
	}
	in.AvgCost, in.Params.TakerFeeBps = d("50035"), 1 // selling at cost loses the fee
	in.Mid = d("49990")
	if got := decideTake(in); got != nil {
		t.Fatalf("closed at cost and paid the fee: %+v", got)
	}
}

func TestTakesSkipOurOwnQuotes(t *testing.T) {
	in := longBook("50035")
	in.BidQty = decimal.Zero // the best bid is ours: nothing to take
	if got := decideTake(in); got != nil {
		t.Fatalf("took from ourselves: %+v", got)
	}
	in.BidQty = d("0.003") // someone else shows 0.003
	if got := decideTake(in); got == nil || !got.Qty.Equal(d("0.003")) {
		t.Fatalf("want 0.003, got %+v", got)
	}
}

func TestTakeoutIsOffByDefaultAndTapers(t *testing.T) {
	flat := takeInput{
		Params: takeParams(), Mid: d("50000"), BestBid: dp("49900"), BestAsk: dp("49850"), // ask 30 bps under fair
		BidQty: d("1"), AskQty: d("1"), FreeBase: d("1"), FreeQuote: d("100000"),
	}
	if got := decideTake(flat); got != nil {
		t.Fatalf("takeout ran while off: %+v", got)
	}
	flat.Params.Takeout = true
	if got := decideTake(flat); got == nil || got.Kind != Takeout || got.Side != Buy || !got.Qty.Equal(d("0.009")) {
		t.Fatalf("flat: want a takeout buying up to the 90%% stop (0.009), got %+v", got)
	}
	// At 70% long, takeout needs 25 + 0.5*30 = 40 bps: 30 isn't enough.
	flat.Position, flat.AvgCost = d("0.007"), d("50000")
	if got := decideTake(flat); got != nil {
		t.Fatalf("built past the soft cap on too little edge: %+v", got)
	}
}

func TestUnfundedProfitTake(t *testing.T) {
	in := longBook("50035")
	in.FreeBase = decimal.Zero // our asks hold every BTC we have
	got := decideTake(in)
	if got == nil || !got.Unfunded {
		t.Fatalf("want an unfunded profit take, got %+v", got)
	}
}
