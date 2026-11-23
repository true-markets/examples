package quoter

import (
	"math"

	"github.com/shopspring/decimal"
)

// Target is one order the strategy wants resting: a side, a level (0 is the innermost), a price
// and a size. Size is what should rest, not counting anything already filled.
type Target struct {
	Side  Side            `json:"side"`
	Level int             `json:"level"`
	Price decimal.Decimal `json:"price"`
	Qty   decimal.Decimal `json:"qty"`
}

// LadderInput is everything the ladder depends on for one cycle.
type LadderInput struct {
	Reference   decimal.Decimal // fair value, from the reference feed
	Params      Params
	Position    decimal.Decimal // base bought minus base sold since start
	BudgetQuote decimal.Decimal // quote the bids may hold in total
	BudgetBase  decimal.Decimal // base the asks may hold in total
}

// Ladder is the target book for one cycle.
type Ladder struct {
	Mid     decimal.Decimal // the reference after inventory skew
	SkewBps float64
	Bids    []Target
	Asks    []Target
}

var tenK = decimal.NewFromInt(10_000)

// BuildLadder turns the reference price into a ladder of bids and asks.
//
//  1. Skew: when we hold inventory, shift the mid toward getting flat. Long means a lower mid,
//     so our asks get hit more readily and our bids less. Scaled by position / maxPosition (the max position change).
//  2. Levels: level i sits spreadBps × levelSpreadMult^i from the mid, sized
//     quoteSize × levelSizeMult^i.
//  3. Caps, inside out, so the inner levels get funded first: stop a side when its position
//     limit or its budget runs out.
func BuildLadder(in LadderInput) Ladder {
	p := in.Params
	out := Ladder{Mid: in.Reference}
	if !in.Reference.IsPositive() {
		return out
	}
	if p.MaxPosition.IsPositive() && p.SkewBps > 0 {
		ratio := in.Position.Div(p.MaxPosition).InexactFloat64()
		ratio = math.Max(-1, math.Min(1, ratio))
		out.SkewBps = p.SkewBps * ratio
		out.Mid = in.Reference.Mul(one.Sub(decimal.NewFromFloat(out.SkewBps).Div(tenK)))
	}

	// How much more each side may add to the position before hitting the limit. A buy grows a
	// long; a sell grows a short.
	var buyRoom, sellRoom *decimal.Decimal
	if p.MaxPosition.IsPositive() {
		b := decimal.Max(p.MaxPosition.Sub(in.Position), decimal.Zero)
		s := decimal.Max(p.MaxPosition.Add(in.Position), decimal.Zero)
		buyRoom, sellRoom = &b, &s
	}

	out.Bids = buildSide(Buy, out.Mid, p, buyRoom, in.BudgetQuote)
	out.Asks = buildSide(Sell, out.Mid, p, sellRoom, in.BudgetBase)
	return out
}

func buildSide(side Side, mid decimal.Decimal, p Params, room *decimal.Decimal, budget decimal.Decimal) []Target {
	var out []Target
	usedSize := decimal.Zero  // toward the position limit
	usedFunds := decimal.Zero // toward the budget, in the budget's asset
	spread := p.SpreadBps
	size := p.QuoteSize
	format := FormatBid
	if side == Sell {
		format = FormatAsk
	}
	for level := 0; level < p.Levels; level++ {
		offset := decimal.NewFromFloat(spread).Div(tenK)
		raw := mid.Mul(one.Sub(offset))
		if side == Sell {
			raw = mid.Mul(one.Add(offset))
		}
		price, qty := format(raw, size)

		if room != nil {
			left := room.Sub(usedSize)
			if qty.GreaterThan(left) {
				_, qty = format(raw, left)
			}
		}
		// A bid ties up quote (price × qty); an ask ties up base (qty).
		cost := qty
		if side == Buy {
			cost = qty.Mul(price)
		}
		if usedFunds.Add(cost).GreaterThan(budget) {
			left := budget.Sub(usedFunds)
			if side == Buy && price.IsPositive() {
				left = left.Div(price)
			}
			_, qty = format(raw, decimal.Max(left, decimal.Zero))
			cost = qty
			if side == Buy {
				cost = qty.Mul(price)
			}
		}
		if !qty.IsPositive() {
			break
		}
		out = append(out, Target{Side: side, Level: level, Price: price, Qty: qty})
		usedSize = usedSize.Add(qty)
		usedFunds = usedFunds.Add(cost)
		spread *= p.LevelSpreadMult
		size = size.Mul(decimal.NewFromFloat(p.LevelSizeMult))
	}
	return out
}
