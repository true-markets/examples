package reference

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

// A blend prices a book off several sources at once: a weighted average of their mids, after
// lining each one up with a multiplier.
//
// One source is a single point of failure, and a thin one is easy to push around. Several
// sources, each checked against the others, are harder to fool: a source that wanders away from
// the rest is left out of the price until it comes back, and if the sources can't agree at all
// the book stops quoting rather than guess.
//
// Tokenized stocks need the multipliers. Every source quotes something slightly different:
//
//   - a perp on the stock (Hyperliquid's xyz:GOOGL) tracks the share price, plus a funding premium;
//   - a tokenized stock (Kraken's GOOGLx, the book's own GOOGLC) is one token, which an issuer may
//     define as more or less than one share: after a split some issuers change the shares per
//     token rather than the number of tokens, and some pay dividends as more shares per token.
//
// Each source's multiplier turns its price into the price of one share; the token multiplier turns
// the price of a share into the price of one token of the book being quoted. A multiplier that
// isn't set when it should be shows up as a source sitting a fixed ratio away from the others, so
// the blend looks for exactly that: a ratio near a split ratio (2, 3, 10, 1/2, ...) is flagged as a
// likely split, anything else out of line as a likely multiplier, each with the multiplier that
// would line it up.

// Weightings.
const (
	WeightFixed = "fixed" // each source's weight as set
	WeightDepth = "depth" // weight × the dollars shown at the source's touch, so a deeper market counts more
)

const (
	defaultMaxDeviationBps = 100
	// driftBps is how far a source in use may sit from the others before it's noted. A perp's
	// funding premium is usually a few bps; much more than this, held for a while, is more likely
	// a multiplier drifting (dividends) than noise.
	driftBps = 25
	// A price that hasn't changed in this long is left out, however recently the source spoke:
	// a closed market's last price, repeated.
	maxPriceAge = time.Minute
	maxSources  = 8
)

// Source is one feed in a blend.
type Source struct {
	Ref string `json:"ref"`
	// Weight is this source's share of the price, relative to the others. 0 watches it: it's
	// shown and checked against the others, but doesn't move the price.
	Weight float64 `json:"weight"`
	// Multiplier turns this source's price into the price of one share. 1 unless the source
	// quotes something else: a token worth 1/10 of a share has 10.
	Multiplier decimal.Decimal `json:"multiplier"`
}

// BlendConfig is how a book's reference price is made.
type BlendConfig struct {
	Sources   []Source `json:"sources"`
	Weighting string   `json:"weighting"` // fixed or depth
	// MaxDeviationBps: a source further than this from the others is left out of the price.
	MaxDeviationBps float64 `json:"maxDeviationBps"`
	// TokenMultiplier is how many shares one token of the book represents: the blended price of a
	// share times this is the book's fair value. 1 for a plain one-share token.
	TokenMultiplier decimal.Decimal `json:"tokenMultiplier"`
}

// Single is a blend of one source: the reference as it was before blends.
func Single(ref string) BlendConfig {
	return BlendConfig{Sources: []Source{{Ref: ref, Weight: 1}}}
}

// Normalized fills in defaults, tidies the names, and checks the config.
func (c BlendConfig) Normalized() (BlendConfig, error) {
	out := c
	out.Sources = nil
	if len(c.Sources) == 0 {
		return out, fmt.Errorf("a reference needs at least one source")
	}
	if len(c.Sources) > maxSources {
		return out, fmt.Errorf("at most %d sources", maxSources)
	}
	used := 0.0
	for _, s := range c.Sources {
		s.Ref = Normalize(s.Ref)
		switch {
		case s.Ref == "":
			return out, fmt.Errorf("a source has no name")
		case slices.ContainsFunc(out.Sources, func(o Source) bool { return o.Ref == s.Ref }):
			return out, fmt.Errorf("%s is listed twice", Describe(s.Ref))
		case s.Weight < 0 || math.IsNaN(s.Weight) || math.IsInf(s.Weight, 0):
			return out, fmt.Errorf("%s: weight can't be negative", Describe(s.Ref))
		case s.Multiplier.IsNegative():
			return out, fmt.Errorf("%s: multiplier must be positive", Describe(s.Ref))
		}
		if s.Multiplier.IsZero() {
			s.Multiplier = decimal.NewFromInt(1)
		}
		used += s.Weight
		out.Sources = append(out.Sources, s)
	}
	if used <= 0 {
		return out, fmt.Errorf("at least one source needs a weight above 0")
	}
	switch out.Weighting {
	case "":
		out.Weighting = WeightFixed
	case WeightFixed, WeightDepth:
	default:
		return out, fmt.Errorf("weighting %q: use fixed or depth", out.Weighting)
	}
	if out.MaxDeviationBps == 0 {
		out.MaxDeviationBps = defaultMaxDeviationBps
	}
	if out.MaxDeviationBps < 5 || out.MaxDeviationBps > 5000 {
		return out, fmt.Errorf("max deviation must be between 5 and 5000 bps")
	}
	if out.TokenMultiplier.IsNegative() {
		return out, fmt.Errorf("token multiplier must be positive")
	}
	if out.TokenMultiplier.IsZero() {
		out.TokenMultiplier = decimal.NewFromInt(1)
	}
	return out, nil
}

