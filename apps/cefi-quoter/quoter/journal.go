package quoter

import (
	"sort"
	"sync"
	"time"

	"github.com/shopspring/decimal"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// The journal keeps every fill this run, with how good it was when it happened and how good it
// still looked later.
//
//   - Edge at fill: how far the fill price was from fair value (the reference mid) in our favor,
//     in bps. A bid filled 10 bps under the mid has +10 bps of edge.
//   - Mark-outs: the same measure against the reference mid 30 seconds and 5 minutes later. A
//     maker is filled exactly when the market moves through its quote, so the mid often keeps
//     going: a +10 bps fill that marks out at -5 bps after 30 seconds was a loser, however good
//     it looked at the time. That is adverse selection, and it's what a market maker's spread is
//     paying for.
//   - Retention: mark-out over edge at fill. 100% means the edge held; below 0 means the market
//     took all of it and more.
//
// Saved in the state file with the rest of the desk, so it survives a restart.

// MarkoutHorizons are when each fill is marked again.
var MarkoutHorizons = []time.Duration{30 * time.Second, 300 * time.Second}

const journalSize = 5000

// markGrace is how late a mark-out may be taken. Later than this (the quoter was down when it came
// due) the price then is gone, and the mark-out stays empty.
const markGrace = 30 * time.Second

// Trade is one fill.
type Trade struct {
	ID       int             `json:"id"`
	Time     time.Time       `json:"time"`
	Symbol   string          `json:"symbol"`
	Quote    string          `json:"quote"` // the quote currency notional and PnL are in
	Side     Side            `json:"side"`
	Kind     string          `json:"kind"` // maker, profit take or takeout
	Level    int             `json:"level"`
	Qty      decimal.Decimal `json:"qty"`
	Price    decimal.Decimal `json:"price"`
	Notional decimal.Decimal `json:"notional"`
	RefMid   decimal.Decimal `json:"refMid"`  // fair value when it filled
	EdgeBps  float64         `json:"edgeBps"` // in our favor; negative for a fill worse than fair
	// Mark-outs at each horizon (30s, 300s), in bps in our favor; nil until that time has passed,
	// or for good if the quoter was down when it came due.
	Markouts []*float64 `json:"markouts"`
	// Recovered: filled while the quoter was down, found on the next start. There was no fair
	// value to measure it against, so it's left out of the edge and mark-out averages.
	Recovered bool `json:"recovered,omitempty"`
	// Unpriced: filled while the book had no reference price (just after a start, or with the
	// sources down). Like a recovered fill, it's counted but left out of the averages.
	Unpriced bool `json:"unpriced,omitempty"`
	// OrderID is the exchange's id for the order that filled; the fee is found by it. Empty for a
	// fill the quoter couldn't tie to an exchange order, which then never gets a fee.
	OrderID string `json:"orderId,omitempty"`
	// Fee is what the exchange charged, in the quote currency: notional × FeeBps. The drop copy
	// doesn't carry it, so it's nil until the account's fills are next read (every few seconds).
	Fee       *decimal.Decimal `json:"fee"`
	FeeBps    *float64         `json:"feeBps"`
	Liquidity string           `json:"liquidity,omitempty"` // MAKER, TAKER or SETTER
	// resumed is when this run restored the trade: a mark-out that came due before then was
	// missed, however recently.
	resumed time.Time
}

// Journal is the desk's trade log, shared by every book.
type Journal struct {
	mu      sync.Mutex
	trades  []*Trade
	nextID  int
	pending map[string][]*Trade // by symbol: trades with a mark-out still to come
}

func NewJournal() *Journal {
	return &Journal{pending: map[string][]*Trade{}}
}

// favor is how far price is from mid in our favor, in bps of price.
func favor(side Side, price, mid decimal.Decimal) float64 {
	if !price.IsPositive() || !mid.IsPositive() {
		return 0
	}
	d := mid.Sub(price)
	if side == Sell {
		d = price.Sub(mid)
	}
	return d.Div(price).Mul(tenK).InexactFloat64()
}

// Add records a fill.
func (j *Journal) Add(m Market, f Fill, refMid decimal.Decimal) {
	kind := "maker"
	if f.Level == TakeLevel {
		kind = string(f.TakeKind)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.nextID++
	t := &Trade{
		ID: j.nextID, Time: f.Time, Symbol: m.Symbol, Quote: m.QuoteSymbol, Side: f.Side, Kind: kind, Level: f.Level,
		Qty: f.Qty, Price: f.Price, Notional: f.Qty.Mul(f.Price), RefMid: refMid, EdgeBps: favor(f.Side, f.Price, refMid),
		Markouts: make([]*float64, len(MarkoutHorizons)), OrderID: f.OrderID,
	}
	if t.Time.IsZero() {
		t.Time = time.Now()
	}
	j.trades = append(j.trades, t)
	if len(j.trades) > journalSize {
		j.trades = j.trades[len(j.trades)-journalSize:]
	}
	j.pending[m.Symbol] = append(j.pending[m.Symbol], t)
}

// AddRecovered records a fill found after a restart: no fair value at the time, no mark-outs.
func (j *Journal) AddRecovered(m Market, f Fill) { j.addUnmeasured(m, f, true) }

// AddUnpriced records a fill that came in while the book had no reference price.
func (j *Journal) AddUnpriced(m Market, f Fill) { j.addUnmeasured(m, f, false) }

func (j *Journal) addUnmeasured(m Market, f Fill, recovered bool) {
	kind := "maker"
	if f.Level == TakeLevel {
		kind = string(f.TakeKind)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.nextID++
	j.trades = append(j.trades, &Trade{
		ID: j.nextID, Time: f.Time, Symbol: m.Symbol, Quote: m.QuoteSymbol, Side: f.Side, Kind: kind, Level: f.Level,
		Qty: f.Qty, Price: f.Price, Notional: f.Qty.Mul(f.Price), Markouts: make([]*float64, len(MarkoutHorizons)),
		Recovered: recovered, Unpriced: !recovered, OrderID: f.OrderID,
	})
	if t := j.trades[len(j.trades)-1]; t.Time.IsZero() {
		t.Time = time.Now()
	}
	if len(j.trades) > journalSize {
		j.trades = j.trades[len(j.trades)-journalSize:]
	}
}

// feeWait is how long a fill waits for its fee. Past this it's left without one, rather than
// paging ever further back through the account's fills for it.
const feeWait = time.Hour

// WaitingForFees says whether any fill from the last hour still has no fee.
func (j *Journal) WaitingForFees(now time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i := len(j.trades) - 1; i >= 0; i-- {
		t := j.trades[i]
		if now.Sub(t.Time) > feeWait {
			break
		}
		if t.Fee == nil && t.OrderID != "" {
			return true
		}
	}
	return false
}

// ApplyFees gives fills their fees from the account's fills (GET /orders/trade): each fill without
// one, on an order found there, is charged that order's fee rate on its own notional. It returns
// the fees it added, by book, each with when its fill happened. An order fills at one rate for every match, so a fill whose own
// match isn't in the list yet is still charged right.
func (j *Journal) ApplyFees(fills []tm.TradeFill) map[string][]FeeAt {
	type rate struct {
		bps decimal.Decimal
		liq string
	}
	byOrder := map[string]rate{}
	for _, f := range fills {
		if bps, err := decimal.NewFromString(f.FeeBps); err == nil && f.OrderID != "" {
			byOrder[string(f.OrderID)] = rate{bps, f.Liquidity}
		}
	}
	added := map[string][]FeeAt{}
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, t := range j.trades {
		r, ok := byOrder[t.OrderID]
		if t.Fee != nil || t.OrderID == "" || !ok {
			continue
		}
		fee := t.Notional.Mul(r.bps).Div(tenK)
		bps := r.bps.InexactFloat64()
		t.Fee, t.FeeBps, t.Liquidity = &fee, &bps, r.liq
		added[t.Symbol] = append(added[t.Symbol], FeeAt{Fee: fee, At: t.Time})
	}
	return added
}

// FeeAt is one fill's fee, and when the fill happened.
type FeeAt struct {
	Fee decimal.Decimal
	At  time.Time
}

// Snapshot copies the journal for the state file.
func (j *Journal) Snapshot() JournalState {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := JournalState{NextID: j.nextID, Trades: make([]Trade, len(j.trades))}
	for i, t := range j.trades {
		out.Trades[i] = *t
		out.Trades[i].Markouts = append([]*float64(nil), t.Markouts...)
	}
	return out
}

// Restore loads a saved journal. A mark-out still to come is marked as usual; one that came due
// while the quoter was down stays empty, since the price at that moment is gone.
func (j *Journal) Restore(s JournalState, now time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.trades, j.pending = nil, map[string][]*Trade{}
	j.nextID = s.NextID
	for i := range s.Trades {
		t := s.Trades[i]
		if len(t.Markouts) != len(MarkoutHorizons) {
			t.Markouts = make([]*float64, len(MarkoutHorizons))
		}
		t.resumed = now
		j.trades = append(j.trades, &t)
		if t.Recovered || t.Unpriced {
			continue
		}
		for k, h := range MarkoutHorizons {
			if t.Markouts[k] == nil && t.Time.Add(h).After(now) {
				j.pending[t.Symbol] = append(j.pending[t.Symbol], &t)
				break
			}
		}
		if t.ID > j.nextID {
			j.nextID = t.ID
		}
	}
}

// Mark fills in the mark-outs that are due for symbol's trades, at the reference mid now.
func (j *Journal) Mark(symbol string, mid decimal.Decimal, now time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()
	waiting := j.pending[symbol]
	if len(waiting) == 0 {
		return
	}
	keep := waiting[:0]
	for _, t := range waiting {
		done := true
		for i, h := range MarkoutHorizons {
			if t.Markouts[i] != nil {
				continue
			}
			switch age := now.Sub(t.Time); {
			case age < h:
				done = false
			case age < h+markGrace && !t.Time.Add(h).Before(t.resumed):
				v := favor(t.Side, t.Price, mid)
				t.Markouts[i] = &v
			default:
				// Too late: the price when it came due is gone. Left empty.
			}
		}
		if !done {
			keep = append(keep, t)
		}
	}
	j.pending[symbol] = keep
}

// minRetentionEdgeBps is the least edge at fill that retention is worked out against. Below it the
// ratio means nothing: -8 bps over +0.2 bps reads as -4000%.
const minRetentionEdgeBps = 1.0

// TradeSummary rolls trades up, for one book or all of them. Averages are weighted by notional,
// and each mark-out average only counts trades whose mark-out is in.
type TradeSummary struct {
	Symbol    string          `json:"symbol"` // "" for every book
	Trades    int             `json:"trades"`
	Notional  decimal.Decimal `json:"notional"`
	EdgeBps   *float64        `json:"edgeBps"`
	EdgePnl   *float64        `json:"edgePnl"` // edge at fill in quote currency, summed
	Markouts  []*float64      `json:"markouts"`
	Retention []*float64      `json:"retention"` // mark-out over edge at fill, per horizon
	Marked    []int           `json:"marked"`    // trades counted in each mark-out
	MarkedPnl []*float64      `json:"markedPnl"` // mark-out in quote currency, summed
	// Fees is what the exchange charged for the trades whose fee is known, in quote currency;
	// FeeBps is the notional-weighted rate over them. FeesPending counts trades still waiting.
	Fees        float64        `json:"fees"`
	FeeBps      *float64       `json:"feeBps"`
	FeesPending int            `json:"feesPending"`
	ByKind      map[string]int `json:"byKind"`
	Horizons    []int          `json:"horizonsSecs"`
}

// TradesReport is the journal for the management API: newest first, with summaries.
type TradesReport struct {
	Trades   []Trade        `json:"trades"`
	Total    TradeSummary   `json:"total"`
	ByBook   []TradeSummary `json:"byBook"`
	Horizons []int          `json:"horizonsSecs"`
}

// Report returns up to limit trades (newest first; 0 for all) and summaries of every trade.
func (j *Journal) Report(limit int) TradesReport {
	j.mu.Lock()
	defer j.mu.Unlock()
	horizons := make([]int, len(MarkoutHorizons))
	for i, h := range MarkoutHorizons {
		horizons[i] = int(h.Seconds())
	}
	r := TradesReport{Trades: []Trade{}, ByBook: []TradeSummary{}, Horizons: horizons}
	for i := len(j.trades) - 1; i >= 0 && (limit == 0 || len(r.Trades) < limit); i-- {
		t := *j.trades[i]
		t.Markouts = append([]*float64(nil), t.Markouts...)
		r.Trades = append(r.Trades, t)
	}
	books := map[string][]*Trade{}
	for _, t := range j.trades {
		books[t.Symbol] = append(books[t.Symbol], t)
	}
	r.Total = summarize("", j.trades, horizons)
	for sym, ts := range books {
		r.ByBook = append(r.ByBook, summarize(sym, ts, horizons))
	}
	sort.Slice(r.ByBook, func(a, b int) bool { return r.ByBook[a].Symbol < r.ByBook[b].Symbol })
	return r
}

func summarize(symbol string, trades []*Trade, horizons []int) TradeSummary {
	n := len(horizons)
	s := TradeSummary{Symbol: symbol, Trades: len(trades), ByKind: map[string]int{}, Horizons: horizons,
		Markouts: make([]*float64, n), Retention: make([]*float64, n), Marked: make([]int, n), MarkedPnl: make([]*float64, n)}
	var edgeW, w float64
	markW, markN, edgeAtMark, pnl := make([]float64, n), make([]float64, n), make([]float64, n), make([]float64, n)
	var feeW float64
	for _, t := range trades {
		s.ByKind[t.Kind]++
		s.Notional = s.Notional.Add(t.Notional)
		if t.Fee != nil {
			s.Fees += t.Fee.InexactFloat64()
			feeW += t.Notional.InexactFloat64()
		} else if t.OrderID != "" && time.Since(t.Time) <= feeWait {
			s.FeesPending++
		}
		if t.Recovered || t.Unpriced {
			continue // no fair value to measure it against
		}
		notional := t.Notional.InexactFloat64()
		edgeW += t.EdgeBps * notional
		w += notional
		for i, m := range t.Markouts {
			if m == nil {
				continue
			}
			s.Marked[i]++
			markW[i] += *m * notional
			markN[i] += notional
			edgeAtMark[i] += t.EdgeBps * notional
			pnl[i] += *m / 10_000 * notional
		}
	}
	if feeW > 0 {
		v := s.Fees / feeW * 10_000
		s.FeeBps = &v
	}
	if w > 0 {
		v, p := edgeW/w, edgeW/10_000
		s.EdgeBps, s.EdgePnl = &v, &p
	}
	for i := range horizons {
		if markN[i] == 0 {
			continue
		}
		m, e, p := markW[i]/markN[i], edgeAtMark[i]/markN[i], pnl[i]
		s.Markouts[i], s.MarkedPnl[i] = &m, &p
		if e >= minRetentionEdgeBps {
			r := m / e
			s.Retention[i] = &r
		}
	}
	return s
}
