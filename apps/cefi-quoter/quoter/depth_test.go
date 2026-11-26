package quoter

import (
	"encoding/json"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

func lv(price, qty string) tm.Level { return tm.Level{Price: price, Qty: qty} }

// The depth book starts from a snapshot, applies updates (0 removes a level), and gives up on a
// skipped sequence number until the next snapshot.
func TestDepthBookFollowsTheFeed(t *testing.T) {
	b := newDepthBook()
	if !b.apply("UPDATE", tm.Depth{Bids: []tm.Level{lv("99", "1")}}, "4") || b.ok {
		t.Fatal("an update before any snapshot is ignored, not applied")
	}
	b.apply("SNAPSHOT", tm.Depth{Bids: []tm.Level{lv("99", "1"), lv("98", "2")}, Asks: []tm.Level{lv("101", "1")}}, "5")
	b.apply("UPDATE", tm.Depth{Bids: []tm.Level{lv("99.0", "0"), lv("97", "3")}}, "5") // the snapshot's own seqnum again
	bids := b.levels(Buy)
	if len(bids) != 2 || !bids[0].price.Equal(d("98")) || !bids[1].price.Equal(d("97")) {
		t.Fatalf("bids %+v", bids)
	}
	if b.apply("UPDATE", tm.Depth{Asks: []tm.Level{lv("102", "1")}}, "7") || b.ok {
		t.Fatal("a skipped seqnum should be reported, and the book set aside")
	}
	b.apply("SNAPSHOT", tm.Depth{Asks: []tm.Level{lv("100", "1")}}, "9")
	if !b.ok || len(b.levels(Sell)) != 1 || len(b.levels(Buy)) != 0 {
		t.Fatalf("after a fresh snapshot %+v", b)
	}
}

// Closing a long sells into the bids level by level, around our own resting bids; a thin book
// closes only part of it.
func TestExitWalksTheBookAroundOurOrders(t *testing.T) {
	bids := []depthLevel{{d("100"), d("1")}, {d("99"), d("1")}, {d("98"), d("5")}}
	own := map[string]decimal.Decimal{"100": d("0.4")}
	x, ok := exitAgainst(bids, own, d("2"), d("97"), true)
	// 0.6 @ 100 (the rest of that level is ours), 1 @ 99, 0.4 @ 98
	if !ok || !x.Qty.Equal(d("2")) || !x.Value.Equal(d("198.2")) || x.Levels != 3 {
		t.Fatalf("exit %+v", x)
	}
	if !x.Price.Equal(d("99.1")) || !x.Pnl.Equal(d("4.2")) {
		t.Fatalf("price %s pnl %s", x.Price, x.Pnl)
	}
	thin, _ := exitAgainst(bids[:1], nil, d("3"), d("97"), true)
	if !thin.Qty.Equal(d("1")) {
		t.Fatalf("thin %+v", thin)
	}
	// A short buys back from the asks: paying more than it sold at is a loss.
	short, _ := exitAgainst([]depthLevel{{d("101"), d("10")}}, nil, d("2"), d("100"), false)
	if !short.Pnl.Equal(d("-2")) {
		t.Fatalf("short %+v", short)
	}
	if _, ok := exitAgainst(bids, map[string]decimal.Decimal{"100": d("1"), "99": d("1"), "98": d("5")}, d("1"), d("97"), true); ok {
		t.Fatal("only our own orders: nothing to take")
	}
}

// The book's status prices the exit off its depth book, or the best bid alone without one, and
// gives the room left under the max position change.
func TestStatusPricesTheExitAndTheRoomLeft(t *testing.T) {
	desk := startDesk(t, newFake(map[string]string{"btc": "1", "usdc": "100000"}))
	p := testParams()
	p.MaxPosition = d("0.01")
	e := addBook(t, desk, "BTC-USDC", p)
	tick(desk, "BTC-USD", "50000")
	fillBook(e, Buy, "0.004", "49900")
	// Odd prices, so none of the book's own bids sit at them.
	ebbo(desk, "BTC-USDC", "49950.37", "0.001", "50050.37", "1")

	waitFor(t, "an exit off the best bid", func() bool {
		x := e.Status().Position.Exit
		return x != nil && x.Source == "top"
	})
	if x := e.Status().Position.Exit; !x.Qty.Equal(d("0.001")) || !x.Price.Equal(d("49950.37")) {
		t.Fatalf("top exit %+v", x)
	}
	raw, _ := json.Marshal(tm.Depth{Symbol: "BTC-USDC", Bids: []tm.Level{lv("49950.37", "0.001"), lv("49900.11", "0.01")}})
	desk.OnMarket(tm.Message{Channel: "DEPTH", Update: "SNAPSHOT", Seqnum: "1", Data: raw})
	s := e.Status().Position
	if s.Exit.Source != "depth" || !s.Exit.Qty.Equal(d("0.004")) || s.Exit.Levels != 2 {
		t.Fatalf("depth exit %+v", s.Exit)
	}
	if s.Limit == nil || !s.Limit.Max.Equal(d("0.01")) || !s.Limit.BuyRoom.Equal(d("0.006")) || !s.Limit.SellRoom.Equal(d("0.014")) {
		t.Fatalf("limit %+v", s.Limit)
	}
}
