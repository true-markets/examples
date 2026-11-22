package quoter

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Listing is a book the exchange offers, which the desk can add.
type Listing struct {
	Symbol       string `json:"symbol"`
	InstrumentID string `json:"instrumentId"`
	BaseAssetID  string `json:"baseAssetId"`
	QuoteAssetID string `json:"quoteAssetId"`
	BaseSymbol   string `json:"baseSymbol"`
	QuoteSymbol  string `json:"quoteSymbol"`
	// Reference is where the book's fair value comes from unless it names another: for crypto,
	// the base asset in USD on Coinbase (BTC-USDC -> BTC-USD); for a tokenized stock, the stock's
	// perp on Hyperliquid (GOOGLC-USDC -> hyperliquid:xyz:GOOGL). Empty if there's no good default.
	Reference string `json:"reference"`
}

// BookConfig is what's saved for each book: enough to add it again on the next start.
type BookConfig struct {
	Reference string `json:"reference"`
	Params    Params `json:"params"`
}

// DeskConfig is everything the desk needs that isn't a book.
type DeskConfig struct {
	Mode        string // live or paper
	Environment string // production, uat or paper
	ClientID    string
	Transport   string // rest or fix
	IDPrefix    string
	Defaults    Params // for books added without their own settings
	Catalog     []Listing
	Venue       Venue
	// NewTransport makes the order transport for one book.
	NewTransport func(Market) Transport
	// CheckReference fails if the reference product doesn't exist. Optional.
	CheckReference func(ctx context.Context, product string) error
	// OnAdd subscribes the feeds a new book needs (its EBBO, its reference). Optional.
	OnAdd func(Market)
	// Save stores the books after any change, so they come back on the next start. Optional.
	Save func(map[string]BookConfig) error
	Log  *slog.Logger
}

// Desk runs every book in the process. It owns what the books share: one Ledger (so two books
// never spend the same balance), one balance read for all of them, one drop copy, one market-data
// connection and one reference feed, routed to the book each message is for.
type Desk struct {
	cfg     DeskConfig
	ledger  *Ledger
	journal *Journal
	log     *slog.Logger
	catalog map[string]Listing
	names   map[string]string // asset id -> symbol
	started time.Time

	mu           sync.Mutex
	ctx          context.Context
	books        map[string]*deskBook // by symbol
	byInstrument map[string]*Engine
	conns        map[string]*ConnState
}

type deskBook struct {
	engine    *Engine
	reference string
	cancel    context.CancelFunc
	done      chan struct{}
}

func NewDesk(cfg DeskConfig) *Desk {
	d := &Desk{
		cfg:          cfg,
		ledger:       NewLedger(),
		journal:      NewJournal(),
		log:          cfg.Log,
		catalog:      map[string]Listing{},
		names:        map[string]string{},
		started:      time.Now(),
		books:        map[string]*deskBook{},
		byInstrument: map[string]*Engine{},
		conns:        map[string]*ConnState{},
	}
	for _, l := range cfg.Catalog {
		d.catalog[l.Symbol] = l
		d.names[l.BaseAssetID] = l.BaseSymbol
		d.names[l.QuoteAssetID] = l.QuoteSymbol
		if l.QuoteSymbol == "USDC" {
			d.ledger.SetFeeAsset(l.QuoteAssetID)
		}
	}
	for _, c := range []string{ConnDropCopy, ConnMarket, ConnReference} {
		d.conns[c] = &ConnState{Since: time.Now(), Reason: "connecting"}
	}
	return d
}

func (d *Desk) Ledger() *Ledger { return d.ledger }

// Trades is every fill this run, newest first (up to limit; 0 for all), with mark-outs.
func (d *Desk) Trades(limit int) TradesReport { return d.journal.Report(limit) }

// --- books -----------------------------------------------------------------------------------

