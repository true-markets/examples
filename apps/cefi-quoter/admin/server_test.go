package admin

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/paper"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
)

func TestAdminAPI(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	params := quoter.Params{SizeUnit: quoter.SizeInBase, SpreadBps: 10, Levels: 2, LevelSpreadMult: 1.5, QuoteSize: decimal.RequireFromString("0.001"), LevelSizeMult: 1, RefStaleMs: 3000}
	x := paper.New("USDC", map[string]decimal.Decimal{"USDC": decimal.NewFromInt(1000), "BTC": decimal.NewFromInt(1), "ETH": decimal.NewFromInt(1)})
	desk := quoter.NewDesk(quoter.DeskConfig{
		Mode: "paper", Environment: "paper", IDPrefix: "cq", Defaults: params,
		Catalog: x.Listings(), Venue: x, NewTransport: x.Transport, Log: log,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go desk.Run(ctx)
	srv := httptest.NewServer(Handler(desk, "s3cret", log))
	defer srv.Close()

	do := func(method, path, token, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	const tok = "s3cret"

	if code, _ := do("GET", "/api/status", "", ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, body := do("GET", "/api/status", tok, ""); code != 200 || !strings.Contains(body, `"books":[]`) || !strings.Contains(body, `"symbol":"BTC-USDC"`) {
		t.Fatalf("status: %d %s", code, body)
	}
	if code, body := do("POST", "/api/books", tok, `{"symbol": "DOGE-USDC"}`); code != 400 || !strings.Contains(body, "not a book") {
		t.Fatalf("unknown book: %d %s", code, body)
	}
	if code, body := do("POST", "/api/books", tok, `{"symbol": "BTC-USDC"}`); code != 200 || !strings.Contains(body, `"reference":"BTC-USD"`) {
		t.Fatalf("add: %d %s", code, body)
	}
	if code, _ := do("POST", "/api/books", tok, `{"symbol": "BTC-USDC"}`); code != 400 {
		t.Fatalf("added twice: %d", code)
	}
	if code, body := do("GET", "/api/books/BTC-USDC", tok, ""); code != 200 || !strings.Contains(body, `"state":"stopped"`) {
		t.Fatalf("book: %d %s", code, body)
	}
	if code, _ := do("GET", "/api/books/ETH-USDC", tok, ""); code != 404 {
		t.Fatalf("book not added: %d", code)
	}
	if code, body := do("GET", "/api/books/BTC-USDC/params", tok, ""); code != 200 || !strings.Contains(body, `"schema"`) || !strings.Contains(body, `"quoteSize":"0.001"`) {
		t.Fatalf("params: %d %s", code, body)
	}
	if code, body := do("PATCH", "/api/books/BTC-USDC/params", tok, `{"spreadBps": -1}`); code != 400 || !strings.Contains(body, "spreadBps") {
		t.Fatalf("bad patch: %d %s", code, body)
	}
	if code, _ := do("PATCH", "/api/books/BTC-USDC/params", tok, `{"spreadBps": 20}`); code != 200 || desk.Engine("BTC-USDC").Params().SpreadBps != 20 {
		t.Fatalf("patch: %d", code)
	}
	if code, _ := do("POST", "/api/books/BTC-USDC/start", tok, ""); code != 200 || !desk.Engine("BTC-USDC").Enabled() {
		t.Fatal("start")
	}
	if code, body := do("DELETE", "/api/books/BTC-USDC", tok, ""); code != 409 || !strings.Contains(body, "stop") {
		t.Fatalf("removed a running book: %d %s", code, body)
	}
	if code, _ := do("POST", "/api/stop", tok, ""); code != 200 || desk.Engine("BTC-USDC").Enabled() {
		t.Fatal("stop all")
	}
	if code, _ := do("DELETE", "/api/books/BTC-USDC", tok, ""); code != 200 || desk.Engine("BTC-USDC") != nil {
		t.Fatalf("remove: %d", code)
	}
}
