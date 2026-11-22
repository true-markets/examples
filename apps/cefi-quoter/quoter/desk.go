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
	// Underlying is what the book tracks, for finding more sources: a stock's ticker (GOOGL) or
	// a crypto asset (BTC). Stock says which.
	Underlying string `json:"underlying,omitempty"`
	Stock      bool   `json:"stock,omitempty"`
}

// BookConfig is what's saved for each book: enough to add it again on the next start.
type BookConfig struct {
	Blend  *reference.BlendConfig `json:"blend,omitempty"`
	Params Params                 `json:"params"`
}

// DeskConfig is everything the desk needs that isn't a book.
type DeskConfig struct {
	Mode        string // live or paper
	Environment string // production, uat or paper
	ClientID    string
	Transport   string // rest or fix
	IDPrefix    string
	// OrderRate is the most order requests a second, across every book (see Pacer). 0 for no
	// limit of our own; a rate-limit reject still pauses sending.
	OrderRate int
	Defaults  Params // for books added without their own settings
	Catalog   []Listing
	Venue     Venue
	// NewTransport makes the order transport for one book.
	NewTransport func(Market) Transport
	// CheckReference fails if a reference source doesn't exist. Optional.
	CheckReference func(ctx context.Context, ref string) error
	// Subscribe starts streaming a reference source. Optional.
	Subscribe func(ref string)
	// Suggest lists the reference sources for an underlying. Optional.
	Suggest func(ctx context.Context, underlying string, stock bool) []reference.Source
	// OnAdd subscribes the venue's feeds for a new book (its EBBO). Optional.
	OnAdd func(Market)
	// OnReference sees every book's blended reference price (the paper exchange fills from it).
	// Optional.
	OnReference func(symbol string, t reference.Tick)
	// Save stores the books after any change, so they come back on the next start. Optional.
	Save func(map[string]BookConfig) error
	// SaveState stores position, PnL, activity and the trade journal, so a restart picks up where
	// this run left off (see state.go). Optional.
	SaveState func(State) error
	Log       *slog.Logger
}

// Desk runs every book in the process. It owns what the books share: one Ledger (so two books
// never spend the same balance), one balance read for all of them, one drop copy, one market-data
// connection and one reference feed, routed to the book each message is for.
type Desk struct {
	cfg     DeskConfig
	ledger  *Ledger
	pacer   *Pacer
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
	latest       map[string]reference.Tick // every reference source's last tick
	checked      map[string]time.Time      // sources found to exist, and when
	saved        *State                    // the last run's state, for books still to be added
	lastState    []byte                    // the state last written, to skip unchanged writes
}

