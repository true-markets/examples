package reference

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shopspring/decimal"
)

const (
	hyperliquidWS   = "wss://api.hyperliquid.xyz/ws"
	hyperliquidInfo = "https://api.hyperliquid.xyz/info"
	// StockDex is the Hyperliquid HIP-3 dex that lists perps on US equities, as xyz:<TICKER>.
	StockDex = "xyz"
)

// HyperliquidFeed streams Hyperliquid's best bid and offer for a set of coins on one public
// connection (no account or key). Add subscribes to another coin without reconnecting.
//
// The bbo channel only pushes when the touch changes. activeAssetCtx arrives about once a second
// per coin: it counts as a heartbeat, and when its mid still sits inside the last touch it re-dates
// that touch, so a quiet but healthy book doesn't age out.
type HyperliquidFeed struct {
	OnTick  func(Tick)
	OnState func(up bool, reason string)
	Log     *slog.Logger

	mu    sync.Mutex
	coins []string
	last  map[string]Tick
	conn  *websocket.Conn // set while connected; writes happen under mu
	wake  chan struct{}
}

// Add subscribes to a coin: now if connected, and on every reconnect.
func (h *HyperliquidFeed) Add(coin string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if slices.Contains(h.coins, coin) {
		return
	}
	h.coins = append(h.coins, coin)
	if h.conn != nil {
		if err := h.subscribeLocked(coin); err != nil {
			h.conn.Close() // the session reconnects and subscribes to everything
		}
	}
	if h.wake != nil {
		select {
		case h.wake <- struct{}{}:
		default:
		}
	}
}

func (h *HyperliquidFeed) subscribeLocked(coin string) error {
	for _, typ := range []string{"bbo", "activeAssetCtx"} {
		if err := h.conn.WriteJSON(map[string]any{
			"method":       "subscribe",
			"subscription": map[string]string{"type": typ, "coin": coin},
		}); err != nil {
			return err
		}
	}
	return nil
}

func (h *HyperliquidFeed) Run(ctx context.Context) {
	h.mu.Lock()
	h.wake = make(chan struct{}, 1)
	h.mu.Unlock()
	backoff := time.Second
	for ctx.Err() == nil {
		// Nothing to subscribe to until a book needs a Hyperliquid reference.
		h.mu.Lock()
		empty := len(h.coins) == 0
		h.mu.Unlock()
		if empty {
			select {
			case <-ctx.Done():
				return
			case <-h.wake:
			}
			continue
		}
		started := time.Now()
		err := h.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if h.OnState != nil {
			h.OnState(false, err.Error())
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		h.Log.Warn("hyperliquid feed down, reconnecting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (h *HyperliquidFeed) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, hyperliquidWS, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	h.mu.Lock()
	h.conn = conn
	if h.last == nil {
		h.last = map[string]Tick{}
	}
	for _, c := range h.coins {
		if err = h.subscribeLocked(c); err != nil {
			break
		}
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.conn = nil
		h.mu.Unlock()
	}()
	if err != nil {
		return err
	}

	// Hyperliquid closes a connection that has sent nothing for a minute.
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.mu.Lock()
				err := conn.WriteJSON(map[string]string{"method": "ping"})
				h.mu.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			}
		}
	}()

	up := false
	markUp := func() {
		if !up {
			up = true
			h.Log.Info("hyperliquid feed streaming")
			if h.OnState != nil {
				h.OnState(true, "")
			}
		}
	}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var m struct {
			Channel string          `json:"channel"`
			Data    json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.Channel {
		case "error":
			return fmt.Errorf("hyperliquid: %s", strings.Trim(string(m.Data), `"`))
		case "bbo":
			var d struct {
				Coin string `json:"coin"`
				Time int64  `json:"time"` // block time, ms
				BBO  []*struct {
					Px string `json:"px"`
					Sz string `json:"sz"`
				} `json:"bbo"`
			}
			if json.Unmarshal(m.Data, &d) != nil || len(d.BBO) != 2 || d.BBO[0] == nil || d.BBO[1] == nil {
				continue // one side empty: no mid to quote around
			}
			bid, err1 := decimal.NewFromString(d.BBO[0].Px)
			ask, err2 := decimal.NewFromString(d.BBO[1].Px)
			if err1 != nil || err2 != nil || !bid.IsPositive() || !ask.IsPositive() {
				continue
			}
			markUp()
			now := time.Now()
			tick := Tick{Reference: Hyperliquid(d.Coin), Mid: bid.Add(ask).Div(decimal.NewFromInt(2)), Bid: bid, Ask: ask, Time: now, Seen: now}
			tick.BidSize, _ = decimal.NewFromString(d.BBO[0].Sz)
			tick.AskSize, _ = decimal.NewFromString(d.BBO[1].Sz)
			h.mu.Lock()
			h.last[d.Coin] = tick
			h.mu.Unlock()
			h.OnTick(tick)
		case "activeAssetCtx":
			var d struct {
				Coin string `json:"coin"`
				Ctx  struct {
					MidPx     string   `json:"midPx"`
					ImpactPxs []string `json:"impactPxs"`
				} `json:"ctx"`
			}
			if json.Unmarshal(m.Data, &d) != nil {
				continue
			}
			h.mu.Lock()
			last, ok := h.last[d.Coin]
			if !ok {
				// No touch yet (bbo waits for the touch to move): start from this message's mid and
				// impact prices, a little wider than the touch, until the first bbo arrives.
				if seed, good := seedTick(d.Coin, d.Ctx.MidPx, d.Ctx.ImpactPxs); good {
					h.last[d.Coin] = seed
					h.mu.Unlock()
					markUp()
					h.OnTick(seed)
					continue
				}
			}
			if ok {
				last.Seen, last.Heartbeat = time.Now(), true
				// The touch hasn't moved, and the market's mid still sits inside it: the price is
				// still good, so it isn't getting older.
				if mid, err := decimal.NewFromString(d.Ctx.MidPx); err == nil && !mid.LessThan(last.Bid) && !mid.GreaterThan(last.Ask) {
					last.Time = last.Seen
				}
				h.last[d.Coin] = last
			}
			h.mu.Unlock()
			if ok {
				h.OnTick(last)
			}
		}
	}
}

