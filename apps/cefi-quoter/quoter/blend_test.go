package quoter

import (
	"context"
	"strings"
	"testing"

	"github.com/true-markets/examples/apps/cefi-quoter/reference"
)

// A book priced off three sources: one drifts away by a split ratio, the book keeps quoting off the
// other two and says why; when the sources can't agree at all, it stops.
func TestBlendedReferenceLeavesOutAnOutlierAndHaltsOnDisagreement(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	e := addBook(t, desk, "BTC-USDC", p)
	blend := reference.BlendConfig{Sources: []reference.Source{
		{Ref: "BTC-USD", Weight: 1}, {Ref: "kraken:BTC/USD", Weight: 1}, {Ref: "hyperliquid:BTC", Weight: 1},
	}}
	if _, err := desk.SetBlend(context.Background(), "BTC-USDC", blend); err != nil {
		t.Fatal(err)
	}
	tick(desk, "BTC-USD", "50000")
	tick(desk, "kraken:BTC/USD", "50010")
	tick(desk, "hyperliquid:BTC", "100020") // trades 2× the others
	s, _ := desk.BookStatus("BTC-USDC")
	if s.Blend == nil || s.Blend.Used != 2 || s.Reference == nil || !s.Reference.Mid.Equal(d("50005")) {
		t.Fatalf("blend %+v reference %+v", s.Blend, s.Reference)
	}
	var hl reference.SourceView
	for _, sv := range s.Blend.Sources {
		if sv.Ref == "hyperliquid:BTC" {
			hl = sv
		}
	}
	if hl.State != "out" || hl.Action == nil || hl.Action.Kind != "split" || !hl.Action.Multiplier.Equal(d("0.5")) {
		t.Fatalf("hyperliquid row %+v", hl)
	}
	found := false
	for _, ev := range s.Events {
		found = found || (ev.Kind == "reference" && strings.Contains(ev.Message, "left out of the reference"))
	}
	if !found {
		t.Fatalf("no event for the left-out source: %+v", s.Events)
	}

	// Two sources that disagree: no price, quotes come down.
	e.SetEnabled(true)
	waitFor(t, "quoting", func() bool { return fx.resting("") == 6 })
	if _, err := desk.SetBlend(context.Background(), "BTC-USDC", reference.BlendConfig{Sources: []reference.Source{
		{Ref: "BTC-USD", Weight: 1}, {Ref: "hyperliquid:BTC", Weight: 1},
	}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "pulled on disagreement", func() bool { return fx.resting("") == 0 })
	if s := e.Status(); s.State != "waiting" || !strings.Contains(s.Reason, "disagree") {
		t.Fatalf("state %s reason %q", s.State, s.Reason)
	}

	// The fix the blend suggested brings it back.
	if _, err := desk.SetBlend(context.Background(), "BTC-USDC", reference.BlendConfig{Sources: []reference.Source{
		{Ref: "BTC-USD", Weight: 1}, {Ref: "hyperliquid:BTC", Weight: 1, Multiplier: d("0.5")},
	}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "quoting again", func() bool { return fx.resting("") == 6 })
}

// Someone bidding far above the reference is more likely right than generous: the book stops.
func TestReferenceGuardStopsQuotingWhenTheBookTradesThroughTheReference(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "usdc": "100000"})
	desk := startDesk(t, fx)
	p := testParams()
	p.MaxRefGapBps = 500
	e := addBook(t, desk, "BTC-USDC", p)
	tick(desk, "BTC-USD", "50000")
	e.SetEnabled(true)
	waitFor(t, "quoting", func() bool { return fx.resting("") == 6 })
	bid := d("53000") // 600 bps over
	e.mu.Lock()
	e.bestBid = &bid
	e.mu.Unlock()
	tick(desk, "BTC-USD", "50000")
	waitFor(t, "pulled by the guard", func() bool { return fx.resting("") == 0 })
	if s := e.Status(); !strings.Contains(s.Reason, "reference guard") {
		t.Fatalf("reason %q", s.Reason)
	}
}
