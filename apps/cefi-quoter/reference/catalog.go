package reference

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/shopspring/decimal"
)

// What each source lists, read from its public API and kept for a while: enough to check a name
// before subscribing to it, and to suggest sources for a book.

const catalogTTL = 10 * time.Minute

type cached[T any] struct {
	mu   sync.Mutex
	val  T
	at   time.Time
	load func(context.Context) (T, error)
}

func (c *cached[T]) get(ctx context.Context) (T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < catalogTTL {
		return c.val, nil
	}
	v, err := c.load(ctx)
	if err != nil {
		var zero T
		if !c.at.IsZero() {
			return c.val, nil // an older copy beats none
		}
		return zero, err
	}
	c.val, c.at = v, time.Now()
	return v, nil
}

// Kraken pairs by WebSocket name (BTC/USD, GOOGLx/USD) -> status. Tokenized stocks are their own
// asset class and only listed when asked for.
var krakenCatalog = &cached[map[string]string]{load: func(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	for _, q := range []string{"", "?aclass_base=tokenized_asset"} {
		var doc struct {
			Error  []string `json:"error"`
			Result map[string]struct {
				WSName string `json:"wsname"`
				Status string `json:"status"`
			} `json:"result"`
		}
		if err := getJSON(ctx, "https://api.kraken.com/0/public/AssetPairs"+q, &doc); err != nil {
			return nil, fmt.Errorf("kraken pairs: %w", err)
		}
		if len(doc.Error) > 0 {
			return nil, fmt.Errorf("kraken pairs: %s", strings.Join(doc.Error, "; "))
		}
		for _, p := range doc.Result {
			if p.WSName != "" {
				// The pair list still uses Kraken's old asset codes; the v2 WebSocket doesn't.
				name := strings.NewReplacer("XBT/", "BTC/", "XDG/", "DOGE/").Replace(p.WSName)
				out[name] = p.Status
			}
		}
	}
	return out, nil
}}

func krakenPairs(ctx context.Context) (map[string]string, error) { return krakenCatalog.get(ctx) }

// Hyperliquid coins with a live book, on every dex: the main one (BTC) and the HIP-3 dexes, whose
// coins carry the dex's name (xyz:GOOGL).
var hyperliquidCatalog = &cached[map[string]bool]{load: func(ctx context.Context) (map[string]bool, error) {
	var dexes []*struct {
		Name string `json:"name"`
	}
	if err := postJSON(ctx, hyperliquidInfo, map[string]string{"type": "perpDexs"}, &dexes); err != nil {
		return nil, fmt.Errorf("hyperliquid dexes: %w", err)
	}
	out := map[string]bool{}
	for _, d := range dexes {
		body := map[string]string{"type": "metaAndAssetCtxs"}
		if d != nil {
			body["dex"] = d.Name // nil is the main dex
		}
		var doc [2]json.RawMessage
		if err := postJSON(ctx, hyperliquidInfo, body, &doc); err != nil {
			continue // one dex down shouldn't hide the others
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
			continue
		}
		for i, a := range meta.Universe {
			if !a.IsDelisted && i < len(ctxs) && ctxs[i].MidPx != nil && *ctxs[i].MidPx != "" {
				out[a.Name] = true
			}
		}
	}
	return out, nil
}}

// Suggest lists the sources that quote an underlying: a stock's ticker (GOOGL) or a crypto asset
// (BTC). Each gets weight 1, except a Kraken pair that's post-only (quotes rest, nothing matches,
// so its prices are only indicative): that one is suggested to watch, at weight 0.
func Suggest(ctx context.Context, underlying string, stock bool) []Source {
	var out []Source
	one := decimal.NewFromInt(1)
	add := func(ref string) {
		out = append(out, Source{Ref: ref, Weight: 1, Multiplier: one})
	}
	addKraken := func(pair string, pairs map[string]string) {
		switch pairs[pair] {
		case "online":
			add(Kraken(pair))
		case "post_only":
			out = append(out, Source{Ref: Kraken(pair), Weight: 0, Multiplier: one})
		}
	}
	coins, _ := hyperliquidCatalog.get(ctx)
	pairs, _ := krakenPairs(ctx)
	if stock {
		// The xyz dex first: the deepest stock perps.
		if coins[StockDex+":"+underlying] {
			add(Hyperliquid(StockDex + ":" + underlying))
		}
		for coin := range coins {
			if dex, t, ok := strings.Cut(coin, ":"); ok && t == underlying && dex != StockDex {
				add(Hyperliquid(coin))
			}
		}
		addKraken(underlying+"x/USD", pairs)
		return out
	}
	if CoinbaseProductExists(ctx, underlying+"-USD") == nil {
		add(underlying + "-USD")
	}
	addKraken(underlying+"/USD", pairs)
	if coins[underlying] {
		add(Hyperliquid(underlying))
	}
	return out
}

func getJSON(ctx context.Context, url string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "cefi-quoter")
	return doJSON(req, out)
}

func postJSON(ctx context.Context, url string, body, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return doJSON(req, out)
}

func doJSON(req *http.Request, out any) error {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}