// Add starts managing a book, stopped (or quoting, if enabled). reference "" uses the listing's
// default; params nil uses the desk's defaults.
func (d *Desk) Add(ctx context.Context, symbol, ref string, params *Params, enabled bool) (Market, error) {
	l, ok := d.catalog[symbol]
	if !ok {
		return Market{}, fmt.Errorf("%s is not a book on %s", symbol, d.cfg.Environment)
	}
	if ref == "" {
		ref = l.Reference
	}
	ref = reference.Normalize(ref)
	if ref == "" {
		return Market{}, fmt.Errorf("%s has no default reference price; name one (a Coinbase product like BTC-USD, or hyperliquid:xyz:TICKER)", symbol)
	}
	p := d.cfg.Defaults
	if params != nil {
		p = *params
	}
	if err := p.Validate(); err != nil {
		return Market{}, err
	}
	d.mu.Lock()
	_, exists := d.books[symbol]
	d.mu.Unlock()
	if exists {
		return Market{}, fmt.Errorf("%s is already added", symbol)
	}
	if d.cfg.CheckReference != nil {
		if err := d.cfg.CheckReference(ctx, ref); err != nil {
			return Market{}, fmt.Errorf("%s for %s: %w", reference.Describe(ref), symbol, err)
		}
	}

	market := Market{
		Symbol: l.Symbol, InstrumentID: l.InstrumentID, BaseAssetID: l.BaseAssetID, QuoteAssetID: l.QuoteAssetID,
		BaseSymbol: l.BaseSymbol, QuoteSymbol: l.QuoteSymbol, Reference: ref,
	}
	book := NewBook(d.cfg.IDPrefix, l.InstrumentID)
	e := NewEngine(market, p, d.cfg.Venue, d.ledger, d.cfg.NewTransport(market), book, enabled, d.log.With("book", symbol))
	e.journal = d.journal

	d.mu.Lock()
	if _, exists := d.books[symbol]; exists {
		d.mu.Unlock()
		return Market{}, fmt.Errorf("%s is already added", symbol)
	}
	d.ledger.Register(book, l.BaseAssetID, l.QuoteAssetID)
	db := &deskBook{engine: e, reference: ref}
	d.books[symbol] = db
	d.byInstrument[l.InstrumentID] = e
	for name, c := range d.conns {
		e.SetConn(name, c.Up, c.Reason)
	}
	if d.ctx != nil {
		d.startLocked(db)
	}
	d.mu.Unlock()

	if d.cfg.OnAdd != nil {
		d.cfg.OnAdd(market)
	}
	d.log.Info("book added", "book", symbol, "reference", reference.Describe(ref), "enabled", enabled)
	d.save()
	return market, nil
}

// Remove stops managing a book. It must be stopped with nothing resting.
func (d *Desk) Remove(symbol string) error {
	d.mu.Lock()
	db := d.books[symbol]
	if db == nil {
		d.mu.Unlock()
		return fmt.Errorf("%s isn't added", symbol)
	}
	if !db.engine.Idle() {
		d.mu.Unlock()
		return fmt.Errorf("stop %s and let its orders come down before removing it", symbol)
	}
	delete(d.books, symbol)
	delete(d.byInstrument, db.engine.market.InstrumentID)
	d.ledger.Unregister(db.engine.book)
	d.mu.Unlock()
	if db.cancel != nil {
		db.cancel()
		<-db.done
	}
	d.log.Info("book removed", "book", symbol)
	d.save()
	return nil
}

// Engine is one book's engine, or nil.
func (d *Desk) Engine(symbol string) *Engine {
	d.mu.Lock()
	defer d.mu.Unlock()
	if db := d.books[symbol]; db != nil {
		return db.engine
	}
	return nil
}

func (d *Desk) engines() []*Engine {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]*Engine, 0, len(d.books))
	for _, db := range d.books {
		out = append(out, db.engine)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].market.Symbol < out[j].market.Symbol })
	return out
}

