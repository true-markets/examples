package quoter

import "github.com/shopspring/decimal"

// Taking: crossing the spread with an IOC order instead of waiting on the ladder to be filled.
//
// A maker that only ever rests orders gets stuck: once a move fills one side up to the max
// position change, that side stops quoting, and the position only comes back when someone trades
// against the other side's quotes. Two takers, ported from the internal Python quoter, cross when
// the exchange's book pays for it:
//
//   - The profit taker closes inventory: it sells into the best bid while long, or buys the best
//     ask while short. The edge it needs falls from takeEdgeBps toward takeFlattenFloorBps as the
//     position nears the max position change, so a full book gets out more readily. It never
//     closes below what the position cost (after the taker fee): getting flat isn't worth booking
//     a loss, so an underwater position is left for the ladder's quotes to work off.
//   - Takeout builds inventory: it crosses when the book sits at least takeEdgeBps past fair value,
//     betting the dislocation closes. Past half the max position change it needs more edge and
//     takes less, and it stops at 90%, leaving the rest of the room for the ladder and for getting
//     out. Off by default.
//
// Edge is always measured against the skewed mid (fair value, leaning toward flat), net of the
// taker fee, and only against other people's orders: our own resting quotes at the best price are
// subtracted, so a take never trades with ourselves.

// Takeout's taper, from the Python quoter's defaults.
const (
	takeBuildSoftCap    = 0.5 // of the max position change: takeout starts needing more edge
	takeBuildStop       = 0.9 // takeout stops here
	takeBuildPenaltyBps = 30  // extra edge needed at the stop, rising from 0 at the soft cap
)

// TakeKind says which taker decided a take.
type TakeKind string

const (
	ProfitTake TakeKind = "profit take"
	Takeout    TakeKind = "takeout"
)

// takeInput is what one take decision depends on. Sizes are in the base asset.
type takeInput struct {
	Params    Params          // in base units (Params.InBase)
	Mid       decimal.Decimal // the skewed mid
	Position  decimal.Decimal // bought minus sold since start
	AvgCost   decimal.Decimal // of the open position
	BestBid   *decimal.Decimal
	BestAsk   *decimal.Decimal
	BidQty    decimal.Decimal // at the best bid, ours excluded
	AskQty    decimal.Decimal // at the best ask, ours excluded
	FreeBase  decimal.Decimal
	FreeQuote decimal.Decimal
}

// takeDecision is one take: an IOC at Price for Qty.
type takeDecision struct {
	Kind    TakeKind
	Side    Side
	Price   decimal.Decimal
	Qty     decimal.Decimal
	EdgeBps float64
	// Unfunded: a profit take had the edge but nothing free to trade with, because our own
	// quotes on that side hold it all. The engine frees some by pulling one quote first.
	Unfunded bool
}

// TakeSide is how close one side is to a take, for the management screen: the price a take would
// cross to, the edge it offers now, the edge it needs, and what (if anything) stands in the way.
type TakeSide struct {
	Side         Side             `json:"side"` // BUY takes the best ask; SELL hits the best bid
	Kind         TakeKind         `json:"kind"` // which taker this side belongs to right now
	Enabled      bool             `json:"enabled"`
	Price        *decimal.Decimal `json:"price"`        // the best price on the other side, or nil if empty
	Qty          decimal.Decimal  `json:"qty"`          // shown there by other people (ours excluded)
	EdgeBps      *float64         `json:"edgeBps"`      // net edge over the skewed mid, after the fee
	ThresholdBps float64          `json:"thresholdBps"` // what it needs
	Size         decimal.Decimal  `json:"size"`         // what a take would send now
	// Blocker is why it isn't taking ("" means it would): off, nothing to take, no edge, below
	// cost, at the limit, too small, no funds (it pulls a quote first), and from the engine,
	// cool-down, take in flight, not quoting.
	Blocker string `json:"blocker,omitempty"`
}

// TakeView is both sides.
type TakeView struct {
	Buy  TakeSide `json:"buy"`
	Sell TakeSide `json:"sell"`
}

// evaluateTakes works out both sides, and the take to send (or nil).
func evaluateTakes(in takeInput) (TakeView, *takeDecision) {
	view := TakeView{Buy: evaluateSide(in, Buy, in.BestAsk, in.AskQty), Sell: evaluateSide(in, Sell, in.BestBid, in.BidQty)}
	var best *takeDecision
	for _, ts := range []TakeSide{view.Buy, view.Sell} {
		if ts.Blocker != "" && ts.Blocker != blockedNoFunds {
			continue
		}
		d := &takeDecision{Kind: ts.Kind, Side: ts.Side, Price: *ts.Price, Qty: ts.Size, EdgeBps: *ts.EdgeBps, Unfunded: ts.Blocker == blockedNoFunds}
		// A profit take beats a takeout; otherwise the bigger edge wins.
		if best == nil || (d.Kind == ProfitTake && best.Kind != ProfitTake) || (d.Kind == best.Kind && d.EdgeBps > best.EdgeBps) {
			best = d
		}
	}
	return view, best
}

// decideTake picks the best take this cycle, or nil.
func decideTake(in takeInput) *takeDecision {
	_, d := evaluateTakes(in)
	return d
}

const blockedNoFunds = "no funds (pulls a quote first)"