// Has reports whether ref is one of the sources.
func (c BlendConfig) Has(ref string) bool {
	return slices.ContainsFunc(c.Sources, func(s Source) bool { return s.Ref == ref })
}

// Primary is the source with the most weight.
func (c BlendConfig) Primary() string {
	best := Source{Weight: -1}
	for _, s := range c.Sources {
		if s.Weight > best.Weight {
			best = s
		}
	}
	return best.Ref
}

// Describe names the blend for people: "Hyperliquid xyz:GOOGL", or with more sources
// "Hyperliquid xyz:GOOGL + Kraken GOOGLx/USD".
func (c BlendConfig) Describe() string {
	var names []string
	for _, s := range c.Sources {
		if s.Weight > 0 {
			names = append(names, Describe(s.Ref))
		}
	}
	return strings.Join(names, " + ")
}

// SourceView is one source in a blend right now.
type SourceView struct {
	Ref        string          `json:"ref"`
	Name       string          `json:"name"`
	Weight     float64         `json:"weight"`
	Multiplier decimal.Decimal `json:"multiplier"`
	// As the source quotes them.
	Bid *decimal.Decimal `json:"bid"`
	Ask *decimal.Decimal `json:"ask"`
	Mid *decimal.Decimal `json:"mid"`
	// Adjusted is the mid times the multiplier: the price of one share by this source.
	Adjusted  *decimal.Decimal `json:"adjusted"`
	SpreadBps *float64         `json:"spreadBps"`
	DepthUSD  *decimal.Decimal `json:"depthUsd"` // the smaller side at the touch, in dollars
	AgeMs     *int64           `json:"ageMs"`    // since the price last changed
	// Share is this source's part of the blended price, 0 to 1 (0 when it's left out).
	Share float64 `json:"share"`
	// GapBps is how far the adjusted price sits from the other sources.
	GapBps *float64 `json:"gapBps"`
	// State: in (part of the price), watch (weight 0: checked, not used), waiting (no price yet),
	// stale, or out (too far from the others).
	State  string           `json:"state"`
	Note   string           `json:"note,omitempty"`
	Action *CorporateAction `json:"action,omitempty"`
}

// CorporateAction is what a source's price ratio to the others suggests happened.
type CorporateAction struct {
	// Kind: split (the source trades a whole multiple of the others), multiplier (out of line by
	// some other ratio), or drift (in use, but persistently a little away).
	Kind  string  `json:"kind"`
	Ratio float64 `json:"ratio"` // this source's adjusted price over the others'
	// Multiplier is what this source's multiplier would be to line it up with the others.
	Multiplier decimal.Decimal `json:"multiplier"`
	Text       string          `json:"text"`
}

// BlendView is a blend evaluated: every source, and the price they make.
type BlendView struct {
	Sources         []SourceView     `json:"sources"`
	Weighting       string           `json:"weighting"`
	MaxDeviationBps float64          `json:"maxDeviationBps"`
	TokenMultiplier decimal.Decimal  `json:"tokenMultiplier"`
	PerShare        *decimal.Decimal `json:"perShare"` // blended, before the token multiplier
	// The book's fair value: per share times the token multiplier.
	Mid *decimal.Decimal `json:"mid"`
	Bid *decimal.Decimal `json:"bid"`
	Ask *decimal.Decimal `json:"ask"`
	// Used is how many sources make up the price.
	Used int `json:"used"`
	// Problem says why there's no price ("" if there is one).
	Problem string `json:"problem,omitempty"`
	// Of the sources in use: when the price last changed, and when any of them last spoke.
	Time time.Time `json:"-"`
	Seen time.Time `json:"-"`
	// Size at the touch, in tokens of the book (for the paper exchange's simulated book).
	BidSize decimal.Decimal `json:"-"`
	AskSize decimal.Decimal `json:"-"`
}

