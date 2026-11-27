package tm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Hosts are the base URLs for one True Markets environment.
type Hosts struct {
	Auth    string // token minting
	CeFi    string // CeFi REST
	WS      string // CeFi WebSocket
	Catalog string // the public asset catalog: which listings are tokenized stocks
}

var Environments = map[string]Hosts{
	"production": {
		Auth:    "https://api.truemarkets.co/v1/auth",
		CeFi:    "https://api.truex.co/v1/cefi",
		WS:      "wss://api.truemarkets.co/v1/cefi/market",
		Catalog: "https://api.truemarkets.co",
	},
	"uat": {
		Auth:    "https://api.uat.truemarkets.co/v1/auth",
		CeFi:    "https://api.uat.truex.co/v1/cefi",
		WS:      "wss://api.uat.truemarkets.co/v1/cefi/market",
		Catalog: "https://api.uat.truemarkets.co",
	},
}

// APIError is a non-2xx answer from True Markets.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// IsRejection reports whether the exchange answered and said no (a 4xx), as opposed to the request
// never getting an answer. Only a rejection proves the exchange did not act on a request.
func IsRejection(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500
}

// ErrRateLimited is returned without sending while a 429's window is still running.
var ErrRateLimited = errors.New("rate limited by True Markets; waiting for the window to reset")

// apiError reads an error body. CeFi REST sends { error: { title, detail } }; other APIs send
// { type, code, message, field_violations, request_id }. Whatever is there is kept, so the reason
// reaches the log: a 400's field_violations name the field the exchange refused, and request_id is
// what support asks for.
func apiError(res *http.Response, doing string) error {
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	detail := strings.TrimSpace(string(raw))
	var body map[string]any
	if json.Unmarshal(raw, &body) == nil {
		inner := body
		if e, ok := body["error"].(map[string]any); ok {
			inner = e
		}
		var parts []string
		for _, k := range []string{"detail", "message", "title", "code"} {
			if s, ok := inner[k].(string); ok && s != "" && !contains(parts, s) {
				parts = append(parts, s)
			}
		}
		if s, ok := body["error"].(string); ok && s != "" {
			parts = append(parts, s)
		}
		for _, src := range []map[string]any{inner, body} {
			if fv, ok := src["field_violations"]; ok && fv != nil {
				if b, err := json.Marshal(fv); err == nil && string(b) != "[]" && string(b) != "null" {
					parts = append(parts, "field_violations "+string(b))
				}
				break
			}
		}
		for _, src := range []map[string]any{inner, body} {
			if id, ok := src["request_id"].(string); ok && id != "" {
				parts = append(parts, "request_id "+id)
				break
			}
		}
		if len(parts) > 0 {
			detail = strings.Join(parts, ": ")
		}
	}
	if len(detail) > 800 {
		detail = detail[:800]
	}
	return &APIError{Status: res.StatusCode, Message: fmt.Sprintf("%s failed (%d): %s", doing, res.StatusCode, detail)}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Str unmarshals a JSON string or number into a string, so ids survive whichever the API sends.
type Str string

func (s *Str) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var v string
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*s = Str(v)
		return nil
	}
	*s = Str(b)
	return nil
}

// REST is a client for the CeFi REST API (https://api.truex.co/v1/cefi).
type REST struct {
	base   string
	tokens *TokenSource
	http   *http.Client

	mu          sync.Mutex
	pausedUntil time.Time
}

func NewREST(base string, tokens *TokenSource) *REST {
	return &REST{base: base, tokens: tokens, http: &http.Client{Timeout: 10 * time.Second}}
}

// do sends one request. out may be nil.
func (c *REST) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	c.mu.Lock()
	wait := time.Until(c.pausedUntil)
	c.mu.Unlock()
	if wait > 0 {
		return ErrRateLimited
	}
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+token)
	// CeFi REST rejects a request without a fresh timestamp, as a replay guard.
	req.Header.Set("x-truex-auth-timestamp", UnixSeconds())
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		// X-RateLimit-Reset is seconds until the window resets. Stop sending until then rather than
		// adding to the count.
		reset, _ := strconv.Atoi(res.Header.Get("x-ratelimit-reset"))
		if reset <= 0 || reset > 120 {
			reset = 10
		}
		c.mu.Lock()
		c.pausedUntil = time.Now().Add(time.Duration(reset) * time.Second)
		c.mu.Unlock()
	}
	if res.StatusCode >= 300 {
		return apiError(res, method+" "+path)
	}
	if out == nil || res.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// page is the envelope every CeFi list read comes in.
