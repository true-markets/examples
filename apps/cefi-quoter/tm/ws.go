package tm

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Message is one frame from the CeFi WebSocket. Data is left raw for the channel's own type.
// Every number in it is a decimal string and every timestamp is Unix nanoseconds as a string.
type Message struct {
	Channel       string          `json:"channel"`
	Update        string          `json:"update"`
	Status        string          `json:"status"`
	Text          string          `json:"message"`
	Seqnum        Str             `json:"seqnum"`
	Item          string          `json:"item"`
	Data          json.RawMessage `json:"data"`
	Subscriptions []Subscription  `json:"subscriptions"`
}

// Subscription is one channel and the items on it. DROPCOPY items are client ids; EBBO items
// are symbols; HEARTBEAT takes none.
type Subscription struct {
	Channel string   `json:"channel"`
	Items   []string `json:"item_names"`
}

// DropCopy is one DROPCOPY message: the whole current state of one of your orders, plus the
// event that changed it.
type DropCopy struct {
	OrderID      Str    `json:"order_id"`
	ExternalID   string `json:"external_id"`
	InstrumentID Str    `json:"instrument_id"`
	Symbol       string `json:"symbol"`
	Side         string `json:"side"`
	Status       string `json:"status"`
	Price        string `json:"price"`
	Quantity     string `json:"quantity"`
	LeavesQty    string `json:"leaves_qty"`
	ExecutedQty  string `json:"executed_qty"`
	ExecutedVwap string `json:"executed_vwap"`
	EventType    string `json:"event_type"` // NEW, TRADE, CANCELED, MODIFIED, REJECTED
	Text         string `json:"text"`
	TradePrice   string `json:"trade_price"`
	TradeQty     string `json:"trade_qty"`
	Timestamp    string `json:"timestamp"`
}

// Depth is one DEPTH message: a whole side of the book on a SNAPSHOT, or the levels that changed on
// an UPDATE. A level's qty is its new size; 0 removes it.
type Depth struct {
	Symbol string  `json:"symbol"`
	Bids   []Level `json:"bids"`
	Asks   []Level `json:"asks"`
}

type Level struct {
	Price string `json:"price"`
	Qty   string `json:"qty"`
}

// EBBO is the exchange's best bid and offer for one symbol.
type EBBO struct {
	Symbol string `json:"symbol"`
	Info   struct {
		BestBid *struct {
			Price string `json:"price"`
			Qty   string `json:"qty"`
		} `json:"best_bid"`
		BestAsk *struct {
			Price string `json:"price"`
			Qty   string `json:"qty"`
		} `json:"best_ask"`
	} `json:"info"`
}

// Feed keeps one authenticated connection to the CeFi WebSocket subscribed to a set of channels,
// reconnecting with backoff. Messages are handed to OnMessage on the feed's goroutine. Add
// subscribes to more items without reconnecting (a book added while running).
type Feed struct {
	Name           string // for logs
	URL            string
	Key            *APIKey
	OrganizationID string // organization keys only
	Subscriptions  []Subscription

	OnMessage func(Message)
	// OnState is told when every subscription is confirmed (up) and when the connection drops.
	OnState func(up bool, reason string)

	Log *slog.Logger

	mu   sync.Mutex
	live bool
	adds chan request
}

// request is one SUBSCRIBE, or UNSUBSCRIBE, waiting its turn on the connection.
type request struct {
	Subscription
	unsubscribe bool
}

// Add subscribes to more items on a channel: now if connected, and on every reconnect.
func (f *Feed) Add(channel string, items ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var fresh []string
	i := slices.IndexFunc(f.Subscriptions, func(s Subscription) bool { return s.Channel == channel })
	if i < 0 {
		f.Subscriptions = append(f.Subscriptions, Subscription{Channel: channel})
		i = len(f.Subscriptions) - 1
	}
	for _, it := range items {
		if !slices.Contains(f.Subscriptions[i].Items, it) {
			f.Subscriptions[i].Items = append(f.Subscriptions[i].Items, it)
			fresh = append(fresh, it)
		}
	}
	if f.live && len(fresh) > 0 {
		select {
		case f.adds <- request{Subscription: Subscription{Channel: channel, Items: fresh}}:
		default: // the session is backed up; it re-subscribes everything on its next reconnect
		}
	}
}

// Resubscribe drops one item and subscribes to it again, for a fresh snapshot: after a DEPTH
// update skipped a sequence number, say. Nothing happens while disconnected, since the next
// connection subscribes from scratch.
func (f *Feed) Resubscribe(channel, item string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.live {
		return
	}
	s := Subscription{Channel: channel, Items: []string{item}}
	for _, r := range []request{{Subscription: s, unsubscribe: true}, {Subscription: s}} {
		select {
		case f.adds <- r:
		default:
			return
		}
	}
}