// Tick is the blended price as one tick, or false if there's no price.
func (v BlendView) Tick(name string, heartbeat bool) (Tick, bool) {
	if v.Mid == nil {
		return Tick{}, false
	}
	return Tick{Reference: name, Mid: *v.Mid, Bid: *v.Bid, Ask: *v.Ask, BidSize: v.BidSize, AskSize: v.AskSize,
		Time: v.Time, Seen: v.Seen, Heartbeat: heartbeat}, true
}

// Evaluate works out the blend from the latest tick of each source. maxAge is how long a source
// may go silent before it's left out.
func Evaluate(c BlendConfig, ticks map[string]Tick, now time.Time, maxAge time.Duration) BlendView {
	v := BlendView{Weighting: c.Weighting, MaxDeviationBps: c.MaxDeviationBps, TokenMultiplier: c.TokenMultiplier}
	type row struct {
		view  *SourceView
		tick  Tick
		adj   float64
		depth float64
	}
	var rows []*row
	v.Sources = make([]SourceView, len(c.Sources))
	for i, s := range c.Sources {
		v.Sources[i] = SourceView{Ref: s.Ref, Name: Describe(s.Ref), Weight: s.Weight, Multiplier: s.Multiplier, State: "waiting", Note: "no price yet"}
		t, ok := ticks[s.Ref]
		if !ok || !t.Mid.IsPositive() {
			continue
		}
		view := &v.Sources[i]
		bid, ask, mid := t.Bid, t.Ask, t.Mid
		adj := mid.Mul(s.Multiplier)
		age := now.Sub(t.Time).Milliseconds()
		view.Bid, view.Ask, view.Mid, view.Adjusted, view.AgeMs = &bid, &ask, &mid, &adj, &age
		if bid.IsPositive() && ask.GreaterThanOrEqual(bid) {
			sp := ask.Sub(bid).Div(mid).Mul(decimal.NewFromInt(10_000)).InexactFloat64()
			view.SpreadBps = &sp
		}
		depth := 0.0
		if t.BidSize.IsPositive() && t.AskSize.IsPositive() {
			dd := decimal.Min(t.BidSize.Mul(bid), t.AskSize.Mul(ask))
			view.DepthUSD = &dd
			depth = dd.InexactFloat64()
		}
		switch {
		case now.Sub(t.Seen) > maxAge:
			view.State, view.Note = "stale", fmt.Sprintf("silent for %s", now.Sub(t.Seen).Round(100*time.Millisecond))
			continue
		case now.Sub(t.Time) > maxPriceAge:
			view.State, view.Note = "stale", fmt.Sprintf("price unchanged for %s (market closed?)", now.Sub(t.Time).Round(time.Second))
			continue
		}
		view.State, view.Note = "in", ""
		if s.Weight == 0 {
			view.State = "watch"
		}
		rows = append(rows, &row{view: view, tick: t, adj: adj.InexactFloat64(), depth: depth})
	}

	// Each source is measured against the ones in use: with two, against the other; with more,
	// against their median, so one bad source can't drag the yardstick.
	var inUse []*row
	for _, r := range rows {
		if r.view.State == "in" {
			inUse = append(inUse, r)
		}
	}
	yardstick := func(r *row) (float64, bool) {
		var others []float64
		for _, o := range inUse {
			if o != r || len(inUse) >= 3 {
				others = append(others, o.adj)
			}
		}
		if len(others) == 0 {
			return 0, false // the only source in use: nothing to compare it with
		}
		return median(others), true
	}
	for _, r := range rows {
		ref, ok := yardstick(r)
		if !ok || ref <= 0 {
			continue
		}
		ratio := r.adj / ref
		gap := (ratio - 1) * 10_000
		r.view.GapBps = &gap
		out := math.Abs(gap) > c.MaxDeviationBps
		if out && r.view.State == "in" {
			r.view.State = "out"
		}
		if a := corporateAction(ratio, gap, out, r.view.Multiplier); a != nil {
			r.view.Action = a
			if out {
				r.view.Note = a.Text
			}
		}
	}

	// Weights, over the sources still in.
	var used []*row
	for _, r := range rows {
		if r.view.State == "in" {
			used = append(used, r)
		}
	}
	weights := make([]float64, len(used))
	if c.Weighting == WeightDepth {
		// A source that shows no depth counts as the average of the ones that do.
		var sum float64
		var n int
		for _, r := range used {
			if r.depth > 0 {
				sum += r.depth
				n++
			}
		}
		avg := 1.0
		if n > 0 {
			avg = sum / float64(n)
		}
		for i, r := range used {
			d := r.depth
			if d <= 0 {
				d = avg
			}
			weights[i] = r.view.Weight * d
		}
	} else {
		for i, r := range used {
			weights[i] = r.view.Weight
		}
	}
	var total float64
	for _, w := range weights {
		total += w
	}
	if len(used) == 0 || total <= 0 {
		v.Problem = blendProblem(v.Sources)
		return v
	}
	var mid, bid, ask, bidSize, askSize decimal.Decimal
	for i, r := range used {
		share := weights[i] / total
		r.view.Share = share
		w := decimal.NewFromFloat(share)
		m := r.view.Multiplier
		mid = mid.Add(r.tick.Mid.Mul(m).Mul(w))
		bid = bid.Add(r.tick.Bid.Mul(m).Mul(w))
		ask = ask.Add(r.tick.Ask.Mul(m).Mul(w))
		// Sizes are in the source's units; Multiplier of them make one share.
		bidSize = bidSize.Add(r.tick.BidSize.Div(m))
		askSize = askSize.Add(r.tick.AskSize.Div(m))
		if r.tick.Time.After(v.Time) {
			v.Time = r.tick.Time
		}
		if r.tick.Seen.After(v.Seen) {
			v.Seen = r.tick.Seen
		}
	}
	tm := c.TokenMultiplier
	perShare := mid.Round(8)
	fair, fb, fa := mid.Mul(tm).Round(8), bid.Mul(tm).Round(8), ask.Mul(tm).Round(8)
	v.PerShare, v.Mid, v.Bid, v.Ask, v.Used = &perShare, &fair, &fb, &fa, len(used)
	v.BidSize, v.AskSize = bidSize.Div(tm), askSize.Div(tm)
	return v
}