type page[T any] struct {
	Data       []T `json:"data"`
	Pagination struct {
		NextCursor *string `json:"next_cursor"`
	} `json:"pagination"`
}

// all reads every page of a list. Lists default to 10 rows; size goes up to 100, and the next
// page is asked for by passing pagination.next_cursor back as timestamp.
func all[T any](ctx context.Context, c *REST, path string, query url.Values) ([]T, error) {
	return pages[T](ctx, c, path, query, 50)
}

// pages reads up to max pages of a list, newest first.
func pages[T any](ctx context.Context, c *REST, path string, query url.Values, max int) ([]T, error) {
	if query == nil {
		query = url.Values{}
	}
	query.Set("size", "100")
	var out []T
	cursor := ""
	for i := 0; i < max; i++ {
		if cursor != "" {
			query.Set("timestamp", cursor)
		}
		var p page[T]
		if err := c.do(ctx, http.MethodGet, path, query, nil, &p); err != nil {
			return nil, err
		}
		out = append(out, p.Data...)
		if p.Pagination.NextCursor == nil || *p.Pagination.NextCursor == "" || *p.Pagination.NextCursor == cursor {
			break
		}
		cursor = *p.Pagination.NextCursor
	}
	return out, nil
}

type Instrument struct {
	ID     Str    `json:"id"`
	Status string `json:"status"`
	Info   struct {
		Symbol       string `json:"symbol"`
		BaseAssetID  Str    `json:"base_asset_id"`
		QuoteAssetID Str    `json:"quote_asset_id"`
	} `json:"info"`
}

func (c *REST) Instruments(ctx context.Context) ([]Instrument, error) {
	return all[Instrument](ctx, c, "/instruments", nil)
}

type Asset struct {
	ID     Str `json:"id"`
	Fields struct {
		Name string `json:"name"`
	} `json:"fields"`
}

func (c *REST) Assets(ctx context.Context) ([]Asset, error) {
	return all[Asset](ctx, c, "/assets", nil)
}

// Clients lists the CeFi clients this key can trade. Used to find the client id when the token
// doesn't carry one.
func (c *REST) Clients(ctx context.Context) ([]struct {
	ID Str `json:"id"`
}, error) {
	var p page[struct {
		ID Str `json:"id"`
	}]
	err := c.do(ctx, http.MethodGet, "/clients", nil, nil, &p)
	return p.Data, err
}

// Balances is one CeFi client's balances (GET /balances).
type Balances struct {
	FeesHold      string `json:"fees_hold"`
	UnsettledFees string `json:"unsettled_fees"`
	Balances      []struct {
		AssetID      Str    `json:"asset_id"`
		Balance      string `json:"balance"`
		Unsettled    string `json:"unsettled"`
		OrderHold    string `json:"order_hold"`
		TransferHold string `json:"transfer_hold"`
	} `json:"balances"`
}

func (c *REST) Balances(ctx context.Context) (*Balances, error) {
	var p page[Balances]
	if err := c.do(ctx, http.MethodGet, "/balances", nil, nil, &p); err != nil {
		return nil, err
	}
	if len(p.Data) == 0 {
		return &Balances{}, nil
	}
	return &p.Data[0], nil
}

// RestOrder is an order as GET /orders/active returns it. A modified order keeps its original
// terms in order_info and has the current ones in modify_info.
type RestOrder struct {
	ID         Str    `json:"id"`
	Status     string `json:"status"`
	ExternalID string `json:"external_id"`
	OrderInfo  struct {
		InstrumentID Str    `json:"instrument_id"`
		Qty          string `json:"qty"`
		Price        string `json:"price"`
		Side         string `json:"side"`
	} `json:"order_info"`
	ModifyInfo struct {
		NewQty   string `json:"new_qty"`
		NewPrice string `json:"new_price"`
	} `json:"modify_info"`
	LeavesQty   string `json:"leaves_qty"`
	ExecutedQty string `json:"executed_qty"`
}