func (f *Feed) subscriptions() []Subscription {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Subscription, len(f.Subscriptions))
	for i, s := range f.Subscriptions {
		out[i] = Subscription{Channel: s.Channel, Items: slices.Clone(s.Items)}
	}
	return out
}

// No frame for this long means a dead line. The exchange sends a heartbeat after 10 quiet seconds
// to anyone subscribed to HEARTBEAT, so a live connection is never this quiet.
const silence = 30 * time.Second

// Run connects and stays connected until ctx is done.
func (f *Feed) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := f.session(ctx)
		if ctx.Err() != nil {
			return
		}
		f.state(false, fmt.Sprintf("disconnected: %v", err))
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		f.Log.Warn("websocket down, reconnecting", "feed", f.Name, "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (f *Feed) state(up bool, reason string) {
	if f.OnState != nil {
		f.OnState(up, reason)
	}
}

func (f *Feed) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, f.URL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	f.mu.Lock()
	f.live, f.adds = true, make(chan request, 64)
	adds := f.adds
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.live = false
		f.mu.Unlock()
	}()

	frames := make(chan Message, 1024)
	readErr := make(chan error, 1)
	go func() {
		for {
			_ = conn.SetReadDeadline(time.Now().Add(silence))
			_, raw, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			var m Message
			if err := json.Unmarshal(raw, &m); err != nil {
				f.Log.Warn("unparseable frame", "feed", f.Name, "err", err)
				continue
			}
			select {
			case frames <- m:
			case <-ctx.Done():
				return
			}
		}
	}()

	// The exchange refuses a signed request while an earlier one is still authenticating, so
	// requests go one at a time: each waits for a confirmation, or for 5 seconds.
	var queue []request
	for _, s := range f.subscriptions() {
		queue = append(queue, request{Subscription: s})
	}
	confirmed := map[string]bool{}
	var waitTimer <-chan time.Time
	sendNext := func() error {
		if len(queue) == 0 {
			return nil
		}
		next := queue[0]
		queue = queue[1:]
		waitTimer = time.After(5 * time.Second)
		return conn.WriteJSON(f.signed(next.Subscription, next.unsubscribe))
	}
	// Anything the exchange didn't confirm (it rate limits subscription changes) is asked for again.
	missing := func() []request {
		var out []request
		for _, s := range f.subscriptions() {
			if !confirmed[s.Channel] {
				out = append(out, request{Subscription: s})
			}
		}
		return out
	}
	if err := sendNext(); err != nil {
		return err
	}
	up := false
	var retry <-chan time.Time

	for {
		select {
		case err := <-readErr:
			return err
		case add := <-adds:
			queue = append(queue, add)
			if waitTimer == nil {
				if err := sendNext(); err != nil {
					return err
				}
			}
		case <-waitTimer:
			waitTimer = nil
			if err := sendNext(); err != nil {
				return err
			}
		case <-retry:
			retry = nil
			queue = missing()
			if err := sendNext(); err != nil {
				return err
			}
		case m := <-frames:
			if m.Channel != "WEBSOCKET" {
				if f.OnMessage != nil {
					f.OnMessage(m)
				}
				continue
			}
			if m.Update == "WELCOME" {
				continue
			}
			// A confirmation lists everything this connection is subscribed to now.
			if m.Status != "AUTHENTICATED" && m.Status != "" {
				f.Log.Warn("subscription not confirmed", "feed", f.Name, "status", m.Status, "message", m.Text)
			}
			for _, s := range m.Subscriptions {
				confirmed[s.Channel] = true
			}
			waitTimer = nil
			if len(queue) > 0 {
				if err := sendNext(); err != nil {
					return err
				}
				continue
			}
			if len(missing()) == 0 {
				if !up {
					up = true
					f.Log.Info("websocket subscribed", "feed", f.Name)
					f.state(true, "")
				}
			} else if retry == nil {
				f.state(false, "waiting for the exchange to confirm subscriptions: "+m.Text)
				retry = time.After(3 * time.Second)
			}
		}
	}
}

// signed builds the SUBSCRIBE (or UNSUBSCRIBE) request: the signature is over
// timestamp + "TRUEXWS" + key + path.
func (f *Feed) signed(s Subscription, unsubscribe bool) map[string]any {
	path := "/v1/cefi/market"
	if u, err := url.Parse(f.URL); err == nil && u.Path != "" {
		path = u.Path
	}
	items := s.Items
	if items == nil {
		items = []string{}
	}
	ts := UnixSeconds()
	msg := map[string]any{
		"type":       map[bool]string{false: "SUBSCRIBE", true: "UNSUBSCRIBE"}[unsubscribe],
		"channels":   []string{s.Channel},
		"item_names": items,
		"timestamp":  ts,
		"key":        f.Key.KeyID,
		"signature":  f.Key.Sign(ts + "TRUEXWS" + f.Key.KeyID + path),
	}
	if f.OrganizationID != "" {
		msg["organization_id"] = f.OrganizationID
	}
	return msg
}