// UpdateParams changes one book's parameters and saves them.
func (d *Desk) UpdateParams(symbol string, patch []byte) (Params, error) {
	e := d.Engine(symbol)
	if e == nil {
		return Params{}, fmt.Errorf("%s isn't added", symbol)
	}
	p, err := e.UpdateParams(patch)
	if err == nil {
		d.save()
	}
	return p, err
}

// SetEnabled starts or stops every book.
func (d *Desk) SetEnabled(on bool) {
	for _, e := range d.engines() {
		e.SetEnabled(on)
	}
}

func (d *Desk) save() {
	if d.cfg.Save == nil {
		return
	}
	d.mu.Lock()
	out := map[string]BookConfig{}
	for sym, db := range d.books {
		out[sym] = BookConfig{Reference: db.reference, Params: db.engine.Params()}
	}
	d.mu.Unlock()
	if err := d.cfg.Save(out); err != nil {
		d.log.Warn("saving books failed", "err", err)
	}
}

// --- running ---------------------------------------------------------------------------------

// Run starts every book's loop and reads balances for all of them until ctx ends.
func (d *Desk) Run(ctx context.Context) {
	d.mu.Lock()
	d.ctx = ctx
	for _, db := range d.books {
		d.startLocked(db)
	}
	d.mu.Unlock()

	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		d.maybeReadBalances(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (d *Desk) startLocked(db *deskBook) {
	ctx, cancel := context.WithCancel(d.ctx)
	db.cancel, db.done = cancel, make(chan struct{})
	go func() {
		defer close(db.done)
		db.engine.Run(ctx)
	}()
}

// maybeReadBalances reads GET /balances for every book at once. The WebSocket has no balance
// channel, so this is the one thing polled. In between, the ledger follows our own holds live and
// debits fills.
func (d *Desk) maybeReadBalances(ctx context.Context) {
	if !d.ledger.Due(balanceEvery, balanceMaxStale) {
		return
	}
	first := d.ledger.ReadAt().IsZero()
	b, err := d.cfg.Venue.Balances(ctx)
	if err != nil {
		if ctx.Err() == nil {
			d.log.Warn("reading balances failed", "err", err)
		}
		d.ledger.Retry()
		return
	}
	d.ledger.OnBalances(b)
	for _, e := range d.engines() {
		e.Nudge()
	}
	if first {
		var parts []string
		for _, a := range d.ledger.Snapshot(d.names) {
			if a.Symbol != "" {
				parts = append(parts, a.Free.String()+" "+a.Symbol)
			}
		}
		sort.Strings(parts)
		d.log.Info("balances read", "free", strings.Join(parts, ", "))
	}
}

// Shutdown stops every book and waits up to timeout for their cancels to be confirmed. It returns
// how many orders are still resting.
func (d *Desk) Shutdown(ctx context.Context, timeout time.Duration) int {
	engines := d.engines()
	for _, e := range engines {
		e.SetEnabled(false)
	}
	deadline := time.Now().Add(timeout)
	for {
		left := 0
		for _, e := range engines {
			e.pullQuotes(ctx, "shutting down")
			left += e.book.Len()
		}
		if left == 0 || time.Now().After(deadline) {
			return left
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// --- feeds -----------------------------------------------------------------------------------

// SetConn records a shared connection going up or down, for every book.
func (d *Desk) SetConn(name string, up bool, reason string) {
	d.mu.Lock()
	d.conns[name] = &ConnState{Up: up, Reason: reason, Since: time.Now()}
	d.mu.Unlock()
	for _, e := range d.engines() {
		e.SetConn(name, up, reason)
	}
}

// OnDropCopy routes a drop copy to the book its instrument belongs to.
func (d *Desk) OnDropCopy(m tm.Message) {
	if m.Channel != "DROPCOPY" || len(m.Data) == 0 {
		return
	}
	var dc tm.DropCopy
	if err := json.Unmarshal(m.Data, &dc); err != nil {
		d.log.Warn("unparseable drop copy", "err", err)
		return
	}
	d.mu.Lock()
	e := d.byInstrument[string(dc.InstrumentID)]
	d.mu.Unlock()
	if e != nil {
		e.OnDropCopy(dc)
	}
}

// OnMarket routes an EBBO update to its book.
func (d *Desk) OnMarket(m tm.Message) {
	if m.Channel != "EBBO" || len(m.Data) == 0 {
		return
	}
	var eb tm.EBBO
	if json.Unmarshal(m.Data, &eb) != nil {
		return
	}
	if e := d.Engine(eb.Symbol); e != nil {
		e.OnEBBO(eb)
	}
}

// OnTick routes a reference tick to every book priced off it.
func (d *Desk) OnTick(t reference.Tick) {
	d.mu.Lock()
	var targets []*Engine
	for _, db := range d.books {
		if db.reference == t.Reference {
			targets = append(targets, db.engine)
		}
	}
	d.mu.Unlock()
	for _, e := range targets {
		e.OnReference(t)
	}
}

// OnCancelReject hands a FIX OrderCancelReject to every book; the one that sent it acts on it.
func (d *Desk) OnCancelReject(clOrdID, origClOrdID, responseTo, text string) {
	for _, e := range d.engines() {
		e.OnCancelReject(clOrdID, origClOrdID, responseTo, text)
	}
}

// --- status ----------------------------------------------------------------------------------

// DeskStatus is the whole process at a glance: shared connections and balances, one line per
// book, and the books that could be added.
type DeskStatus struct {
	Mode           string                `json:"mode"`
	Environment    string                `json:"environment"`
	Transport      string                `json:"transport"`
	ClientID       string                `json:"clientId"`
	StartedAt      time.Time             `json:"startedAt"`
	Connections    map[string]*ConnState `json:"connections"`
	Balances       []AssetBalance        `json:"balances"`
	BalancesReadAt *time.Time            `json:"balancesReadAt"`
	Books          []Summary             `json:"books"`
	Available      []Listing             `json:"available"`
	Warnings       []string              `json:"warnings"`
	// Totals adds every book up, per quote currency (PnL and volume can't be added across them).
	Totals []Totals `json:"totals"`
	// Trades rolls up every fill this run: edge at fill and mark-outs.
	Trades TradeSummary `json:"trades"`
}

// Totals is every book on one quote currency, added up.
type Totals struct {
	Quote         string          `json:"quote"`
	Books         int             `json:"books"`
	Quoting       int             `json:"quoting"`
	RealizedPnl   decimal.Decimal `json:"realizedPnl"`
	UnrealizedPnl decimal.Decimal `json:"unrealizedPnl"`
	VolumeQuote   decimal.Decimal `json:"volumeQuote"`
	Orders        int             `json:"orders"`
	Stats         Stats           `json:"stats"`
}

func (d *Desk) Status() DeskStatus {
	s := DeskStatus{
		Mode: d.cfg.Mode, Environment: d.cfg.Environment, Transport: d.cfg.Transport, ClientID: d.cfg.ClientID,
		StartedAt: d.started, Connections: map[string]*ConnState{}, Books: []Summary{}, Available: []Listing{}, Warnings: []string{},
	}
	d.mu.Lock()
	for k, v := range d.conns {
		c := *v
		s.Connections[k] = &c
	}
	d.mu.Unlock()
	engines := d.engines()
	if len(engines) > 0 && engines[0].tx != nil {
		up, reason := engines[0].tx.Ready(), ""
		if !up {
			reason = engines[0].tx.Name() + " order entry not connected"
		}
		s.Connections[ConnOrders] = &ConnState{Up: up, Reason: reason}
	}
	s.Balances = d.ledger.Snapshot(d.names)
	// Value each asset in the quote currency: the quote is 1, a base asset is priced by any book's
	// reference mid.
	prices := map[string]decimal.Decimal{}
	for _, e := range engines {
		m := e.market
		prices[m.QuoteAssetID] = decimal.NewFromInt(1)
		e.mu.Lock()
		if e.ref != nil && e.ref.Mid.IsPositive() {
			prices[m.BaseAssetID] = e.ref.Mid
		}
		e.mu.Unlock()
	}
	for i := range s.Balances {
		if px, ok := prices[s.Balances[i].AssetID]; ok {
			s.Balances[i].Price = &px
		}
	}
	sort.Slice(s.Balances, func(i, j int) bool { return s.Balances[i].Symbol < s.Balances[j].Symbol })
	if t := d.ledger.ReadAt(); !t.IsZero() {
		s.BalancesReadAt = &t
	}
	added := map[string]bool{}
	for _, e := range engines {
		s.Books = append(s.Books, e.Summary())
		added[e.market.Symbol] = true
	}
	for _, l := range d.cfg.Catalog {
		if !added[l.Symbol] {
			s.Available = append(s.Available, l)
		}
	}
	s.Warnings = sharedFundsWarnings(s.Books)
	s.Totals = totals(s.Books)
	s.Trades = d.journal.Report(1).Total
	return s
}

func totals(books []Summary) []Totals {
	by := map[string]*Totals{}
	var order []string
	for _, b := range books {
		q := b.Market.QuoteSymbol
		t := by[q]
		if t == nil {
			t = &Totals{Quote: q}
			by[q] = t
			order = append(order, q)
		}
		t.Books++
		if b.State == "quoting" {
			t.Quoting++
		}
		t.RealizedPnl = t.RealizedPnl.Add(b.RealizedPnl)
		t.UnrealizedPnl = t.UnrealizedPnl.Add(b.UnrealizedPnl)
		t.VolumeQuote = t.VolumeQuote.Add(b.VolumeQuote)
		t.Orders += b.Orders
		st := b.Stats
		t.Stats.Creates += st.Creates
		t.Stats.Modifies += st.Modifies
		t.Stats.Cancels += st.Cancels
		t.Stats.Rejects += st.Rejects
		t.Stats.Errors += st.Errors
		t.Stats.Fills += st.Fills
		t.Stats.Takes += st.Takes
		t.Stats.TakeFills += st.TakeFills
	}
	out := []Totals{}
	for _, q := range order {
		out = append(out, *by[q])
	}
	return out
}

// sharedFundsWarnings flags running books that draw on the same asset with no allocation between
// them. Nothing goes wrong at the exchange (the ledger hands each unit out once), but whichever
// book asks first can take all of it.
func sharedFundsWarnings(books []Summary) []string {
	type use struct {
		uncapped, total []string
		field           string
	}
	uses := map[string]*use{}
	add := func(asset, symbol string, capped bool, field string) {
		u := uses[asset]
		if u == nil {
			u = &use{field: field}
			uses[asset] = u
		}
		u.total = append(u.total, symbol)
		if !capped {
			u.uncapped = append(u.uncapped, symbol)
		}
	}
	for _, b := range books {
		if !b.Enabled {
			continue
		}
		add(b.Market.QuoteSymbol, b.Market.Symbol, b.MaxQuoteAlloc.IsPositive(), "maxQuoteAlloc")
		add(b.Market.BaseSymbol, b.Market.Symbol, b.BaseCapped, "maxBaseAlloc")
	}
	out := []string{}
	var assets []string
	for a := range uses {
		assets = append(assets, a)
	}
	sort.Strings(assets)
	for _, a := range assets {
		u := uses[a]
		if len(u.total) > 1 && len(u.uncapped) > 0 {
			out = append(out, fmt.Sprintf("%s all draw on %s, and %s has no %s, so whichever book asks first can take all of it; give each book an allocation", strings.Join(u.total, ", "), a, strings.Join(u.uncapped, ", "), u.field))
		}
	}
	return out
}
