// cefi-quoter is a two-sided market maker for the True Markets CeFi exchange. One process quotes
// any number of books, all drawing on one shared view of the account's balances.
//
// For each book it centers a ladder of post-only bids and asks on a reference price (Coinbase),
// keeps that ladder in place with modifies, and follows its orders on the WebSocket drop copy.
// Books are added, started, stopped and tuned on a small management API. Without an API key it
// runs in paper mode against a simulated exchange. See README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/true-markets/examples/apps/cefi-quoter/admin"
	"github.com/true-markets/examples/apps/cefi-quoter/fix"
	"github.com/true-markets/examples/apps/cefi-quoter/paper"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "cefi-quoter:", err)
		os.Exit(1)
	}
}

// venue is what live and paper mode each provide: the books on offer, order entry for a book,
// the REST reads, and the feeds.
type venue struct {
	desk quoter.DeskConfig // Mode, Environment, ClientID, Transport, Catalog, Venue, NewTransport
	// start launches the venue's own feeds, wired to the desk, and returns once they're up enough
	// to begin (a FIX logon). onAdd subscribes a book's market data when it's added. Both run
	// after the desk exists.
	start func(ctx context.Context, d *quoter.Desk) error
	onAdd func(quoter.Market)
	// onTick sees every book's blended reference price (paper mode fills from it).
	onTick func(symbol string, t reference.Tick)
	// done is closed once the venue's connections have shut down.
	done chan struct{}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	saved, dropped, err := loadBooks(cfg.BooksFile, cfg.Params)
	if err != nil {
		return err
	}
	for _, w := range dropped {
		log.Warn(w) // the file is rewritten without it the next time a book changes
	}

	state, err := loadState(cfg.StateFile)
	if err != nil {
		return err
	}
	// The paper account carries over too, so restored positions still match its balances.
	if cfg.Mode == "paper" && state != nil && len(state.PaperBalances) > 0 {
		cfg.PaperBalances = state.PaperBalances
	}

	var v *venue
	var paperX *paper.Exchange
	if cfg.Mode == "paper" {
		v, paperX = paperVenue(cfg, log)
	} else if v, err = liveVenue(ctx, cfg, log); err != nil {
		return err
	}

	// Feeds run on their own context so they stay up while shutdown cancels orders and waits for
	// the drop copies that confirm it.
	feedCtx, stopFeeds := context.WithCancel(context.Background())
	defer stopFeeds()

	// Every reference source streams over one connection per provider: Coinbase, Hyperliquid and
	// Kraken. The desk blends each book's sources into its price. The desk is created below;
	// ticks before then have no book to go to.
	var desk *quoter.Desk
	onTick := func(t reference.Tick) { desk.OnTick(t) }
	// The reference connection is up while every source in use is up.
	var refUp sync.Map
	onRefState := func(source string) func(bool, string) {
		return func(up bool, reason string) {
			refUp.Store(source, up)
			if up {
				refUp.Range(func(k, v any) bool {
					if !v.(bool) {
						up, reason = false, k.(string)+" down"
					}
					return up
				})
			} else {
				reason = source + ": " + reason
			}
			desk.SetConn(quoter.ConnReference, up, reason)
		}
	}
	ticker := &reference.Feeds{
		Coinbase:    &reference.Coinbase{OnTick: onTick, OnState: onRefState("coinbase"), Log: log.With("component", "coinbase")},
		Hyperliquid: &reference.HyperliquidFeed{OnTick: onTick, OnState: onRefState("hyperliquid"), Log: log.With("component", "hyperliquid")},
		Kraken:      &reference.KrakenFeed{OnTick: onTick, OnState: onRefState("kraken"), Log: log.With("component", "kraken")},
	}

	dc := v.desk
	dc.IDPrefix = cfg.IDPrefix
	dc.OrderRate = cfg.OrderRate
	dc.OrderRatePerMin = cfg.OrderRatePerMin
	dc.Defaults = cfg.Params
	dc.CheckReference = reference.Check
	dc.Subscribe = ticker.Add
	dc.Suggest = reference.Suggest
	dc.OnReference = v.onTick
	// Tokenized stocks price off Hyperliquid, not Coinbase. The public asset catalog says which
	// listings are stocks. Paper mode uses production's catalog.
	catalogURL := tm.Environments["production"].Catalog
	if cfg.Mode == "live" {
		catalogURL = tm.Environments[cfg.Environment].Catalog
	}
	dc.Catalog = stockReferences(ctx, catalogURL, dc.Catalog, log)
	dc.Log = log
	dc.Save = func(b map[string]quoter.BookConfig) error { return saveBooks(cfg.BooksFile, b) }
	dc.SaveState = func(s quoter.State) error {
		f := stateFile{State: s}
		if paperX != nil {
			f.PaperBalances = paperX.Holdings()
		}
		return saveState(cfg.StateFile, f)
	}
	dc.OnAdd = v.onAdd
	desk = quoter.NewDesk(dc)
	if state != nil {
		if err := desk.Restore(&state.State); err != nil {
			return fmt.Errorf("%w; point QUOTER_STATE_FILE somewhere else, or delete %s to start from zero", err, cfg.StateFile)
		}
		log.Info("picking up where the last run left off", "state", cfg.StateFile, "saved", state.SavedAt.Local().Format("Jan 2 15:04:05"))
	}

	go ticker.Run(feedCtx)
	if err := v.start(feedCtx, desk); err != nil {
		return err
	}

	for _, b := range saved {
		p := b.Params
		if _, err := desk.Add(ctx, b.Symbol, b.Blend, &p, cfg.AutoStart); err != nil {
			// One bad book shouldn't keep the others from running. It stays in the file.
			log.Error("couldn't add a saved book; fix or remove it in "+cfg.BooksFile, "book", b.Symbol, "err", err)
		}
	}

	// Orders a crash left resting may have filled before this start canceled them.
	if h, ok := dc.Venue.(quoter.OrderHistory); ok {
		for _, m := range desk.RecoverMissedFills(ctx, h) {
			log.Warn(m)
		}
	}
	desk.SaveState(true)

	// The management API.
	if err := checkAdminAddr(cfg.AdminAddr, cfg.AdminToken); err != nil {
		return err
	}
	srv := &http.Server{Addr: cfg.AdminAddr, Handler: admin.Handler(desk, cfg.AdminToken, log.With("component", "admin")), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("management API stopped", "err", err)
			stop()
		}
	}()
	log.Info("management API listening", "addr", "http://"+cfg.AdminAddr)
	switch {
	case len(saved) == 0:
		log.Info("no books yet: add one from the console's Quoter screen, or curl -X POST http://" + cfg.AdminAddr + `/api/books -d '{"symbol":"BTC-USDC"}'`)
	case !cfg.AutoStart:
		log.Info("not quoting yet: start books from the console's Quoter screen, or curl -X POST http://" + cfg.AdminAddr + "/api/start")
	}

	// Run until Ctrl-C, then pull every quote before exiting.
	desk.Run(ctx)
	log.Info("shutting down: pulling quotes")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if left := desk.Shutdown(shutdownCtx, 5*time.Second); left > 0 {
		log.Warn("some cancels were not confirmed before exit; check your open orders", "orders", left)
	}
	desk.SaveState(true)
	_ = srv.Shutdown(shutdownCtx)
	stopFeeds()
	<-v.done
	return nil
}

