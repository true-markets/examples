package main

import (
	"os"
	"strings"
	"testing"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
)

// .env.example must load as it is, with inline comments, into a valid paper-mode config.
func TestEnvExampleLoads(t *testing.T) {
	dir := t.TempDir()
	raw, err := os.ReadFile(".env.example")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/.env", raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	for _, k := range []string{"TM_ENV", "QUOTER_SYMBOL", "PAPER_BALANCES", "QUOTER_BOOKS_FILE", "SIZE_UNIT", "MAX_POSITION", "TAKE_MAX_SIZE", "PROFIT_TAKER", "TAKEOUT", "SPREAD_BPS", "QUOTE_SIZE", "ORDER_TRANSPORT", "QUOTER_MODE", "TM_API_KEY_PATH"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "paper" || cfg.Environment != "uat" || cfg.BooksFile != "books.json" || cfg.Params.SpreadBps != 10 || cfg.Transport != "rest" || !cfg.PaperBalances["USDC"].IsPositive() {
		t.Fatalf("%+v", cfg)
	}

	// The books file round-trips, and a book's own settings win over .env's.
	eth := reference.Single("ETH-USD")
	saved := map[string]quoter.BookConfig{"ETH-USDC": {Blend: &eth, Params: cfg.Params}}
	p := cfg.Params
	p.SpreadBps = 25
	saved["BTC-USDC"] = quoter.BookConfig{Params: p}
	if err := saveBooks(cfg.BooksFile, saved, quoter.Settings{OrderRate: 40, OrderRatePerMin: 900}); err != nil {
		t.Fatal(err)
	}
	// Saved settings win over .env's.
	settings := quoter.Settings{OrderRate: cfg.OrderRate, OrderRatePerMin: cfg.OrderRatePerMin}
	books, _, err := loadBooks(cfg.BooksFile, cfg.Params, &settings)
	if err != nil || len(books) != 2 || books[0].Symbol != "BTC-USDC" || books[0].Params.SpreadBps != 25 || books[0].Blend != nil || books[1].Blend.Sources[0].Ref != "ETH-USD" {
		t.Fatalf("%+v %v", books, err)
	}
	if settings.OrderRate != 40 || settings.OrderRatePerMin != 900 {
		t.Fatalf("settings %+v", settings)
	}
	// A book saved before blends named one reference; it reads as a blend of that source.
	if err := os.WriteFile(cfg.BooksFile, []byte(`{"books": {"ETH-USDC": {"reference": "ETH-USD"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if books, _, err := loadBooks(cfg.BooksFile, cfg.Params, &quoter.Settings{}); err != nil || books[0].Blend == nil || len(books[0].Blend.Sources) != 1 || books[0].Blend.Sources[0].Ref != "ETH-USD" {
		t.Fatalf("%+v %v", books, err)
	}
	if err := os.WriteFile(cfg.BooksFile, []byte(`{"books": {"BTC-USDC": {"params": {"spredBps": 1}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadBooks(cfg.BooksFile, cfg.Params, &quoter.Settings{}); err == nil {
		t.Fatal("a misspelled setting in the books file should be an error")
	}

	// A book saved before sizeUnit existed keeps its sizes in the base asset, even though new
	// books default to the quote currency.
	if err := os.WriteFile(cfg.BooksFile, []byte(`{"books": {"BTC-USDC": {"params": {"quoteSize": "0.0001"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if books, _, err := loadBooks(cfg.BooksFile, cfg.Params, &quoter.Settings{}); err != nil || books[0].Params.SizeUnit != quoter.SizeInBase || cfg.Params.SizeUnit != quoter.SizeInQuote {
		t.Fatalf("%+v %v", books, err)
	}

	// A setting an earlier version saved and then retired is dropped with a warning, not an error,
	// so an upgrade never stops the quoter from starting on its own books file.
	if err := os.WriteFile(cfg.BooksFile, []byte(`{"books": {"GOOGLC-USDC": {"params": {"quoteSize": "0.008", "maxBaseAllocUsd": "100"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	books, dropped, err := loadBooks(cfg.BooksFile, cfg.Params, &quoter.Settings{})
	if err != nil || len(books) != 1 || !books[0].Params.QuoteSize.Equal(decimal.RequireFromString("0.008")) || len(dropped) != 1 || !strings.Contains(dropped[0], "maxBaseAllocUsd (100)") {
		t.Fatalf("%+v %v %v", books, dropped, err)
	}

	// A book saved in base units before taking existed gets a take size on its own scale (its max
	// position change), not the dollar default read as 20 coins.
	if err := os.WriteFile(cfg.BooksFile, []byte(`{"books": {"BTC-USDC": {"params": {"sizeUnit": "base", "quoteSize": "0.001", "maxPosition": "0.004"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if books, _, err := loadBooks(cfg.BooksFile, cfg.Params, &quoter.Settings{}); err != nil || !books[0].Params.TakeMaxSize.Equal(decimal.RequireFromString("0.004")) {
		t.Fatalf("take size %v %v", books, err)
	}
	if !cfg.Params.TakeMaxSize.Equal(decimal.NewFromInt(20)) || !cfg.Params.ProfitTaker || cfg.Params.Takeout {
		t.Fatalf("take defaults %+v", cfg.Params)
	}

	// QUOTER_SYMBOL from the single-book version gets a pointer to the books file.
	t.Setenv("QUOTER_SYMBOL", "BTC-USDC")
	if _, err := loadConfig(); err == nil {
		t.Fatal("QUOTER_SYMBOL should be rejected with a pointer to the books file")
	}
}
