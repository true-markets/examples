package quoter

import (
	"sort"

	"github.com/shopspring/decimal"
)

// Step is one request the quote loop will send.
type Step struct {
	Kind       Action
	ExternalID string // modify and cancel
	Side       Side
	Level      int
	Price      decimal.Decimal // create and modify
	Qty        decimal.Decimal // create: size; modify: the order's new TOTAL quantity
	Reason     string

	group   int // send order, see Plan
	outward bool
}

// PlanInput is what reconciling needs: the targets, our orders, and the exchange's best bid and
// ask (nil when that side of the book is empty).
type PlanInput struct {
	Bids, Asks   []Target
	Orders       []Order
	BestBid      *decimal.Decimal
	BestAsk      *decimal.Decimal
	ThresholdBps float64
	// CoolingDown reports a level that was just rejected, so we don't re-create it every cycle.
	CoolingDown func(Side, int) bool
}

// Plan works out the fewest requests that turn our orders into the targets.
//
// It prefers modifying an order in place to canceling it and placing a new one. A modify keeps
// the order's funds held the whole time: the exchange re-sizes the hold in place. Cancel-then-new
// releases the hold and then needs it back, and between the two there's a window where the funds
// are neither here nor there. When you're quoting with nearly all of your balance, the new order
// in that window gets rejected for insufficient balance. A modify also does in one request and
// one drop copy what cancel-new does in two of each.
//
// The order of the requests matters too. Steps go out in this order:
//
//  0. cancels: free funds and stop quoting what we no longer want
//  1. modifies that hold the same or less: a bid moving down or shrinking, any ask move that
//     doesn't grow it
//  2. modifies that hold more
//  3. creates
//
// so every request that needs funds comes after the ones that release them ("release before
// you reserve"). Within each group, moves away from the spread go before moves toward it.
//
// Every price is clamped so we never cross our own orders on the other side, or the exchange's
// best price on the other side. Our quotes are post-only, so a crossing price would only be
// rejected; clamping avoids the wasted round trip.
func Plan(in PlanInput) []Step {
	var steps []Step
	ceiling, floor := clampLimits(in)

	for _, side := range []Side{Buy, Sell} {
		targets := in.Bids
		if side == Sell {
			targets = in.Asks
		}
		wanted := map[int]Target{}
		for _, t := range targets {
			wanted[t.Level] = t
		}

		// One order per level. Orders on levels we no longer want, and any second order on a level,
		// are canceled. Of two on one level, keep the one with a request out (it can't be touched).
		byLevel := map[int]Order{}
		cancel := func(o Order) {
			if o.InFlight == None {
				steps = append(steps, Step{Kind: Cancel, ExternalID: o.ExternalID, Side: side, Level: o.Level, Reason: "level no longer wanted", group: 0})
			}
		}
		for _, o := range in.Orders {
			if o.Side != side {
				continue
			}
			if _, ok := wanted[o.Level]; !ok {
				cancel(o)
				continue
			}
			prev, dup := byLevel[o.Level]
			if !dup {
				byLevel[o.Level] = o
			} else if prev.InFlight == None && o.InFlight != None {
				byLevel[o.Level] = o
				cancel(prev)
			} else {
				cancel(o)
			}
		}

		for _, t := range targets {
			price, qty, ok := clampTarget(t, ceiling, floor)
			if !ok {
				continue
			}
			o, exists := byLevel[t.Level]
			if !exists {
				if in.CoolingDown != nil && in.CoolingDown(side, t.Level) {
					continue
				}
				steps = append(steps, Step{Kind: Create, Side: side, Level: t.Level, Price: price, Qty: qty, group: 3})
				continue
			}
			if o.InFlight != None {
				continue // wait for the answer to the request already out
			}
			current := o.EffectivePrice()
			move := !price.Equal(current) && bpsBetween(current, price) >= in.ThresholdBps
			// The exchange takes a modify's quantity as the order's new total, filled part
			// included, so to rest `qty` we ask for qty + executed.
			newTotal := qty.Add(o.Executed)
			resize := !newTotal.Equal(o.Qty)
			if !move && !resize {
				continue
			}
			newPrice := current
			if move {
				newPrice = price
			}
			newHold := qty
			if side == Buy {
				newHold = qty.Mul(newPrice)
			}
			group := 1
			if newHold.GreaterThan(o.Hold()) {
				group = 2
			}
			outward := (side == Buy && newPrice.LessThan(current)) || (side == Sell && newPrice.GreaterThan(current))
			steps = append(steps, Step{Kind: Modify, ExternalID: o.ExternalID, Side: side, Level: t.Level, Price: newPrice, Qty: newTotal, group: group, outward: outward})
		}
	}

	sort.SliceStable(steps, func(i, j int) bool {
		if steps[i].group != steps[j].group {
			return steps[i].group < steps[j].group
		}
		return steps[i].outward && !steps[j].outward
	})
	return steps
}

// clampLimits finds the highest a bid may go and the lowest an ask may go: one tick inside our own
// nearest order on the other side (at the price it rests at or is moving to), and one tick inside
// the exchange's best price on the other side.
func clampLimits(in PlanInput) (ceiling, floor *decimal.Decimal) {
	lower := func(cur *decimal.Decimal, v decimal.Decimal) *decimal.Decimal {
		if cur == nil || v.LessThan(*cur) {
			return &v
		}
		return cur
	}
	higher := func(cur *decimal.Decimal, v decimal.Decimal) *decimal.Decimal {
		if cur == nil || v.GreaterThan(*cur) {
			return &v
		}
		return cur
	}
	for _, o := range in.Orders {
		p := o.EffectivePrice()
		tick := IncrementsFor(p).Tick
		if o.Side == Sell {
			ceiling = lower(ceiling, p.Sub(tick))
		} else {
			floor = higher(floor, p.Add(tick))
		}
	}
	if in.BestAsk != nil {
		ceiling = lower(ceiling, in.BestAsk.Sub(IncrementsFor(*in.BestAsk).Tick))
	}
	if in.BestBid != nil {
		floor = higher(floor, in.BestBid.Add(IncrementsFor(*in.BestBid).Tick))
	}
	return ceiling, floor
}

func clampTarget(t Target, ceiling, floor *decimal.Decimal) (decimal.Decimal, decimal.Decimal, bool) {
	price := t.Price
	if t.Side == Buy && ceiling != nil && price.GreaterThan(*ceiling) {
		price = *ceiling
	}
	if t.Side == Sell && floor != nil && price.LessThan(*floor) {
		price = *floor
	}
	if price.Equal(t.Price) {
		return price, t.Qty, true
	}
	// A clamped price has to land on a tick again, and the size has to meet the minimum there.
	var qty decimal.Decimal
	if t.Side == Buy {
		price, qty = FormatBid(price, t.Qty)
	} else {
		price, qty = FormatAsk(price, t.Qty)
	}
	return price, qty, price.IsPositive() && qty.IsPositive()
}

func bpsBetween(a, b decimal.Decimal) float64 {
	if !a.IsPositive() {
		return 1e9
	}
	return b.Sub(a).Abs().Div(a).Mul(tenK).InexactFloat64()
}
