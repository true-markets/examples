// Package admin is the quoter's management API: a small HTTP server that reports status, adds
// and removes books, and takes parameter changes. The CeFi console's Quoter screen talks to it;
// so can curl.
//
//	GET    /api/status                  every book at a glance, shared balances, connections, and
//	                                    the books that can be added
//	GET    /api/trades?limit=500        fills this run, newest first, with edge at fill and mark-outs
//	POST   /api/books                   add a book, stopped: {"symbol": "ETH-USDC"}, optionally with
//	                                    "reference": "ETH-USD" or a "blend" (below)
//	GET    /api/books/{symbol}          one book in full: ladder, orders, position, events, and
//	                                    each reference source
//	PUT    /api/books/{symbol}/reference   change a book's blend: {"sources": [...], ...}
//	GET    /api/references/{symbol}/suggest   the reference sources found for a book
//	POST   /api/references/{symbol}/preview   a blend evaluated against live prices, not saved
//
// A blend: {"sources": [{"ref": "hyperliquid:xyz:GOOGL", "weight": 2},
// {"ref": "kraken:GOOGLx/USD", "weight": 1, "multiplier": "1"}], "weighting": "fixed",
// "maxDeviationBps": 100, "tokenMultiplier": "1"}. See reference/blend.go.
//
//	DELETE /api/books/{symbol}          remove a stopped book with nothing resting
//	GET    /api/books/{symbol}/params   { params, schema }
//	PATCH  /api/books/{symbol}/params   a partial update, e.g. {"spreadBps": 12}
//	POST   /api/books/{symbol}/start    start quoting one book
//	POST   /api/books/{symbol}/stop     stop one book and pull its quotes
//	POST   /api/books/{symbol}/reset    start its position, PnL and activity counts from zero
//	POST   /api/books/{symbol}/reset-rejects  start its reject, error and rate-limit counts from zero
//	POST   /api/start                   start every book
//	POST   /api/stop                    stop every book and pull every quote
//	POST   /api/reset-rejects           reset every book's reject, error and rate-limit counts
//
// When ADMIN_TOKEN is set every request needs "Authorization: Bearer <token>".
package admin

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
)

func Handler(d *quoter.Desk, token string, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	fail := func(w http.ResponseWriter, status int, err error) {
		writeJSON(w, status, map[string]string{"error": err.Error()})
	}
	// book finds the engine named in the path, or answers 404.
	book := func(w http.ResponseWriter, r *http.Request) *quoter.Engine {
		e := d.Engine(r.PathValue("symbol"))
		if e == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": r.PathValue("symbol") + " isn't added"})
		}
		return e
	}

	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.Status())
	})
	mux.HandleFunc("GET /api/trades", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 5000 {
			limit = 500
		}
		writeJSON(w, http.StatusOK, d.Trades(limit))
	})
	mux.HandleFunc("GET /api/rejects", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 5000 {
			limit = 1000
		}
		writeJSON(w, http.StatusOK, map[string]any{"rejects": d.Rejects(limit)})
	})
	mux.HandleFunc("POST /api/books", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Symbol    string                 `json:"symbol"`
			Reference string                 `json:"reference"`
			Blend     *reference.BlendConfig `json:"blend"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		blend := req.Blend
		if blend == nil && strings.TrimSpace(req.Reference) != "" {
			single := reference.Single(req.Reference)
			blend = &single
		}
		m, err := d.Add(r.Context(), strings.TrimSpace(req.Symbol), blend, nil, false)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		log.Info("book added over the management API", "book", m.Symbol, "from", r.RemoteAddr)
		writeJSON(w, http.StatusOK, map[string]any{"market": m})
	})
	mux.HandleFunc("GET /api/books/{symbol}", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		if s, ok := d.BookStatus(r.PathValue("symbol")); ok {
			writeJSON(w, http.StatusOK, s)
		}
	})
	readBlend := func(w http.ResponseWriter, r *http.Request) (reference.BlendConfig, bool) {
		var b reference.BlendConfig
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&b); err != nil {
			fail(w, http.StatusBadRequest, err)
			return b, false
		}
		return b, true
	}
	mux.HandleFunc("PUT /api/books/{symbol}/reference", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		b, ok := readBlend(w, r)
		if !ok {
			return
		}
		m, err := d.SetBlend(r.Context(), r.PathValue("symbol"), b)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		log.Info("reference changed over the management API", "book", m.Symbol, "from", r.RemoteAddr)
		writeJSON(w, http.StatusOK, map[string]any{"market": m})
	})
	mux.HandleFunc("GET /api/references/{symbol}/suggest", func(w http.ResponseWriter, r *http.Request) {
		s, err := d.SuggestSources(r.Context(), r.PathValue("symbol"))
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sources": s})
	})
	mux.HandleFunc("POST /api/references/{symbol}/preview", func(w http.ResponseWriter, r *http.Request) {
		b, ok := readBlend(w, r)
		if !ok {
			return
		}
		p, err := d.Preview(r.Context(), r.PathValue("symbol"), b)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, p)
	})
	mux.HandleFunc("DELETE /api/books/{symbol}", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		if err := d.Remove(r.PathValue("symbol")); err != nil {
			fail(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"removed": true})
	})
	mux.HandleFunc("GET /api/books/{symbol}/params", func(w http.ResponseWriter, r *http.Request) {
		if e := book(w, r); e != nil {
			writeJSON(w, http.StatusOK, map[string]any{"params": e.Params(), "schema": quoter.Schema()})
		}
	})
	mux.HandleFunc("PATCH /api/books/{symbol}/params", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		p, err := d.UpdateParams(r.PathValue("symbol"), body)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		log.Info("parameters changed over the management API", "book", r.PathValue("symbol"), "from", r.RemoteAddr)
		writeJSON(w, http.StatusOK, map[string]any{"params": p})
	})
	mux.HandleFunc("POST /api/books/{symbol}/reset", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		if err := d.ResetPosition(r.PathValue("symbol")); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		log.Info("position reset over the management API", "book", r.PathValue("symbol"), "from", r.RemoteAddr)
		writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
	})
	mux.HandleFunc("POST /api/books/{symbol}/reset-rejects", func(w http.ResponseWriter, r *http.Request) {
		if book(w, r) == nil {
			return
		}
		if err := d.ResetRejects(r.PathValue("symbol")); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
	})
	mux.HandleFunc("POST /api/reset-rejects", func(w http.ResponseWriter, r *http.Request) {
		if err := d.ResetRejects(""); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
	})
	for action, on := range map[string]bool{"start": true, "stop": false} {
		mux.HandleFunc("POST /api/books/{symbol}/"+action, func(w http.ResponseWriter, r *http.Request) {
			if e := book(w, r); e != nil {
				e.SetEnabled(on)
				writeJSON(w, http.StatusOK, map[string]bool{"enabled": on})
			}
		})
		mux.HandleFunc("POST /api/"+action, func(w http.ResponseWriter, r *http.Request) {
			d.SetEnabled(on)
			writeJSON(w, http.StatusOK, map[string]bool{"enabled": on})
		})
	}
	return auth(token, mux)
}

func auth(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(strings.TrimSpace(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing or wrong admin token"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