func seedTick(coin, midPx string, impact []string) (Tick, bool) {
	mid, err := decimal.NewFromString(midPx)
	if err != nil || !mid.IsPositive() || len(impact) != 2 {
		return Tick{}, false
	}
	bid, err1 := decimal.NewFromString(impact[0])
	ask, err2 := decimal.NewFromString(impact[1])
	if err1 != nil || err2 != nil || !bid.IsPositive() || ask.LessThan(bid) {
		return Tick{}, false
	}
	now := time.Now()
	return Tick{Reference: Hyperliquid(coin), Mid: mid, Bid: bid, Ask: ask, Time: now, Seen: now}, true
}

// HyperliquidCoinLive checks that Hyperliquid lists a coin ("xyz:GOOGL") with a live book.
func HyperliquidCoinLive(ctx context.Context, coin string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	body := map[string]string{"type": "metaAndAssetCtxs"}
	if dex, _, ok := strings.Cut(coin, ":"); ok {
		body["dex"] = dex
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hyperliquidInfo, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("checking with Hyperliquid: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("checking with Hyperliquid: HTTP %d", res.StatusCode)
	}
	var doc [2]json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return fmt.Errorf("checking with Hyperliquid: %w", err)
	}
	var meta struct {
		Universe []struct {
			Name       string `json:"name"`
			IsDelisted bool   `json:"isDelisted"`
		} `json:"universe"`
	}
	var ctxs []struct {
		MidPx *string `json:"midPx"`
	}
	if json.Unmarshal(doc[0], &meta) != nil || json.Unmarshal(doc[1], &ctxs) != nil {
		return fmt.Errorf("checking with Hyperliquid: unexpected answer")
	}
	for i, a := range meta.Universe {
		if a.Name != coin {
			continue
		}
		switch {
		case a.IsDelisted:
			return fmt.Errorf("hyperliquid %s is delisted", coin)
		case i >= len(ctxs) || ctxs[i].MidPx == nil || *ctxs[i].MidPx == "":
			return fmt.Errorf("hyperliquid %s has no live book", coin)
		}
		return nil
	}
	return fmt.Errorf("hyperliquid lists no %s", coin)
}
