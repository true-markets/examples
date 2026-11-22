// Package admin is the quoter's management API: a small HTTP server that reports status, adds
// and removes books, and takes parameter changes. The CeFi console's Quoter screen talks to it;
// so can curl.
//
//	GET    /api/status                  every book at a glance, shared balances, connections, and
//	                                    the books that can be added
//	GET    /api/trades?limit=500        fills this run, newest first, with edge at fill and mark-outs
//	POST   /api/books                   add a book, stopped: {"symbol": "ETH-USDC", "reference": "ETH-USD"}
//	GET    /api/books/{symbol}          one book in full: ladder, orders, position, events
//	DELETE /api/books/{symbol}          remove a stopped book with nothing resting
//	GET    /api/books/{symbol}/params   { params, schema }
//	PATCH  /api/books/{symbol}/params   a partial update, e.g. {"spreadBps": 12}
//	POST   /api/books/{symbol}/start    start quoting one book
//	POST   /api/books/{symbol}/stop     stop one book and pull its quotes
//	POST   /api/start                   start every book
//	POST   /api/stop                    stop every book and pull every quote
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
	mux.HandleFunc("POST /api/books", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Symbol    string `json:"symbol"`
			Reference string `json:"reference"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		m, err := d.Add(r.Context(), strings.TrimSpace(req.Symbol), req.Reference, nil, false)
		if err != nil {
			fail(w, http.StatusBadRequest, err)
			return
		}
		log.Info("book added over the management API", "book", m.Symbol, "from", r.RemoteAddr)
		writeJSON(w, http.StatusOK, map[string]any{"market": m})
	})
	mux.HandleFunc("GET /api/books/{symbol}", func(w http.ResponseWriter, r *http.Request) {
		if e := book(w, r); e != nil {
			writeJSON(w, http.StatusOK, e.Status())
		}
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
