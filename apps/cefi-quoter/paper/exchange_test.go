package paper

import (
	"context"
	"testing"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

// The reason the quoter modifies instead of canceling and re-placing: with the whole balance
// deployed, moving an order in place works, and cancel-then-new doesn't until the cancel lands.
func TestModifyReusesTheHold(t *testing.T) {
	ctx := context.Background()
	x := New("USDC", map[string]decimal.Decimal{"USDC": d("1000"), "BTC": d("0")})
	l := x.Listings()[0]
	m := quoter.Market{Symbol: l.Symbol, InstrumentID: l.InstrumentID, BaseAssetID: l.BaseAssetID, QuoteAssetID: l.QuoteAssetID}
	tx := x.Transport(m)

	book := quoter.NewBook("cq", l.InstrumentID)
	o := book.BeginCreate(quoter.Buy, 0, d("100"), d("10")) // holds all 1000 USDC
	if _, err := tx.Create(ctx, o); err != nil {
		t.Fatal(err)
	}

	// A second order of the same size has nothing to hold: rejected. This is what cancel-then-new
	// runs into when the new order beats the cancel.
	o2 := book.BeginCreate(quoter.Buy, 0, d("99"), d("10"))
	if _, err := tx.Create(ctx, o2); err == nil {
		t.Fatal("a new order with no free balance should be rejected")
	}

	// Moving the first order down in place needs no extra funds.
	if err := tx.Modify(ctx, o.ExternalID, "", "", d("99"), d("10")); err != nil {
		t.Fatal(err)
	}
	b, _ := x.Balances(ctx)
	for _, a := range b.Balances {
		if a.AssetID == "USDC" && a.OrderHold != "990" {
			t.Fatalf("hold after modify %s, want 990", a.OrderHold)
		}
	}
}

func TestListings(t *testing.T) {
	x := New("USDC", map[string]decimal.Decimal{"USDC": d("1"), "ETH": d("1"), "BTC": d("1")})
	ls := x.Listings()
	if len(ls) != 2 || ls[0].Symbol != "BTC-USDC" || ls[0].Reference != "BTC-USD" || ls[1].Symbol != "ETH-USDC" {
		t.Fatalf("%+v", ls)
	}
	if _, err := ParseBalances("USDC=10, BTC=x"); err == nil {
		t.Fatal("bad amount accepted")
	}
}