// --- paper ----------------------------------------------------------------------------------

func paperVenue(cfg Config, log *slog.Logger) (*venue, *paper.Exchange) {
	x := paper.New("USDC", cfg.PaperBalances)
	var parts []string
	for asset, amt := range cfg.PaperBalances {
		parts = append(parts, amt.String()+" "+asset)
	}
	sort.Strings(parts)
	log.Info("cefi-quoter in PAPER mode: a simulated exchange priced off live Coinbase; no orders reach True Markets",
		"balances", strings.Join(parts, ", "))
	done := make(chan struct{})
	close(done)
	return &venue{
		desk: quoter.DeskConfig{
			Mode: "paper", Environment: "paper", ClientID: "paper", Transport: "paper",
			Catalog: x.Listings(), Venue: x, NewTransport: x.Transport,
		},
		onTick: x.OnTick,
		done:   done,
		start: func(_ context.Context, d *quoter.Desk) error {
			x.OnDropCopy = d.OnDropCopy
			x.OnMarket = d.OnMarket
			// The paper exchange is in-process: its drop copy and its market data are always up.
			d.SetConn(quoter.ConnDropCopy, true, "")
			d.SetConn(quoter.ConnMarket, true, "")
			return nil
		},
	}, x
}

// --- live -----------------------------------------------------------------------------------

