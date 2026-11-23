package tm

import "testing"

func TestStockTicker(t *testing.T) {
	for _, c := range []struct {
		l    StockListing
		want string
		ok   bool
	}{
		{StockListing{Symbol: "GOOGLC-USDC", Slug: "alphabet-coinbase-tokenized-stock"}, "GOOGL", true},
		{StockListing{Symbol: "MUC-USDC", Slug: "micron-technology-inc-coinbase-tokenized-stock"}, "MU", true},
		{StockListing{Symbol: "NVDA-USDC", Slug: "nvidia-robinhood-token"}, "NVDA", true},
		{StockListing{Symbol: "XYZ-USDC", Slug: "xyz-someone-else"}, "", false},
	} {
		if got, ok := c.l.Ticker(); got != c.want || ok != c.ok {
			t.Errorf("%s: got %q %v", c.l.Symbol, got, ok)
		}
	}
}
