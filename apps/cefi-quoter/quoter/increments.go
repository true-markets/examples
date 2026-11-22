package quoter

import "github.com/shopspring/decimal"

// Increments are the exchange's minimum steps, which depend on the price: the tick (price step),
// the lot (quantity step) and the minimum notional. The exchange doesn't publish these in its API,
// so they are kept here, from its table. A price belongs to the first bucket whose lower bound it
// reaches.
type Increments struct {
	Tick        decimal.Decimal
	Lot         decimal.Decimal
	MinNotional decimal.Decimal
}

type bucket struct {
	minPrice float64
	tick     string
	lot      string
}

var buckets = []bucket{
	{500_000, "1", "0.000001"},
	{100_000, "0.5", "0.00001"},
	{10_000, "0.1", "0.0001"},
	{1_000, "0.01", "0.001"},
	// The table gives a 0.01 lot here, but the live exchange accepts 0.001.
	{10, "0.001", "0.001"},
	{0.1, "0.0001", "1"},
	{0.001, "0.000001", "100"},
	{0.00001, "0.00000001", "10000"},
	{0, "0.0000000001", "1000000"},
}

var one = decimal.NewFromInt(1)

func IncrementsFor(price decimal.Decimal) Increments {
	p := price.InexactFloat64()
	b := buckets[len(buckets)-1]
	for _, x := range buckets {
		if p >= x.minPrice {
			b = x
			break
		}
	}
	return Increments{Tick: decimal.RequireFromString(b.tick), Lot: decimal.RequireFromString(b.lot), MinNotional: one}
}

// FormatBid rounds a bid's price DOWN to the tick (never pay more than asked) and its size DOWN
// to the lot. Returns a zero size if what's left is under the minimum notional: a level that
// can't meet the minimum is skipped rather than made bigger than its budget.
func FormatBid(price, size decimal.Decimal) (decimal.Decimal, decimal.Decimal) {
	inc := IncrementsFor(price)
	p := price.Div(inc.Tick).Floor().Mul(inc.Tick)
	return p, formatSize(p, size, inc)
}

// FormatAsk rounds an ask's price UP to the tick and its size DOWN to the lot.
func FormatAsk(price, size decimal.Decimal) (decimal.Decimal, decimal.Decimal) {
	inc := IncrementsFor(price)
	p := price.Div(inc.Tick).Ceil().Mul(inc.Tick)
	return p, formatSize(p, size, inc)
}

func formatSize(price, size decimal.Decimal, inc Increments) decimal.Decimal {
	if !price.IsPositive() {
		return decimal.Zero
	}
	s := size.Div(inc.Lot).Floor().Mul(inc.Lot)
	if s.Mul(price).LessThan(inc.MinNotional) {
		return decimal.Zero
	}
	return s
}

// MinSize is the smallest size that meets the minimum notional at this price.
func MinSize(price decimal.Decimal) decimal.Decimal {
	inc := IncrementsFor(price)
	if !price.IsPositive() {
		return decimal.Zero
	}
	return inc.MinNotional.Div(price).Div(inc.Lot).Ceil().Mul(inc.Lot)
}
