// Package paper is a pretend exchange for trying the quoter without an API key or real funds.
// It prices every book off the live Coinbase reference: an order fills when Coinbase's market
// trades through it (a bid fills once Coinbase's ask is at or below it, an ask once Coinbase's bid
// is at or above it). Balances and holds are simulated the way the exchange does them, shared by
// every book, including rejecting an order or a modify that needs more than is free.
//
// It answers every request with the same drop-copy messages the real exchange sends, so the
// quoter runs exactly the code it runs live.
package paper

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

type order struct {
	externalID string
	id         string
	symbol     string
	base       string // asset ids, which in paper mode are the asset symbols
	quote      string
	side       string
	price      decimal.Decimal
	qty        decimal.Decimal
	executed   decimal.Decimal
}

func (o *order) leaves() decimal.Decimal { return o.qty.Sub(o.executed) }

// hold is what the order ties up, and in which asset.
func (o *order) hold() (string, decimal.Decimal) {
	if o.side == "BUY" {
		return o.quote, o.leaves().Mul(o.price)
	}
	return o.base, o.leaves()
}

// Exchange is the paper exchange. It is a quoter.Venue, and Transport makes a quoter.Transport for
// each book.
type Exchange struct {
	// QuoteAsset is what every paper book is priced in (USDC).
	QuoteAsset string
	// OnDropCopy receives every drop copy, as the WebSocket would deliver it.
	OnDropCopy func(tm.Message)
	// Latency between a request and its drop copy.
	Latency time.Duration

	mu       sync.Mutex
	balances map[string]decimal.Decimal
	orders   map[string]*order
	nextID   int
}

// New makes a paper exchange with these starting balances, by asset symbol. Every other asset is
// listed against quoteAsset: {USDC, BTC, ETH} lists BTC-USDC and ETH-USDC.
func New(quoteAsset string, balances map[string]decimal.Decimal) *Exchange {
	b := map[string]decimal.Decimal{}
	for k, v := range balances {
		b[k] = v
	}
	return &Exchange{QuoteAsset: quoteAsset, balances: b, orders: map[string]*order{}, Latency: 20 * time.Millisecond}
}

// InstrumentID is the made-up instrument id for a paper book.
func InstrumentID(symbol string) string { return "paper:" + symbol }

