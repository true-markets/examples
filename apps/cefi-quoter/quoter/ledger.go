package quoter

import (
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Ledger is the one view of the account's balances that every book in the process shares.
//
// The exchange decides "insufficient balance" with simple arithmetic: an order's hold has to fit
// in the balance less everything already held. Every hold the quoter places is one it knows about
// the moment it sends the request, so the ledger doesn't wait for the next balance read to learn
// about them. It reads the exchange only for what it can't see itself:
//
//		free = spendable - foreign holds - our holds now
//
//	  - spendable: the last GET /balances, less transfer holds and anything leaving at settlement,
//	    less what fills have spent since. Never credited for what a fill bought: that can land
//	    unsettled, and the next read says when it's usable.
//	  - foreign holds: whatever of the exchange's order_hold at that read wasn't ours (orders placed
//	    from the console, or by another program on the same account). Counted until a read shows
//	    it gone.
//	  - our holds: summed live from every book's orders, so a cancel's funds are free for any book
//	    the moment the drop copy confirms it, and a new order's funds are taken from every book the
//	    moment it's registered.
//
// Two books quoting against the same USDC is where separate quoters go wrong: each reads the
// whole balance and spends it, and the exchange rejects whichever order arrives second. Here,
// Reserve hands out funds under one lock, and the order is registered before the lock is let go,
// so the next book to ask already sees it.
type Ledger struct {
	mu       sync.Mutex
	assets   map[string]*ledgerAsset
	books    []ledgerBook
	feeAsset string // the asset fee holds are charged in (USDC), if any book quotes in it
	readAt   time.Time
	dirty    bool
}

type ledgerAsset struct {
	spendable decimal.Decimal
	foreign   decimal.Decimal
	fetched   bool
}

type ledgerBook struct {
	book        *Book
	base, quote string // asset ids
}

// AssetBalance is one asset as the ledger sees it, for the management screen.
type AssetBalance struct {
	AssetID     string          `json:"assetId"`
	Symbol      string          `json:"symbol"`
	Spendable   decimal.Decimal `json:"spendable"`
	ForeignHold decimal.Decimal `json:"foreignHold"`
	OurHold     decimal.Decimal `json:"ourHold"`
	Free        decimal.Decimal `json:"free"`
}

func NewLedger() *Ledger {
	return &Ledger{assets: map[string]*ledgerAsset{}}
}

// SetFeeAsset names the asset the exchange holds fees in (USDC).
func (l *Ledger) SetFeeAsset(assetID string) {
	l.mu.Lock()
	l.feeAsset = assetID
	l.mu.Unlock()
}

// Register adds a book whose orders hold funds in base and quote.
func (l *Ledger) Register(b *Book, base, quote string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.books = append(l.books, ledgerBook{book: b, base: base, quote: quote})
	l.dirty = true // re-read soon, so a new asset has a balance
}

// Unregister removes a book. Only call it once the book has no orders.
func (l *Ledger) Unregister(b *Book) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, lb := range l.books {
		if lb.book == b {
			l.books = append(l.books[:i], l.books[i+1:]...)
			return
		}
	}
}

// OnBalances takes a GET /balances read.
func (l *Ledger) OnBalances(b *tm.Balances) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, a := range b.Balances {
		id := string(a.AssetID)
		spendable := dec(a.Balance).Sub(dec(a.TransferHold))
		// Negative unsettled is an amount leaving at settlement: it can't be spent now.
		spendable = spendable.Add(decimal.Min(dec(a.Unsettled), decimal.Zero))
		if id == l.feeAsset {
			// Fees settle in USDC, and the exchange holds against them at the account level.
			spendable = spendable.Sub(dec(b.FeesHold)).Sub(decimal.Max(dec(b.UnsettledFees), decimal.Zero))
		}
		la := l.assets[id]
		if la == nil {
			la = &ledgerAsset{}
			l.assets[id] = la
		}
		la.spendable = spendable
		la.foreign = decimal.Max(dec(a.OrderHold).Sub(l.oursLocked(id)), decimal.Zero)
		la.fetched = true
	}
	l.readAt = time.Now()
	l.dirty = false
}

// Debit takes what a fill spent off the spendable balance. The filled order's hold shrinks at the
// same moment, so a resting order filling moves no free balance.
func (l *Ledger) Debit(assetID string, amount decimal.Decimal) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if la := l.assets[assetID]; la != nil {
		la.spendable = decimal.Max(la.spendable.Sub(amount), decimal.Zero)
	}
}

