package quoter

import (
	"sort"
	"sync"
	"time"

	"github.com/shopspring/decimal"
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
// Kept in memory, for this run only.

// MarkoutHorizons are when each fill is marked again.
var MarkoutHorizons = []time.Duration{30 * time.Second, 300 * time.Second}

const journalSize = 5000

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
	// Mark-outs at each horizon (30s, 300s), in bps in our favor; nil until that time has passed.
	Markouts []*float64 `json:"markouts"`
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
		Markouts: make([]*float64, len(MarkoutHorizons)),
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
			if now.Sub(t.Time) >= h {
				v := favor(t.Side, t.Price, mid)
				t.Markouts[i] = &v
			} else {
				done = false
			}
		}
		if !done {
			keep = append(keep, t)
		}
	}
	j.pending[symbol] = keep
}

// TradeSummary rolls trades up, for one book or all of them. Averages are weighted by notional,
// and each mark-out average only counts trades whose mark-out is in.
type TradeSummary struct {
	Symbol    string          `json:"symbol"` // "" for every book
	Trades    int             `json:"trades"`
	Notional  decimal.Decimal `json:"notional"`
	EdgeBps   *float64        `json:"edgeBps"`
	Markouts  []*float64      `json:"markouts"`
	Retention []*float64      `json:"retention"` // mark-out over edge at fill, per horizon
	Marked    []int           `json:"marked"`    // trades counted in each mark-out
	MarkedPnl []*float64      `json:"markedPnl"` // mark-out in quote currency, summed
	ByKind    map[string]int  `json:"byKind"`
	Horizons  []int           `json:"horizonsSecs"`
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
	for _, t := range trades {
		s.ByKind[t.Kind]++
		s.Notional = s.Notional.Add(t.Notional)
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
	if w > 0 {
		v := edgeW / w
		s.EdgeBps = &v
	}
	for i := range horizons {
		if markN[i] == 0 {
			continue
		}
		m, e, p := markW[i]/markN[i], edgeAtMark[i]/markN[i], pnl[i]
		s.Markouts[i], s.MarkedPnl[i] = &m, &p
		if e > 0 {
			r := m / e
			s.Retention[i] = &r
		}
	}
	return s
}