// Listings is every book the paper exchange offers.
func (x *Exchange) Listings() []quoter.Listing {
	x.mu.Lock()
	defer x.mu.Unlock()
	var out []quoter.Listing
	for asset := range x.balances {
		if asset == x.QuoteAsset {
			continue
		}
		sym := asset + "-" + x.QuoteAsset
		out = append(out, quoter.Listing{
			Symbol: sym, InstrumentID: InstrumentID(sym), BaseAssetID: asset, QuoteAssetID: x.QuoteAsset,
			BaseSymbol: asset, QuoteSymbol: x.QuoteAsset, Reference: asset + "-USD",
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	return out
}

// Transport is the order entry for one book.
func (x *Exchange) Transport(m quoter.Market) quoter.Transport { return &book{x: x, m: m} }

var errInsufficient = &tm.APIError{Status: 422, Message: "paper exchange: Insufficient balance"}

func (x *Exchange) freeLocked(asset string) decimal.Decimal {
	free := x.balances[asset]
	for _, o := range x.orders {
		if a, h := o.hold(); a == asset {
			free = free.Sub(h)
		}
	}
	return free
}

type book struct {
	x *Exchange
	m quoter.Market
}

func (b *book) Name() string { return "paper" }
func (b *book) Ready() bool  { return true }

func (b *book) Create(_ context.Context, o *quoter.Order) (string, error) {
	x := b.x
	x.mu.Lock()
	defer x.mu.Unlock()
	n := &order{externalID: o.ExternalID, symbol: b.m.Symbol, base: b.m.BaseAssetID, quote: b.m.QuoteAssetID, side: string(o.Side), price: o.Price, qty: o.Qty}
	if asset, h := n.hold(); h.GreaterThan(x.freeLocked(asset)) {
		return "", errInsufficient
	}
	x.nextID++
	n.id = strconv.Itoa(x.nextID)
	x.orders[n.externalID] = n
	x.emitLocked(n, "NEW", "ACTIVE", "", nil)
	return n.id, nil
}

// Modify re-sizes the order's hold in place: only the difference has to be free. That is the
// property that lets a fully deployed ladder move without being rejected.
func (b *book) Modify(_ context.Context, externalID, _, _ string, price, qty decimal.Decimal) error {
	x := b.x
	x.mu.Lock()
	defer x.mu.Unlock()
	o := x.orders[externalID]
	if o == nil {
		return &tm.APIError{Status: 404, Message: "paper exchange: order not found"}
	}
	next := *o
	next.price, next.qty = price, qty
	if !next.leaves().IsPositive() {
		return &tm.APIError{Status: 400, Message: "paper exchange: new quantity is not above the filled quantity"}
	}
	asset, newHold := next.hold()
	_, oldHold := o.hold()
	if newHold.Sub(oldHold).GreaterThan(x.freeLocked(asset)) {
		x.emitLocked(o, "REJECTED", "ACTIVE", "Insufficient balance", nil)
		return nil
	}
	o.price, o.qty = price, qty
	x.emitLocked(o, "MODIFIED", "ACTIVE", "", nil)
	return nil
}

func (b *book) Cancel(_ context.Context, externalID, _, _ string) error {
	x := b.x
	x.mu.Lock()
	defer x.mu.Unlock()
	o := x.orders[externalID]
	if o == nil {
		return &tm.APIError{Status: 404, Message: "paper exchange: order not found"}
	}
	delete(x.orders, externalID)
	x.emitLocked(o, "CANCELED", "CANCELED", "", nil)
	return nil
}

// OnTick fills every order on symbol that the Coinbase market has traded through.
func (x *Exchange) OnTick(symbol string, t reference.Tick) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for id, o := range x.orders {
		if o.symbol != symbol {
			continue
		}
		crossed := (o.side == "BUY" && t.Ask.LessThanOrEqual(o.price)) || (o.side == "SELL" && t.Bid.GreaterThanOrEqual(o.price))
		if !crossed {
			continue
		}
		qty := o.leaves()
		notional := qty.Mul(o.price)
		if o.side == "BUY" {
			x.balances[o.base], x.balances[o.quote] = x.balances[o.base].Add(qty), x.balances[o.quote].Sub(notional)
		} else {
			x.balances[o.base], x.balances[o.quote] = x.balances[o.base].Sub(qty), x.balances[o.quote].Add(notional)
		}
		o.executed = o.qty
		delete(x.orders, id)
		x.emitLocked(o, "TRADE", "FILLED", "", &qty)
	}
}

func (x *Exchange) emitLocked(o *order, event, status, text string, tradeQty *decimal.Decimal) {
	dc := tm.DropCopy{
		OrderID: tm.Str(o.id), ExternalID: o.externalID, InstrumentID: tm.Str(InstrumentID(o.symbol)), Symbol: o.symbol, Side: o.side,
		Status: status, Price: o.price.String(), Quantity: o.qty.String(), LeavesQty: o.leaves().String(),
		ExecutedQty: o.executed.String(), EventType: event, Text: text,
		Timestamp: strconv.FormatInt(time.Now().UnixNano(), 10),
	}
	if event == "CANCELED" {
		dc.LeavesQty = "0"
	}
	if tradeQty != nil {
		dc.TradeQty, dc.TradePrice = tradeQty.String(), o.price.String()
	}
	raw, _ := json.Marshal(dc)
	msg := tm.Message{Channel: "DROPCOPY", Update: "UPDATE", Data: raw}
	if x.OnDropCopy == nil {
		return
	}
	// Delivered later, on another goroutine, the way the WebSocket would.
	go func() {
		time.Sleep(x.Latency)
		x.OnDropCopy(msg)
	}()
}

func (x *Exchange) Balances(context.Context) (*tm.Balances, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	held := map[string]decimal.Decimal{}
	for _, o := range x.orders {
		a, h := o.hold()
		held[a] = held[a].Add(h)
	}
	b := &tm.Balances{}
	for asset, total := range x.balances {
		b.Balances = append(b.Balances, struct {
			AssetID      tm.Str `json:"asset_id"`
			Balance      string `json:"balance"`
			Unsettled    string `json:"unsettled"`
			OrderHold    string `json:"order_hold"`
			TransferHold string `json:"transfer_hold"`
		}{AssetID: tm.Str(asset), Balance: total.String(), OrderHold: held[asset].String()})
	}
	return b, nil
}

func (x *Exchange) ActiveOrders(context.Context) ([]tm.RestOrder, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	var out []tm.RestOrder
	for _, o := range x.orders {
		var r tm.RestOrder
		r.ID, r.ExternalID, r.Status = tm.Str(o.id), o.externalID, "ACTIVE"
		r.OrderInfo.InstrumentID, r.OrderInfo.Side = tm.Str(InstrumentID(o.symbol)), o.side
		r.OrderInfo.Price, r.OrderInfo.Qty = o.price.String(), o.qty.String()
		r.LeavesQty, r.ExecutedQty = o.leaves().String(), o.executed.String()
		out = append(out, r)
	}
	return out, nil
}

// ParseBalances reads "USDC=10000,BTC=0.05" into balances by asset.
func ParseBalances(s string) (map[string]decimal.Decimal, error) {
	out := map[string]decimal.Decimal{}
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		d, err := decimal.NewFromString(strings.TrimSpace(v))
		if !ok || err != nil || d.IsNegative() {
			return nil, fmt.Errorf("%q: want ASSET=amount", part)
		}
		out[strings.ToUpper(strings.TrimSpace(k))] = d
	}
	return out, nil
}

var _ quoter.Venue = (*Exchange)(nil)