func blendProblem(sources []SourceView) string {
	var out, stale, waiting int
	for _, s := range sources {
		if s.Weight == 0 {
			continue
		}
		switch s.State {
		case "out":
			out++
		case "stale":
			stale++
		case "waiting":
			waiting++
		}
	}
	switch {
	case out > 0:
		return "the reference sources disagree beyond the max deviation; check them for a corporate action or a bad price"
	case stale > 0 && waiting == 0:
		return "every reference source is stale"
	case stale > 0:
		return "the reference sources are stale or not priced yet"
	}
	return "waiting for the reference sources"
}

// Ratios that a split (or a reverse split) moves a price by.
var splitRatios = []float64{1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100}

// corporateAction reads a source's price ratio to the others. out says it's beyond the max
// deviation; in range, only a persistent drift is worth a note.
func corporateAction(ratio, gap float64, out bool, mult decimal.Decimal) *CorporateAction {
	if ratio <= 0 {
		return nil
	}
	lineUp := func(r float64) decimal.Decimal {
		return mult.Div(decimal.NewFromFloat(r)).Round(6)
	}
	if out {
		for _, k := range splitRatios {
			switch {
			case math.Abs(ratio/k-1) < 0.03:
				return &CorporateAction{Kind: "split", Ratio: ratio, Multiplier: lineUp(k),
					Text: fmt.Sprintf("trades about %s× the others: a %s-for-1 split the others reflect and this source doesn't (or a reverse split the other way). Multiplier %s lines it up", ratioText(k), ratioText(k), lineUp(k))}
			case math.Abs(ratio*k-1) < 0.03:
				return &CorporateAction{Kind: "split", Ratio: ratio, Multiplier: lineUp(1 / k),
					Text: fmt.Sprintf("trades about 1/%s of the others: a %s-for-1 split this source reflects and the others don't (or a reverse split the other way). Multiplier %s lines it up", ratioText(k), ratioText(k), lineUp(1/k))}
			}
		}
		return &CorporateAction{Kind: "multiplier", Ratio: ratio, Multiplier: lineUp(ratio),
			Text: fmt.Sprintf("%+.0f bps from the others: a share multiplier (dividends paid as shares, a token that isn't one share), a corporate action one side hasn't applied, or a bad price. Multiplier %s lines it up", gap, lineUp(ratio))}
	}
	if math.Abs(gap) >= driftBps {
		return &CorporateAction{Kind: "drift", Ratio: ratio, Multiplier: lineUp(ratio),
			Text: fmt.Sprintf("%+.0f bps from the others: normal for a perp's funding premium; if it holds for days, a multiplier of %s would line it up", gap, lineUp(ratio))}
	}
	return nil
}

func ratioText(k float64) string {
	if k == math.Trunc(k) {
		return fmt.Sprintf("%.0f", k)
	}
	return fmt.Sprintf("%g", k)
}

func median(xs []float64) float64 {
	s := slices.Clone(xs)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
