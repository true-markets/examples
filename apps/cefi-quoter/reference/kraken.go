package reference

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shopspring/decimal"
)

const krakenWS = "wss://ws.kraken.com/v2"

// KrakenFeed streams Kraken's best bid and offer for a set of pairs on one public connection (no
// account or key), named as Kraken's WebSocket names them: BTC/USD, or GOOGLx/USD for a tokenized
// stock (xStocks, issued by Backed). Add subscribes to another pair without reconnecting.
//
// The ticker channel, triggered on every change at the touch, carries the best bid and ask with
// their sizes. Kraken sends a heartbeat each second while subscribed; it re-sends every pair's
// last price as a heartbeat tick, so a quiet pair isn't mistaken for a dead line.
type KrakenFeed struct {
	OnTick  func(Tick)
	OnState func(up bool, reason string)
	Log     *slog.Logger

	mu    sync.Mutex
	pairs []string
	last  map[string]Tick
	conn  *websocket.Conn // set while connected; writes happen under mu
	wake  chan struct{}
}

// Add subscribes to a pair: now if connected, and on every reconnect.
func (k *KrakenFeed) Add(pair string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if slices.Contains(k.pairs, pair) {
		return
	}
	k.pairs = append(k.pairs, pair)
	if k.conn != nil {
		if err := k.conn.WriteJSON(krakenSubscribe(pair)); err != nil {
			k.conn.Close() // the session reconnects and subscribes to everything
		}
	}
	if k.wake != nil {
		select {
		case k.wake <- struct{}{}:
		default:
		}
	}
}

func krakenSubscribe(pairs ...string) map[string]any {
	return map[string]any{"method": "subscribe", "params": map[string]any{"channel": "ticker", "symbol": pairs, "event_trigger": "bbo"}}
}

func (k *KrakenFeed) Run(ctx context.Context) {
	k.mu.Lock()
	k.wake = make(chan struct{}, 1)
	k.mu.Unlock()
	backoff := time.Second
	for ctx.Err() == nil {
		k.mu.Lock()
		empty := len(k.pairs) == 0
		k.mu.Unlock()
		if empty {
			select {
			case <-ctx.Done():
				return
			case <-k.wake:
			}
			continue
		}
		started := time.Now()
		err := k.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if k.OnState != nil {
			k.OnState(false, err.Error())
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		k.Log.Warn("kraken feed down, reconnecting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (k *KrakenFeed) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, krakenWS, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	k.mu.Lock()
	err = conn.WriteJSON(krakenSubscribe(k.pairs...))
	k.conn = conn
	if k.last == nil {
		k.last = map[string]Tick{}
	}
	k.mu.Unlock()
	defer func() {
		k.mu.Lock()
		k.conn = nil
		k.mu.Unlock()
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
			Channel string `json:"channel"`
			Method  string `json:"method"`
			Success *bool  `json:"success"`
			Error   string `json:"error"`
			Data    []struct {
				Symbol string          `json:"symbol"`
				Bid    decimal.Decimal `json:"bid"`
				BidQty decimal.Decimal `json:"bid_qty"`
				Ask    decimal.Decimal `json:"ask"`
				AskQty decimal.Decimal `json:"ask_qty"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch {
		case m.Method == "subscribe" && m.Success != nil && !*m.Success:
			// One unknown pair fails only its own subscription; the others stream on.
			k.Log.Warn("kraken refused a subscription", "err", m.Error)
		case m.Channel == "heartbeat":
			now := time.Now()
			k.mu.Lock()
			ticks := make([]Tick, 0, len(k.last))
			for p, t := range k.last {
				t.Seen, t.Heartbeat = now, true
				k.last[p] = t
				ticks = append(ticks, t)
			}
			k.mu.Unlock()
			for _, t := range ticks {
				k.OnTick(t)
			}
		case m.Channel == "ticker":
			for _, d := range m.Data {
				if !d.Bid.IsPositive() || !d.Ask.IsPositive() {
					continue
				}
				if !up {
					up = true
					k.Log.Info("kraken feed streaming")
					if k.OnState != nil {
						k.OnState(true, "")
					}
				}
				now := time.Now()
				t := Tick{Reference: Kraken(d.Symbol), Mid: d.Bid.Add(d.Ask).Div(decimal.NewFromInt(2)), Bid: d.Bid, Ask: d.Ask,
					BidSize: d.BidQty, AskSize: d.AskQty, Time: now, Seen: now}
				k.mu.Lock()
				// A size-only change is news for depth weighting, but the price didn't move.
				if prev, had := k.last[d.Symbol]; had && prev.Bid.Equal(t.Bid) && prev.Ask.Equal(t.Ask) {
					t.Time = prev.Time
				}
				k.last[d.Symbol] = t
				k.mu.Unlock()
				k.OnTick(t)
			}
		}
	}
}

// KrakenPairLive checks that Kraken lists a pair (BTC/USD, GOOGLx/USD) and it's trading.
func KrakenPairLive(ctx context.Context, pair string) error {
	pairs, err := krakenPairs(ctx)
	if err != nil {
		return err
	}
	status, ok := pairs[pair]
	switch {
	case !ok:
		return fmt.Errorf("kraken lists no %s (name it as Kraken's WebSocket does: BTC/USD, GOOGLx/USD)", pair)
	case status != "online" && status != "post_only":
		// post_only still shows a book (indicative: nothing matches), so it can be watched.
		return fmt.Errorf("kraken %s is %s", pair, status)
	}
	return nil
}