func liveVenue(ctx context.Context, cfg Config, log *slog.Logger) (*venue, error) {
	key, err := tm.LoadAPIKey(cfg.KeyPath)
	if err != nil {
		return nil, err
	}
	hosts := tm.Environments[cfg.Environment]
	tokens := tm.NewTokenSource(key, hosts.Auth)
	rest := tm.NewREST(hosts.CeFi, tokens)

	clientID := cfg.ClientID
	if clientID == "" {
		if clientID, err = tokens.Claim(ctx, "client_id"); err != nil {
			return nil, err
		}
	}
	if clientID == "" {
		clients, err := rest.Clients(ctx)
		if err != nil || len(clients) == 0 {
			return nil, errors.New("this API key is not enabled for CeFi trading: its token has no client_id (set TM_CLIENT_ID if you know it)")
		}
		clientID = string(clients[0].ID)
	}
	orgID := cfg.OrganizationID
	if orgID == "" {
		orgID, _ = tokens.Claim(ctx, "organization_id")
	}

	catalog, err := listBooks(ctx, rest)
	if err != nil {
		return nil, err
	}
	log.Info("cefi-quoter", "env", cfg.Environment, "client", clientID, "transport", cfg.Transport, "books on offer", len(catalog))
	if cfg.Environment == "production" {
		log.Warn("PRODUCTION: orders this quoter sends are real and trade real funds")
	}

	// Orders left by an earlier run would be invisible to this one. Cancel them first, on every book.
	if err := cancelLeftovers(ctx, rest, quoter.NewBook(cfg.IDPrefix, ""), log); err != nil {
		return nil, fmt.Errorf("canceling orders from an earlier run: %w", err)
	}

	v := &venue{done: make(chan struct{})}
	v.desk = quoter.DeskConfig{
		Mode: "live", Environment: cfg.Environment, ClientID: clientID, Transport: cfg.Transport,
		Catalog: catalog, Venue: rest,
	}
	var fixSession *fix.Session
	if cfg.Transport == "fix" {
		// One FIX session for every book; each order names its symbol.
		fixSession = fix.NewSession(fix.Config{
			Addr:               cfg.FIX.Addr,
			TLS:                cfg.FIX.TLS,
			SenderCompID:       cfg.FIX.SenderCompID,
			TargetCompID:       cfg.FIX.TargetCompID,
			KeyID:              key.KeyID,
			Signer:             key,
			ClientID:           clientID,
			HeartBtInt:         cfg.FIX.HeartBtInt,
			CancelOnDisconnect: cfg.FIX.CancelOnDisconnect,
		}, log.With("component", "fix"))
		v.desk.NewTransport = func(m quoter.Market) quoter.Transport {
			return &quoter.FIXTransport{Session: fixSession, Symbol: m.Symbol}
		}
	} else {
		v.desk.NewTransport = func(m quoter.Market) quoter.Transport {
			return &quoter.RESTTransport{REST: rest, ClientID: clientID, InstrumentID: m.InstrumentID}
		}
	}

	// Two WebSocket connections shared by every book: one for our own orders, one for market
	// data, so order events never queue behind a burst of market data. The drop copy is account
	// wide; the desk routes each message to its book.
	var marketFeed *tm.Feed
	v.onAdd = func(m quoter.Market) { marketFeed.Add("EBBO", m.Symbol) }
	v.start = func(feedCtx context.Context, d *quoter.Desk) error {
		dropCopy := &tm.Feed{
			Name: "dropcopy", URL: hosts.WS, Key: key, OrganizationID: orgID,
			Subscriptions: []tm.Subscription{{Channel: "DROPCOPY", Items: []string{clientID}}, {Channel: "HEARTBEAT"}},
			OnMessage:     d.OnDropCopy,
			OnState:       func(up bool, reason string) { d.SetConn(quoter.ConnDropCopy, up, reason) },
			Log:           log.With("component", "ws"),
		}
		marketFeed = &tm.Feed{
			Name: "market", URL: hosts.WS, Key: key, OrganizationID: orgID,
			// Authenticated: the unauthenticated market data is batched to about once a second.
			// Each book's EBBO is added as the book is.
			Subscriptions: []tm.Subscription{{Channel: "HEARTBEAT"}},
			OnMessage:     d.OnMarket,
			OnState:       func(up bool, reason string) { d.SetConn(quoter.ConnMarket, up, reason) },
			Log:           log.With("component", "ws"),
		}
		go dropCopy.Run(feedCtx)
		go marketFeed.Run(feedCtx)
		if fixSession == nil {
			close(v.done)
			return nil
		}
		fixSession.OnCancelReject = d.OnCancelReject
		fixSession.OnExecutionReport = func(m fix.Message) {
			if m.Get(150) == "8" {
				log.Warn("FIX order rejected", "clOrdID", m.Get(11), "text", m.Get(58))
			}
		}
		go func() {
			fixSession.Run(feedCtx)
			close(v.done)
		}()
		return fixSession.WaitLogon(ctx, 15*time.Second)
	}
	return v, nil
}