type deskBook struct {
	engine *Engine
	blend  reference.BlendConfig
	view   reference.BlendView
	// flagged is each source's last state worth an event (out of line, or a suspected corporate
	// action), so the events log one line per change rather than one per tick.
	flagged map[string]string
	// resting is what the last run left resting on this book, until RecoverMissedFills checks it.
	resting []OrderState
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewDesk(cfg DeskConfig) *Desk {
	d := &Desk{
		cfg:          cfg,
		ledger:       NewLedger(),
		pacer:        NewPacer(cfg.OrderRate),
		journal:      NewJournal(),
		log:          cfg.Log,
		catalog:      map[string]Listing{},
		names:        map[string]string{},
		started:      time.Now(),
		books:        map[string]*deskBook{},
		byInstrument: map[string]*Engine{},
		conns:        map[string]*ConnState{},
		latest:       map[string]reference.Tick{},
		checked:      map[string]time.Time{},
	}
	for _, l := range cfg.Catalog {
		d.catalog[l.Symbol] = l
		d.names[l.BaseAssetID] = l.BaseSymbol
		d.names[l.QuoteAssetID] = l.QuoteSymbol
		if IsUSD(l.QuoteSymbol) {
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

// Add starts managing a book, stopped (or quoting, if enabled). blend nil uses the listing's
// default reference; params nil uses the desk's defaults.
func (d *Desk) Add(ctx context.Context, symbol string, blend *reference.BlendConfig, params *Params, enabled bool) (Market, error) {
	l, ok := d.catalog[symbol]
	if !ok {
		return Market{}, fmt.Errorf("%s is not a book on %s", symbol, d.cfg.Environment)
	}
	cfg, err := d.blendFor(ctx, l, blend)
	if err != nil {
		return Market{}, err
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

	market := Market{
		Symbol: l.Symbol, InstrumentID: l.InstrumentID, BaseAssetID: l.BaseAssetID, QuoteAssetID: l.QuoteAssetID,
		BaseSymbol: l.BaseSymbol, QuoteSymbol: l.QuoteSymbol, Reference: cfg.Primary(), Blend: cfg,
	}
	book := NewBook(d.cfg.IDPrefix, l.InstrumentID)
	e := NewEngine(market, p, d.cfg.Venue, d.ledger, d.cfg.NewTransport(market), book, enabled, d.log.With("book", symbol))
	e.journal = d.journal
	e.pacer = d.pacer

	d.mu.Lock()
	if _, exists := d.books[symbol]; exists {
		d.mu.Unlock()
		return Market{}, fmt.Errorf("%s is already added", symbol)
	}
	d.ledger.Register(book, l.BaseAssetID, l.QuoteAssetID)
	db := &deskBook{engine: e, blend: cfg, flagged: map[string]string{}}
	d.restoreBookLocked(db, symbol)
	d.books[symbol] = db
	d.byInstrument[l.InstrumentID] = e
	for name, c := range d.conns {
		e.SetConn(name, c.Up, c.Reason)
	}
	if d.ctx != nil {
		d.startLocked(db)
	}
	d.mu.Unlock()

	d.subscribe(cfg)
	if d.cfg.OnAdd != nil {
		d.cfg.OnAdd(market)
	}
	d.log.Info("book added", "book", symbol, "reference", cfg.Describe(), "enabled", enabled)
	d.save()
	return market, nil
}

// blendFor checks a book's reference: every source must exist. nil means the listing's default.
func (d *Desk) blendFor(ctx context.Context, l Listing, blend *reference.BlendConfig) (reference.BlendConfig, error) {
	var cfg reference.BlendConfig
	if blend != nil {
		cfg = *blend
	} else {
		if l.Reference == "" {
			return cfg, fmt.Errorf("%s has no default reference price; name one (a Coinbase product like BTC-USD, hyperliquid:xyz:TICKER, or kraken:TICKERx/USD)", l.Symbol)
		}
		cfg = reference.Single(l.Reference)
	}
	cfg, err := cfg.Normalized()
	if err != nil {
		return cfg, fmt.Errorf("%s reference: %w", l.Symbol, err)
	}
	for _, s := range cfg.Sources {
		if err := d.check(ctx, s.Ref); err != nil {
			return cfg, fmt.Errorf("%s for %s: %w", reference.Describe(s.Ref), l.Symbol, err)
		}
	}
	return cfg, nil
}

// check asks the source whether a reference exists, remembering a yes for a while: the preview
// asks every couple of seconds.
func (d *Desk) check(ctx context.Context, ref string) error {
	if d.cfg.CheckReference == nil {
		return nil
	}
	d.mu.Lock()
	at, ok := d.checked[ref]
	d.mu.Unlock()
	if ok && time.Since(at) < 10*time.Minute {
		return nil
	}
	if err := d.cfg.CheckReference(ctx, ref); err != nil {
		return err
	}
	d.mu.Lock()
	d.checked[ref] = time.Now()
	d.mu.Unlock()
	return nil
}

func (d *Desk) subscribe(cfg reference.BlendConfig) {
	if d.cfg.Subscribe == nil {
		return
	}
	for _, s := range cfg.Sources {
		d.cfg.Subscribe(s.Ref)
	}
}

// SetBlend changes a book's reference: its sources, weights and multipliers. It takes effect on
// the next tick, quoting or not.
func (d *Desk) SetBlend(ctx context.Context, symbol string, blend reference.BlendConfig) (Market, error) {
	l, ok := d.catalog[symbol]
	if !ok || d.Engine(symbol) == nil {
		return Market{}, fmt.Errorf("%s isn't added", symbol)
	}
	cfg, err := d.blendFor(ctx, l, &blend)
	if err != nil {
		return Market{}, err
	}
	d.subscribe(cfg)
	d.mu.Lock()
	db := d.books[symbol]
	if db == nil {
		d.mu.Unlock()
		return Market{}, fmt.Errorf("%s isn't added", symbol)
	}
	db.blend = cfg
	db.flagged = map[string]string{}
	e := db.engine
	d.mu.Unlock()
	e.mu.Lock()
	e.market.Reference, e.market.Blend = cfg.Primary(), cfg
	e.eventLocked("reference", "reference set to "+cfg.Describe())
	m := e.market
	e.mu.Unlock()
	d.log.Info("reference changed", "book", symbol, "reference", cfg.Describe())
	d.reprice(symbol, false)
	d.save()
	return m, nil
}

// Preview is a reference config evaluated against live prices, before it's saved: each source's
// price and the blend they make, and, for a book already quoting, the book's own price next to it.
type Preview struct {
	Symbol string              `json:"symbol"`
	Blend  reference.BlendView `json:"blend"`
	// The book on the exchange, if it's added and its market data is in.
	BookBid *decimal.Decimal `json:"bookBid"`
	BookAsk *decimal.Decimal `json:"bookAsk"`
	BookMid *decimal.Decimal `json:"bookMid"`
	// BookGapBps is the book's mid against the blend: a large, steady gap suggests the token
	// carries a multiplier the token multiplier doesn't have yet.
	BookGapBps *float64 `json:"bookGapBps"`
	// TokenMultiplier is what the token multiplier would be for the blend to match the book's mid.
	TokenMultiplier *decimal.Decimal `json:"tokenMultiplier"`
	Warnings        []string         `json:"warnings"`
}

// Preview evaluates a reference config for a book. Its sources are checked and subscribed, so a
// first preview may show them waiting; ask again in a second or two. Sources stay subscribed
// until the quoter restarts.
func (d *Desk) Preview(ctx context.Context, symbol string, blend reference.BlendConfig) (Preview, error) {
	l, ok := d.catalog[symbol]
	if !ok {
		return Preview{}, fmt.Errorf("%s is not a book on %s", symbol, d.cfg.Environment)
	}
	cfg, err := d.blendFor(ctx, l, &blend)
	if err != nil {
		return Preview{}, err
	}
	d.subscribe(cfg)
	maxAge := time.Duration(d.cfg.Defaults.RefStaleMs) * time.Millisecond
	d.mu.Lock()
	latest := d.latestLocked(cfg)
	db := d.books[symbol]
	d.mu.Unlock()
	if db != nil {
		maxAge = time.Duration(db.engine.Params().RefStaleMs) * time.Millisecond
	}
	pv := Preview{Symbol: symbol, Blend: reference.Evaluate(cfg, latest, time.Now(), maxAge), Warnings: []string{}}
	if db != nil {
		e := db.engine
		e.mu.Lock()
		if e.bestBid != nil && e.bestAsk != nil {
			b, a := *e.bestBid, *e.bestAsk
			m := b.Add(a).Div(decimal.NewFromInt(2))
			pv.BookBid, pv.BookAsk, pv.BookMid = &b, &a, &m
		}
		e.mu.Unlock()
	}
	if pv.BookMid != nil && pv.Blend.Mid != nil && pv.Blend.Mid.IsPositive() {
		gap := pv.BookMid.Div(*pv.Blend.Mid).Sub(decimal.NewFromInt(1)).Mul(tenK).InexactFloat64()
		pv.BookGapBps = &gap
		if pv.Blend.PerShare != nil && pv.Blend.PerShare.IsPositive() {
			tm := pv.BookMid.Div(*pv.Blend.PerShare).Round(6)
			pv.TokenMultiplier = &tm
		}
		if gap > 200 || gap < -200 {
			pv.Warnings = append(pv.Warnings, fmt.Sprintf("%s trades %+.0f bps from this reference. Our own quotes are part of that book, so the gap is only telling when other people's orders make up the touch; if they do, the token may represent more or less than one share: try a token multiplier of %s", symbol, gap, pv.TokenMultiplier))
		}
	}
	if pv.Blend.Used == 1 && len(cfg.Sources) == 1 {
		pv.Warnings = append(pv.Warnings, "one source: nothing to check it against, so a bad or pushed price goes straight into the quotes. Add a second source, even at weight 0 to watch it")
	}
	return pv, nil
}

// SuggestSources lists the reference sources found for a book's underlying.
func (d *Desk) SuggestSources(ctx context.Context, symbol string) ([]reference.Source, error) {
	l, ok := d.catalog[symbol]
	if !ok {
		return nil, fmt.Errorf("%s is not a book on %s", symbol, d.cfg.Environment)
	}
	if d.cfg.Suggest == nil || l.Underlying == "" {
		if l.Reference == "" {
			return []reference.Source{}, nil
		}
		return []reference.Source{{Ref: l.Reference, Weight: 1}}, nil
	}
	out := d.cfg.Suggest(ctx, l.Underlying, l.Stock)
	if out == nil {
		out = []reference.Source{}
	}
	return out, nil
}

func (d *Desk) latestLocked(cfg reference.BlendConfig) map[string]reference.Tick {
	out := make(map[string]reference.Tick, len(cfg.Sources))
	for _, s := range cfg.Sources {
		if t, ok := d.latest[s.Ref]; ok {
			out[s.Ref] = t
		}
	}
	return out
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
		b := db.blend
		out[sym] = BookConfig{Blend: &b, Params: db.engine.Params()}
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
	lastSave := time.Now()
	for {
		d.maybeReadBalances(ctx)
		if time.Since(lastSave) >= stateEvery {
			d.SaveState(false)
			lastSave = time.Now()
		}
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

// OnTick takes a tick from one reference source and reprices every book that blends it in.
func (d *Desk) OnTick(t reference.Tick) {
	d.mu.Lock()
	d.latest[t.Reference] = t
	var symbols []string
	for sym, db := range d.books {
		if db.blend.Has(t.Reference) {
			symbols = append(symbols, sym)
		}
	}
	d.mu.Unlock()
	for _, sym := range symbols {
		d.reprice(sym, t.Heartbeat)
	}
}

// reprice works out one book's blended reference from its sources' latest ticks, and hands it to
// the book: a price, or why there isn't one.
func (d *Desk) reprice(symbol string, heartbeat bool) {
	d.mu.Lock()
	db := d.books[symbol]
	if db == nil {
		d.mu.Unlock()
		return
	}
	cfg, latest, e := db.blend, d.latestLocked(db.blend), db.engine
	d.mu.Unlock()
	view := reference.Evaluate(cfg, latest, time.Now(), time.Duration(e.Params().RefStaleMs)*time.Millisecond)

	d.mu.Lock()
	db.view = view
	var news []string
	for _, s := range view.Sources {
		mark := s.State
		if s.Action != nil && s.Action.Kind != "drift" {
			mark += " " + s.Action.Kind
		}
		if prev, ok := db.flagged[s.Ref]; ok && prev == mark {
			continue
		}
		prev := db.flagged[s.Ref]
		db.flagged[s.Ref] = mark
		switch {
		case s.State == "out" && s.Action != nil:
			news = append(news, s.Name+" left out of the reference: "+s.Action.Text)
		case s.State == "in" && strings.HasPrefix(prev, "out"):
			news = append(news, s.Name+" back in line with the other sources")
		case s.State == "watch" && s.Action != nil && s.Action.Kind != "drift":
			news = append(news, s.Name+" (watched): "+s.Action.Text)
		}
	}
	d.mu.Unlock()
	if len(news) > 0 {
		e.mu.Lock()
		for _, n := range news {
			e.eventLocked("reference", n)
		}
		e.mu.Unlock()
		for _, n := range news {
			d.log.Warn(n, "book", symbol)
		}
	}

	t, ok := view.Tick(cfg.Primary(), heartbeat)
	if !ok {
		e.OnReferenceProblem(view.Problem)
		return
	}
	e.OnReference(t)
	if d.cfg.OnReference != nil && !heartbeat {
		d.cfg.OnReference(symbol, t)
	}
}

// BookStatus is one book in full, with its reference blend.
func (d *Desk) BookStatus(symbol string) (Status, bool) {
	d.mu.Lock()
	db := d.books[symbol]
	d.mu.Unlock()
	if db == nil {
		return Status{}, false
	}
	s := db.engine.Status()
	d.mu.Lock()
	v := db.view
	d.mu.Unlock()
	if v.Sources == nil {
		v = reference.Evaluate(db.blend, nil, time.Now(), time.Second)
	}
	s.Blend = &v
	return s, true
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