// CurrentTerms is the order's price and total quantity now, after any modify.
func (o RestOrder) CurrentTerms() (price, qty string) {
	price, qty = o.OrderInfo.Price, o.OrderInfo.Qty
	if nonZero(o.ModifyInfo.NewPrice) {
		price = o.ModifyInfo.NewPrice
	}
	if nonZero(o.ModifyInfo.NewQty) {
		qty = o.ModifyInfo.NewQty
	}
	return price, qty
}

func nonZero(s string) bool {
	f, err := strconv.ParseFloat(s, 64)
	return err == nil && f != 0
}

func (c *REST) ActiveOrders(ctx context.Context) ([]RestOrder, error) {
	return all[RestOrder](ctx, c, "/orders/active", nil)
}

// RecentOrders is the account's latest orders, newest first, finished ones included, up to
// about 2,000. After a crash it says how much of each order we had resting filled while the
// quoter was down.
func (c *REST) RecentOrders(ctx context.Context) ([]RestOrder, error) {
	return pages[RestOrder](ctx, c, "/orders", nil, 20)
}

// TradeFill is one of the account's fills from GET /orders/trade: one match on one order, with
// the fee the exchange charged for it.
type TradeFill struct {
	OrderID   Str    `json:"order_id"`
	MatchID   Str    `json:"match_id"`
	Side      string `json:"side"`
	Price     string `json:"trade_price"`
	Qty       string `json:"trade_qty"`
	FeeBps    string `json:"trade_fee_bps"`
	Liquidity string `json:"liq_flag"` // MAKER, TAKER or SETTER
	Timestamp string `json:"timestamp"`
}

// Trades is the account's fills, newest first, up to max pages of 100.
func (c *REST) Trades(ctx context.Context, max int) ([]TradeFill, error) {
	q := url.Values{"timestamp": {strconv.FormatInt(time.Now().UnixNano(), 10)}}
	return pages[TradeFill](ctx, c, "/orders/trade", q, max)
}

// NewOrder is the body of POST /orders.
type NewOrder struct {
	ClientID     string
	InstrumentID string
	ExternalID   string
	Side         string // BUY or SELL
	Price        string
	Qty          string
	PostOnly     bool // ALO: rest only, never take
	IOC          bool // immediate or cancel: take what's there now, cancel the rest
}

// CreateOrder sends a limit order (GTC, or IOC for a take) and returns the exchange's order id.
func (c *REST) CreateOrder(ctx context.Context, o NewOrder) (string, error) {
	info := map[string]any{
		"client_id":     o.ClientID,
		"instrument_id": o.InstrumentID,
		"side":          o.Side,
		"type":          "LIMIT",
		"tif":           tif(o.IOC),
		"qty":           o.Qty,
		"price":         o.Price,
	}
	if o.PostOnly && !o.IOC {
		// Add Liquidity Only: the exchange rejects the order rather than let it take.
		info["exec_inst_flags"] = []string{"ALO"}
	}
	var out struct {
		ID   Str `json:"id"`
		Data struct {
			ID Str `json:"id"`
		} `json:"data"`
	}
	err := c.do(ctx, http.MethodPost, "/orders", nil, map[string]any{"external_id": o.ExternalID, "info": info}, &out)
	if out.ID == "" {
		out.ID = out.Data.ID
	}
	return string(out.ID), err
}

// ModifyOrder changes a resting order's price and total quantity in place (PATCH /orders). The
// order is named by our own external_id, so we never need to wait for the exchange's order id.
// qty is the order's new TOTAL: the exchange keeps executed_qty and rests qty - executed_qty.
func (c *REST) ModifyOrder(ctx context.Context, clientID, externalID, price, qty string) error {
	return c.do(ctx, http.MethodPatch, "/orders", nil, map[string]any{
		"external_id": externalID,
		"info":        map[string]any{"client_id": clientID, "new_qty": qty, "new_price": price},
	}, nil)
}

// CancelOrder cancels by our external_id (DELETE /orders/{id}?id_type=client).
func (c *REST) CancelOrder(ctx context.Context, externalID string) error {
	return c.do(ctx, http.MethodDelete, "/orders/"+url.PathEscape(externalID), url.Values{"id_type": {"client"}}, nil, nil)
}

func tif(ioc bool) string {
	if ioc {
		return "IOC"
	}
	return "GTC"
}
