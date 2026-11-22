// Package reference streams the prices the quoter centers each book's ladder on. A market maker
// needs a view of fair value from somewhere deeper than the book it is quoting into:
//
//   - Crypto books use Coinbase Exchange's public ticker: BTC-USDC prices off BTC-USD.
//   - Tokenized stocks use Hyperliquid's US-equity perps: GOOGLC-USDC (Alphabet, a Coinbase
//     tokenized stock) prices off xyz:GOOGL. Free real-time quotes on the stock itself need an
//     account or come 15 minutes late; these are keyless, pushed every block, open 24/7, and deep.
//     The cost is that a perp's mid carries its funding premium, usually a few bps.
//
// A reference is named by a string: a Coinbase product ("BTC-USD"), or "hyperliquid:" and a
// Hyperliquid coin ("hyperliquid:xyz:GOOGL").
package reference

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

// Tick is one update for one reference. Time is when the price last changed; Seen is when the
// source last said anything about it (a heartbeat counts), so a quiet market isn't mistaken for a
// dead feed.
type Tick struct {
	Reference string // the name the book uses, e.g. BTC-USD or hyperliquid:xyz:GOOGL
	Mid       decimal.Decimal
	Bid       decimal.Decimal
	Ask       decimal.Decimal
	BidSize   decimal.Decimal // at the best bid and ask, in the base asset, where the source says
	AskSize   decimal.Decimal
	Time      time.Time
	Seen      time.Time
	Heartbeat bool // repeats the last price; nothing traded
}

const hyperliquidPrefix = "hyperliquid:"

// Hyperliquid names a Hyperliquid coin as a reference.
func Hyperliquid(coin string) string { return hyperliquidPrefix + coin }

// Normalize tidies a reference as typed: Coinbase products are upper case, Hyperliquid coins keep
// their case after the dex prefix ("xyz:GOOGL").
func Normalize(ref string) string {
	ref = strings.TrimSpace(ref)
	if coin, ok := cutPrefixFold(ref, hyperliquidPrefix); ok {
		return hyperliquidPrefix + coin
	}
	if coin, ok := cutPrefixFold(ref, "hl:"); ok {
		return hyperliquidPrefix + coin
	}
	return strings.ToUpper(ref)
}

func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix) {
		return s[len(prefix):], true
	}
	return "", false
}

// Feeds is every reference source, behind one Add.
type Feeds struct {
	Coinbase    *Coinbase
	Hyperliquid *HyperliquidFeed
}

// Add subscribes to a reference on whichever source it names.
func (f *Feeds) Add(ref string) {
	if coin, ok := strings.CutPrefix(ref, hyperliquidPrefix); ok {
		f.Hyperliquid.Add(coin)
		return
	}
	f.Coinbase.Add(ref)
}

// Run runs every source until ctx ends.
func (f *Feeds) Run(ctx context.Context) {
	go f.Hyperliquid.Run(ctx)
	f.Coinbase.Run(ctx)
}

// Check fails if the reference doesn't exist or has no live market. Subscribing to a name a source
// doesn't know can fail the whole connection, so books are checked before they're added.
func Check(ctx context.Context, ref string) error {
	if coin, ok := strings.CutPrefix(ref, hyperliquidPrefix); ok {
		return HyperliquidCoinLive(ctx, coin)
	}
	if strings.Count(ref, "-") != 1 {
		return fmt.Errorf("%q isn't a Coinbase product (BTC-USD) or a Hyperliquid coin (hyperliquid:xyz:GOOGL)", ref)
	}
	return CoinbaseProductExists(ctx, ref)
}

// Describe names a reference for people: "Coinbase BTC-USD", "Hyperliquid xyz:GOOGL".
func Describe(ref string) string {
	if coin, ok := strings.CutPrefix(ref, hyperliquidPrefix); ok {
		return "Hyperliquid " + coin
	}
	return "Coinbase " + ref
}
