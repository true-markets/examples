package reference

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shopspring/decimal"
)

const (
	feedURL = "wss://ws-feed.exchange.coinbase.com"
	restURL = "https://api.exchange.coinbase.com"
)

// Coinbase streams Coinbase Exchange's public ticker for a set of products (for example BTC-USD,
// ETH-USD) on one connection. It needs no account or key. Add subscribes to another product
// without reconnecting.
//
// The ticker only publishes when a product trades, so a quiet product can go seconds without a
// price while its feed is healthy. Every product also gets a heartbeat each second, which is passed
// on as a tick repeating the last price with Heartbeat set.
type Coinbase struct {
	OnTick  func(Tick)
	OnState func(up bool, reason string)
	Log     *slog.Logger

	mu       sync.Mutex
	products []string
	last     map[string]Tick
	conn     *websocket.Conn // set while connected; writes happen under mu
	wake     chan struct{}
}

// Add subscribes to a product: now if connected, and on every reconnect.
func (t *Coinbase) Add(product string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if slices.Contains(t.products, product) {
		return
	}
	t.products = append(t.products, product)
	if t.conn != nil {
		if err := t.conn.WriteJSON(subscribe(product)); err != nil {
			t.conn.Close() // the session reconnects and subscribes to everything
		}
	}
	if t.wake != nil {
		select {
		case t.wake <- struct{}{}:
		default:
		}
	}
}

func subscribe(products ...string) map[string]any {
	// The ticker channel publishes on every trade with the best bid and ask; the heartbeat
	// channel keeps a quiet product from looking like a dead line.
	return map[string]any{"type": "subscribe", "product_ids": products, "channels": []string{"ticker", "heartbeat"}}
}

func (t *Coinbase) Run(ctx context.Context) {
	t.mu.Lock()
	t.wake = make(chan struct{}, 1)
	t.mu.Unlock()
	backoff := time.Second
	for ctx.Err() == nil {
		// Nothing to subscribe to until the first book is added.
		t.mu.Lock()
		empty := len(t.products) == 0
		t.mu.Unlock()
		if empty {
			select {
			case <-ctx.Done():
				return
			case <-t.wake:
			}
			continue
		}
		started := time.Now()
		err := t.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if t.OnState != nil {
			t.OnState(false, err.Error())
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		t.Log.Warn("coinbase feed down, reconnecting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (t *Coinbase) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, feedURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	t.mu.Lock()
	err = conn.WriteJSON(subscribe(t.products...))
	t.conn = conn
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.conn = nil
		t.mu.Unlock()
	}()
	if err != nil {
		return err
	}
	up := false
	for {
		_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var m struct {
			Type      string `json:"type"`
			Message   string `json:"message"`
			Reason    string `json:"reason"`
			ProductID string `json:"product_id"`
			BestBid   string `json:"best_bid"`
			BestAsk   string `json:"best_ask"`
		}
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.Type {
		case "error":
			return &feedError{m.Message + " " + m.Reason}
		case "heartbeat":
			t.mu.Lock()
			last, ok := t.last[m.ProductID]
			t.mu.Unlock()
			if ok {
				last.Seen, last.Heartbeat = time.Now(), true
				t.OnTick(last)
			}
		case "ticker":
			bid, err1 := decimal.NewFromString(m.BestBid)
			ask, err2 := decimal.NewFromString(m.BestAsk)
			if err1 != nil || err2 != nil || !bid.IsPositive() || !ask.IsPositive() {
				continue
			}
			if !up {
				up = true
				t.Log.Info("coinbase feed streaming")
				if t.OnState != nil {
					t.OnState(true, "")
				}
			}
			now := time.Now()
			tick := Tick{Reference: m.ProductID, Mid: bid.Add(ask).Div(decimal.NewFromInt(2)), Bid: bid, Ask: ask, Time: now, Seen: now}
			t.mu.Lock()
			if t.last == nil {
				t.last = map[string]Tick{}
			}
			t.last[m.ProductID] = tick
			t.mu.Unlock()
			t.OnTick(tick)
		}
	}
}

type feedError struct{ msg string }

func (e *feedError) Error() string { return "coinbase: " + e.msg }

// CoinbaseProductExists checks a product with Coinbase's public REST API before subscribing to
// it. One unknown product in a subscribe request fails the whole request, which would take every
// book's reference down with it.
func CoinbaseProductExists(ctx context.Context, product string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, restURL+"/products/"+url.PathEscape(product), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "cefi-quoter")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("checking with Coinbase: %w", err)
	}
	defer res.Body.Close()
	var body struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	switch {
	case res.StatusCode == http.StatusNotFound:
		return fmt.Errorf("coinbase has no product %s", product)
	case res.StatusCode != http.StatusOK:
		return fmt.Errorf("checking with Coinbase: HTTP %d", res.StatusCode)
	case body.Status != "" && body.Status != "online":
		return fmt.Errorf("coinbase product %s is %s", product, body.Status)
	}
	return nil
}