// stockReferences points each tokenized-stock listing at its Hyperliquid perp (GOOGLC-USDC ->
// hyperliquid:xyz:GOOGL). Coinbase lists no stocks, so the crypto default would never price.
// Without the catalog, books still start; a stock book then needs its reference named.
func stockReferences(ctx context.Context, catalogURL string, listings []quoter.Listing, log *slog.Logger) []quoter.Listing {
	stocks, err := tm.StockListings(ctx, catalogURL)
	if err != nil {
		log.Warn("couldn't read the asset catalog; tokenized-stock books need their reference named (hyperliquid:xyz:TICKER)", "err", err)
		return listings
	}
	out := slices.Clone(listings)
	for i, l := range out {
		s, ok := stocks[l.Symbol]
		if !ok {
			continue
		}
		out[i].Stock, out[i].Underlying = true, ""
		if ticker, ok := s.Ticker(); ok {
			out[i].Reference = reference.Hyperliquid(reference.StockDex + ":" + ticker)
			out[i].Underlying = ticker
		} else {
			out[i].Reference = "" // an issuer whose naming rule isn't known: name it when adding
		}
	}
	return out
}

// listBooks is every active instrument, with asset names, as books the desk can add.
func listBooks(ctx context.Context, rest *tm.REST) ([]quoter.Listing, error) {
	instruments, err := rest.Instruments(ctx)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	if assets, err := rest.Assets(ctx); err == nil {
		for _, a := range assets {
			names[string(a.ID)] = a.Fields.Name
		}
	}
	var out []quoter.Listing
	for _, inst := range instruments {
		if inst.Status != "ACTIVE" {
			continue
		}
		sym := inst.Info.Symbol
		base, quote, _ := cutSymbol(sym)
		if n := names[string(inst.Info.BaseAssetID)]; n != "" {
			base = n
		}
		if n := names[string(inst.Info.QuoteAssetID)]; n != "" {
			quote = n
		}
		symBase, _, _ := cutSymbol(sym)
		out = append(out, quoter.Listing{
			Symbol: sym, InstrumentID: string(inst.ID),
			BaseAssetID: string(inst.Info.BaseAssetID), QuoteAssetID: string(inst.Info.QuoteAssetID),
			BaseSymbol: base, QuoteSymbol: quote,
			// The same base asset in USD on Coinbase: BTC-USDC -> BTC-USD.
			Reference: symBase + "-USD", Underlying: symBase,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	if len(out) == 0 {
		return nil, errors.New("the exchange lists no active instruments")
	}
	return out, nil
}

func cutSymbol(s string) (string, string, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == '-' || s[i] == '/' {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

// cancelLeftovers cancels every resting order carrying our prefix, on any book.
func cancelLeftovers(ctx context.Context, rest *tm.REST, ids *quoter.Book, log *slog.Logger) error {
	active, err := rest.ActiveOrders(ctx)
	if err != nil {
		return err
	}
	n := 0
	for _, o := range active {
		if !ids.IsOurs(o.ExternalID) {
			continue
		}
		if err := rest.CancelOrder(ctx, o.ExternalID); err != nil && !tm.IsRejection(err) {
			return err
		}
		n++
	}
	if n > 0 {
		log.Info("canceled orders left by an earlier run", "count", n)
	}
	return nil
}

// checkAdminAddr refuses to serve the management API beyond this machine without a token: anyone
// who can reach it can change how your money is quoted.
func checkAdminAddr(addr, token string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("ADMIN_ADDR %q: %w", addr, err)
	}
	ip := net.ParseIP(host)
	loopback := host == "localhost" || (ip != nil && ip.IsLoopback())
	if !loopback && token == "" {
		return fmt.Errorf("ADMIN_ADDR %s is reachable from other machines; set ADMIN_TOKEN too", addr)
	}
	return nil
}
