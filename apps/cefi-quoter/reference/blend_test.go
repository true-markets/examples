package reference

import (
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

var now = time.Date(2026, 11, 22, 15, 0, 0, 0, time.UTC)

func tick(ref, bid, ask, size string) Tick {
	b, a := d(bid), d(ask)
	return Tick{Reference: ref, Bid: b, Ask: a, Mid: b.Add(a).Div(decimal.NewFromInt(2)), BidSize: d(size), AskSize: d(size), Time: now, Seen: now}
}

func blend(t *testing.T, c BlendConfig) BlendConfig {
	t.Helper()
	c, err := c.Normalized()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func ticks(ts ...Tick) map[string]Tick {
	out := map[string]Tick{}
	for _, t := range ts {
		out[t.Reference] = t
	}
	return out
}

func source(v BlendView, ref string) SourceView {
	for _, s := range v.Sources {
		if s.Ref == ref {
			return s
		}
	}
	return SourceView{}
}

func TestBlendSingleSourceIsThatSource(t *testing.T) {
	c := blend(t, Single("BTC-USD"))
	v := Evaluate(c, ticks(tick("BTC-USD", "99", "101", "1")), now, 3*time.Second)
	if v.Mid == nil || !v.Mid.Equal(d("100")) || v.Used != 1 || source(v, "BTC-USD").GapBps != nil {
		t.Fatalf("got %+v", v)
	}
}

func TestBlendFixedWeightsAndMultipliers(t *testing.T) {
	c := blend(t, BlendConfig{Sources: []Source{
		{Ref: "hyperliquid:xyz:GOOGL", Weight: 3},
		// Quotes a tenth of a share.
		{Ref: "kraken:GOOGLx/USD", Weight: 1, Multiplier: d("10")},
	}})
	v := Evaluate(c, ticks(tick("hyperliquid:xyz:GOOGL", "99.9", "100.1", "1"), tick("kraken:GOOGLx/USD", "10.03", "10.05", "1")), now, 3*time.Second)
	// 3/4 of 100 + 1/4 of 100.4
	if v.Mid == nil || !v.Mid.Equal(d("100.1")) {
		t.Fatalf("mid %v, want 100.1", v.Mid)
	}
	if s := source(v, "kraken:GOOGLx/USD"); s.Share != 0.25 || !s.Adjusted.Equal(d("100.4")) || s.Action == nil || s.Action.Kind != "drift" {
		t.Fatalf("kraken row %+v", s)
	}
}

func TestBlendTokenMultiplier(t *testing.T) {
	c := blend(t, BlendConfig{Sources: []Source{{Ref: "hyperliquid:xyz:GOOGL", Weight: 1}}, TokenMultiplier: d("1.02")})
	v := Evaluate(c, ticks(tick("hyperliquid:xyz:GOOGL", "99", "101", "1")), now, 3*time.Second)
	if !v.PerShare.Equal(d("100")) || !v.Mid.Equal(d("102")) || !v.Bid.Equal(d("100.98")) {
		t.Fatalf("per share %v mid %v bid %v", v.PerShare, v.Mid, v.Bid)
	}
}

func TestBlendFlagsAnUnadjustedSplitAndPricesWithoutIt(t *testing.T) {
	c := blend(t, BlendConfig{Sources: []Source{
		{Ref: "hyperliquid:xyz:NVDA", Weight: 1},
		{Ref: "hyperliquid:io:NVDA", Weight: 1},
		{Ref: "kraken:NVDAx/USD", Weight: 1},
	}})
	// Kraken's token hasn't taken a 4-for-1 split the others have.
	v := Evaluate(c, ticks(
		tick("hyperliquid:xyz:NVDA", "99.9", "100.1", "1"),
		tick("hyperliquid:io:NVDA", "100.0", "100.2", "1"),
		tick("kraken:NVDAx/USD", "400.2", "400.6", "1"),
	), now, 3*time.Second)
	k := source(v, "kraken:NVDAx/USD")
	if k.State != "out" || k.Action == nil || k.Action.Kind != "split" || !k.Action.Multiplier.Equal(d("0.25")) {
		t.Fatalf("kraken row %+v action %+v", k, k.Action)
	}
	if v.Used != 2 || !v.Mid.Equal(d("100.05")) {
		t.Fatalf("used %d mid %v", v.Used, v.Mid)
	}
	// With the suggested multiplier the three agree.
	c.Sources[2].Multiplier = k.Action.Multiplier
	v = Evaluate(c, ticks(
		tick("hyperliquid:xyz:NVDA", "99.9", "100.1", "1"),
		tick("hyperliquid:io:NVDA", "100.0", "100.2", "1"),
		tick("kraken:NVDAx/USD", "400.2", "400.6", "1"),
	), now, 3*time.Second)
	if v.Used != 3 || source(v, "kraken:NVDAx/USD").State != "in" {
		t.Fatalf("after the fix: %+v", v)
	}
}

func TestBlendTwoSourcesThatDisagreeGiveNoPrice(t *testing.T) {
	c := blend(t, BlendConfig{Sources: []Source{{Ref: "a-USD", Weight: 1}, {Ref: "b-USD", Weight: 1}}})
	v := Evaluate(c, ticks(tick("A-USD", "99", "101", "1"), tick("B-USD", "104", "106", "1")), now, 3*time.Second)
	if v.Mid != nil || !strings.Contains(v.Problem, "disagree") {
		t.Fatalf("got mid %v problem %q", v.Mid, v.Problem)
	}
	if source(v, "A-USD").Action == nil || source(v, "A-USD").Action.Kind != "multiplier" {
		t.Fatalf("A row %+v", source(v, "A-USD"))
	}
}

func TestBlendLeavesOutStaleSourcesAndWatchesWeightZero(t *testing.T) {
	c := blend(t, BlendConfig{Sources: []Source{
		{Ref: "A-USD", Weight: 1}, {Ref: "B-USD", Weight: 1}, {Ref: "C-USD", Weight: 0},
	}})
	b := tick("B-USD", "200", "202", "1")
	b.Seen = now.Add(-5 * time.Second)
	v := Evaluate(c, ticks(tick("A-USD", "99", "101", "1"), b, tick("C-USD", "101", "103", "1")), now, 3*time.Second)
	if !v.Mid.Equal(d("100")) || source(v, "B-USD").State != "stale" {
		t.Fatalf("mid %v, B %+v", v.Mid, source(v, "B-USD"))
	}
	w := source(v, "C-USD")
	if w.State != "watch" || w.Share != 0 || w.GapBps == nil || *w.GapBps < 199 || *w.GapBps > 201 {
		t.Fatalf("watched row %+v", w)
	}
	if v := Evaluate(c, ticks(), now, 3*time.Second); v.Mid != nil || v.Problem == "" {
		t.Fatalf("no ticks: %+v", v)
	}
}

func TestBlendDepthWeighting(t *testing.T) {
	c := blend(t, BlendConfig{Weighting: WeightDepth, Sources: []Source{{Ref: "A-USD", Weight: 1}, {Ref: "B-USD", Weight: 1}}})
	v := Evaluate(c, ticks(tick("A-USD", "99.9", "100.1", "3"), tick("B-USD", "100.3", "100.5", "1")), now, 3*time.Second)
	// A shows about three times B's dollars.
	if a := source(v, "A-USD").Share; a < 0.74 || a > 0.76 {
		t.Fatalf("A's share %v", a)
	}
}

func TestBlendConfigChecks(t *testing.T) {
	for _, c := range []BlendConfig{
		{},
		{Sources: []Source{{Ref: "A-USD", Weight: 0}}},
		{Sources: []Source{{Ref: "A-USD", Weight: 1}, {Ref: "a-usd", Weight: 1}}},
		{Sources: []Source{{Ref: "A-USD", Weight: -1}}},
		{Sources: []Source{{Ref: "A-USD", Weight: 1}}, Weighting: "median"},
	} {
		if _, err := c.Normalized(); err == nil {
			t.Errorf("%+v: no error", c)
		}
	}
}
