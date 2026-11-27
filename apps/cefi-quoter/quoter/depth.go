package quoter

import (
	"sort"
	"strconv"

	"github.com/shopspring/decimal"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// depthBook is one book's DEPTH feed: a snapshot, then the levels that change, in sequence.
type depthBook struct {
	bids, asks map[string]depthLevel // by canonical price
	lastSeq    int64
	ok         bool // a snapshot has come in, and no update has been missed since
}

type depthLevel struct {
	price, qty decimal.Decimal
}

func newDepthBook() *depthBook {
	return &depthBook{bids: map[string]depthLevel{}, asks: map[string]depthLevel{}}
}

// apply takes one DEPTH message. It returns false when an update skipped a sequence number: the
// book is then unusable until the next snapshot, and the caller should ask for one.
func (b *depthBook) apply(update string, d tm.Depth, seqnum string) bool {
	seq, hasSeq := int64(0), false
	if n, err := strconv.ParseInt(seqnum, 10, 64); err == nil {
		seq, hasSeq = n, true
	}
	switch {
	case update == "SNAPSHOT":
		b.bids, b.asks, b.ok = map[string]depthLevel{}, map[string]depthLevel{}, true
	case !b.ok:
		return true // waiting for a snapshot; nothing to apply an update to
	case hasSeq && b.lastSeq != 0 && seq > b.lastSeq+1:
		// Only a jump forward is a gap: the first update after a snapshot carries the snapshot's
		// own seqnum, and levels are absolute sizes, so applying one twice is harmless.
		b.ok = false
		return false
	}
	if hasSeq && (seq > b.lastSeq || update == "SNAPSHOT") {
		b.lastSeq = seq
	}
	applyLevels(b.bids, d.Bids)
	applyLevels(b.asks, d.Asks)
	return true
}

func applyLevels(side map[string]depthLevel, levels []tm.Level) {
	for _, l := range levels {
		p, err := decimal.NewFromString(l.Price)
		if err != nil {
			continue
		}
		q, _ := decimal.NewFromString(l.Qty)
		key := p.String()
		if !q.IsPositive() {
			delete(side, key)
			continue
		}
		side[key] = depthLevel{price: p, qty: q}
	}
}

// levels returns one side best first: highest bid, lowest ask.
func (b *depthBook) levels(side Side) []depthLevel {
	m := b.bids
	if side == Sell {
		m = b.asks
	}
	out := make([]depthLevel, 0, len(m))
	for _, l := range m {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool {
		if side == Sell {
			return out[i].price.LessThan(out[j].price)
		}
		return out[i].price.GreaterThan(out[j].price)
	})
	return out
}

// Exit is what closing the book's position would come to now against the exchange's book:
// selling a long into the bids, buying a short back from the asks, level by level, leaving out
// the book's own resting orders.
type Exit struct {
	Price  decimal.Decimal `json:"price"`  // the average price, over what the book could take
	Qty    decimal.Decimal `json:"qty"`    // how much of the position the book could close; less than it when the book is thin
	Value  decimal.Decimal `json:"value"`  // quote currency in (long) or out (short)
	Pnl    decimal.Decimal `json:"pnl"`    // against the average cost, on the qty closed
	Levels int             `json:"levels"` // price levels it would reach
	// Source is "depth" for the full book, or "top" when only the best bid and ask are known (no
	// depth yet, or a gap waiting for a fresh snapshot).
	Source string `json:"source"`
}

// exitAgainst walks levels (best first) for qty, skipping what the book itself rests at each
// price, and prices it against avgCost. ok is false when there's nothing to take.
func exitAgainst(levels []depthLevel, own map[string]decimal.Decimal, qty, avgCost decimal.Decimal, long bool) (Exit, bool) {
	var x Exit
	left := qty
	for _, l := range levels {
		if !left.IsPositive() {
			break
		}
		avail := l.qty.Sub(own[l.price.String()])
		if !avail.IsPositive() {
			continue
		}
		take := decimal.Min(avail, left)
		x.Qty = x.Qty.Add(take)
		x.Value = x.Value.Add(take.Mul(l.price))
		x.Levels++
		left = left.Sub(take)
	}
	if !x.Qty.IsPositive() {
		return Exit{}, false
	}
	x.Price = x.Value.Div(x.Qty)
	x.Pnl = x.Price.Sub(avgCost).Mul(x.Qty)
	if !long {
		x.Pnl = x.Pnl.Neg()
	}
	return x, true
}