func evaluateSide(in takeInput, side Side, price *decimal.Decimal, extQty decimal.Decimal) TakeSide {
	p := in.Params
	flatten := isFlatten(side, in.Position)
	ts := TakeSide{Side: side, Kind: Takeout, Enabled: p.Takeout, Price: price, Qty: extQty, ThresholdBps: takeThreshold(p, side, in.Position)}
	if flatten {
		ts.Kind, ts.Enabled = ProfitTake, p.ProfitTaker
	}
	if price != nil && in.Mid.IsPositive() {
		// Net edge in bps: what crossing at this price gains over fair value, after the fee.
		gain := in.Mid.Sub(*price)
		if side == Sell {
			gain = price.Sub(in.Mid)
		}
		edge := gain.Div(in.Mid).Mul(tenK).InexactFloat64() - p.TakerFeeBps
		ts.EdgeBps = &edge
	}
	switch {
	case !ts.Enabled:
		ts.Blocker = "off"
	case price == nil || !extQty.IsPositive() || ts.EdgeBps == nil:
		ts.Blocker = "nothing to take"
	case *ts.EdgeBps < ts.ThresholdBps:
		ts.Blocker = "no edge"
	case flatten && !clearsBasis(side, *price, in.AvgCost, p.TakerFeeBps):
		ts.Blocker = "below cost"
	default:
		qty, why := sizeTake(p, side, *price, extQty, in)
		ts.Size, ts.Blocker = qty, why
	}
	return ts
}

// isFlatten reports a take that shrinks the position: a sell while long, a buy while short.
func isFlatten(side Side, position decimal.Decimal) bool {
	return (side == Sell && position.IsPositive()) || (side == Buy && position.IsNegative())
}

// utilization is how much of the max position change the position uses, 0 to 1. Zero when the
// limit is off.
func utilization(p Params, position decimal.Decimal) float64 {
	if !p.MaxPosition.IsPositive() {
		return 0
	}
	return min(position.Abs().Div(p.MaxPosition).InexactFloat64(), 1)
}

// takeThreshold is the net edge a take on this side needs. A profit take's falls from the take
// edge to the flatten floor as the position fills up; a takeout's rises past the soft cap.
func takeThreshold(p Params, side Side, position decimal.Decimal) float64 {
	if isFlatten(side, position) {
		floor := min(p.TakeFlattenFloorBps, p.TakeEdgeBps)
		return p.TakeEdgeBps - utilization(p, position)*(p.TakeEdgeBps-floor)
	}
	return p.TakeEdgeBps + buildPressure(p, position)*takeBuildPenaltyBps
}

// buildPressure is 0 below the soft cap, 1 at the stop, and linear between.
func buildPressure(p Params, position decimal.Decimal) float64 {
	u := utilization(p, position)
	switch {
	case u <= takeBuildSoftCap:
		return 0
	case u >= takeBuildStop:
		return 1
	}
	return (u - takeBuildSoftCap) / (takeBuildStop - takeBuildSoftCap)
}

// clearsBasis reports whether closing at price breaks even on the position's cost after the fee.
// Selling exactly at cost is a loss once the fee is paid, so it's refused.
func clearsBasis(side Side, price, avgCost decimal.Decimal, feeBps float64) bool {
	if !avgCost.IsPositive() {
		return false // no cost we observed, so no profit we can show
	}
	fee := avgCost.Mul(decimal.NewFromFloat(feeBps)).Div(tenK)
	if side == Sell {
		return price.GreaterThanOrEqual(avgCost.Add(fee))
	}
	return price.LessThanOrEqual(avgCost.Sub(fee))
}

// sizeTake is the take's size: the least of what the book shows, the max take size (tapered for
// takeout), the room under the position limit, and what's free to trade with, on the lot. A
// profit take stops at flat. why says what made it zero.
func sizeTake(p Params, side Side, price, extQty decimal.Decimal, in takeInput) (qty decimal.Decimal, why string) {
	if !p.TakeMaxSize.IsPositive() {
		return decimal.Zero, "too small"
	}
	flatten := isFlatten(side, in.Position)
	limit := p.TakeMaxSize
	var room decimal.Decimal
	if flatten {
		room = in.Position.Abs()
	} else {
		limit = limit.Mul(decimal.NewFromFloat(1 - buildPressure(p, in.Position)))
		room = extQty // no limit set: only the book and the funds bound it
		if p.MaxPosition.IsPositive() {
			stop := p.MaxPosition.Mul(decimal.NewFromFloat(takeBuildStop))
			if side == Buy {
				room = stop.Sub(in.Position)
			} else {
				room = stop.Add(in.Position)
			}
		}
	}
	if !room.IsPositive() {
		return decimal.Zero, "at the limit"
	}
	funds := in.FreeBase
	if side == Buy {
		funds = in.FreeQuote.Mul(feeHeadroom).Div(price)
	}
	inc := IncrementsFor(price)
	want := formatSize(price, decimal.Min(extQty, limit, room), inc)
	if !want.IsPositive() {
		return decimal.Zero, "too small"
	}
	qty = formatSize(price, decimal.Min(want, funds), inc)
	if qty.IsPositive() {
		return qty, ""
	}
	if flatten {
		return decimal.Zero, blockedNoFunds
	}
	return decimal.Zero, "no funds"
}