// MarkDirty asks for a balance read as soon as possible (after a balance rejection).
func (l *Ledger) MarkDirty() {
	l.mu.Lock()
	l.dirty = true
	l.mu.Unlock()
}

// Due reports whether balances should be read now. A read is better taken while no request is in
// flight, so the exchange's holds and ours agree on which orders exist.
func (l *Ledger) Due(every, maxStale time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	age := time.Since(l.readAt)
	if l.readAt.IsZero() || l.dirty || age > maxStale {
		return true
	}
	if age < every {
		return false
	}
	for _, lb := range l.books {
		if len(lb.book.Stuck(0)) > 0 {
			return false
		}
	}
	return true
}

// Retry pushes the next read back a few seconds after a failed one.
func (l *Ledger) Retry() {
	l.mu.Lock()
	if l.readAt.IsZero() {
		l.readAt = time.Now().Add(-balanceMaxStale + 5*time.Second)
	} else {
		l.readAt = l.readAt.Add(5 * time.Second)
	}
	l.dirty = false
	l.mu.Unlock()
}

func (l *Ledger) ReadAt() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.readAt
}

// Fetched reports whether every given asset has had a balance read.
func (l *Ledger) Fetched(assetIDs ...string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, id := range assetIDs {
		if la := l.assets[id]; la == nil || !la.fetched {
			return false
		}
	}
	return true
}

// Free is what a new hold on the asset could take, across every book. Never negative.
func (l *Ledger) Free(assetID string) decimal.Decimal {
	l.mu.Lock()
	defer l.mu.Unlock()
	return decimal.Max(l.freeLocked(assetID), decimal.Zero)
}

// Budget is the most this book's orders on the asset may hold in total: what they hold now plus
// what's free, capped by the book's allocation (0 means no cap).
func (l *Ledger) Budget(b *Book, assetID string, alloc decimal.Decimal) decimal.Decimal {
	l.mu.Lock()
	defer l.mu.Unlock()
	budget := l.bookHeldLocked(b, assetID).Add(decimal.Max(l.freeLocked(assetID), decimal.Zero))
	if alloc.IsPositive() {
		budget = decimal.Min(budget, alloc)
	}
	return budget
}

// Reserve calls begin with how much more this book may hold on the asset right now (free, and
// within its allocation), while holding the ledger's lock. begin decides how much of that to use
// and registers the order in its Book before returning, so no other book can be handed the same
// funds in between. begin must not call back into the ledger.
func (l *Ledger) Reserve(b *Book, assetID string, alloc decimal.Decimal, begin func(room decimal.Decimal)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	room := decimal.Max(l.freeLocked(assetID), decimal.Zero)
	if alloc.IsPositive() {
		room = decimal.Min(room, decimal.Max(alloc.Sub(l.bookHeldLocked(b, assetID)), decimal.Zero))
	}
	begin(room)
}

// Snapshot lists every asset the ledger knows, for display. names maps asset ids to symbols.
func (l *Ledger) Snapshot(names map[string]string) []AssetBalance {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []AssetBalance{}
	for id, la := range l.assets {
		ours := l.oursLocked(id)
		if names[id] == "" && ours.IsZero() {
			continue // an asset no book trades
		}
		out = append(out, AssetBalance{
			AssetID: id, Symbol: names[id], Spendable: la.spendable, ForeignHold: la.foreign, OurHold: ours,
			Free: decimal.Max(la.spendable.Sub(la.foreign).Sub(ours), decimal.Zero),
		})
	}
	return out
}

func (l *Ledger) freeLocked(assetID string) decimal.Decimal {
	la := l.assets[assetID]
	if la == nil {
		return decimal.Zero
	}
	return la.spendable.Sub(la.foreign).Sub(l.oursLocked(assetID))
}

func (l *Ledger) oursLocked(assetID string) decimal.Decimal {
	total := decimal.Zero
	for _, lb := range l.books {
		buy, sell := lb.book.Holds()
		if lb.quote == assetID {
			total = total.Add(buy)
		}
		if lb.base == assetID {
			total = total.Add(sell)
		}
	}
	return total
}

func (l *Ledger) bookHeldLocked(b *Book, assetID string) decimal.Decimal {
	for _, lb := range l.books {
		if lb.book != b {
			continue
		}
		buy, sell := b.Holds()
		switch assetID {
		case lb.quote:
			return buy
		case lb.base:
			return sell
		}
	}
	return decimal.Zero
}
