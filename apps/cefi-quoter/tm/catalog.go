package tm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// StockListing is a CeFi instrument the public asset catalog lists as a tokenized stock.
type StockListing struct {
	Symbol string // the CeFi instrument, e.g. GOOGLC-USDC
	Name   string // e.g. Alphabet
	Slug   string // e.g. alphabet-coinbase-tokenized-stock: names the issuer
}

// StockListings asks the public asset catalog (no key) which CeFi instruments are tokenized
// stocks, by symbol.
func StockListings(ctx context.Context, catalogURL string) (map[string]StockListing, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	u := strings.TrimRight(catalogURL, "/") + "/v1/gateway/assets?" + url.Values{"asset_class": {"stock"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("asset catalog: HTTP %d", res.StatusCode)
	}
	var doc struct {
		Data []struct {
			Venue          string `json:"venue"`
			CefiInstrument string `json:"cefi_instrument"`
			Name           string `json:"name"`
			Slug           string `json:"slug"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("asset catalog: %w", err)
	}
	out := map[string]StockListing{}
	for _, a := range doc.Data {
		if a.Venue == "cefi" && a.CefiInstrument != "" {
			out[a.CefiInstrument] = StockListing{Symbol: a.CefiInstrument, Name: a.Name, Slug: a.Slug}
		}
	}
	return out, nil
}

// Ticker is the underlying stock's ticker. The catalog has no ticker field, so it follows the
// issuer's naming rule, and the issuer comes from the listing's slug:
//
//	Coinbase tokenized stocks drop a trailing C: GOOGLC -> GOOGL
//	Robinhood tokens are the ticker itself:       NVDA   -> NVDA
//
// Any other issuer's rule isn't known; ok is false and the book needs its reference named.
func (l StockListing) Ticker() (ticker string, ok bool) {
	base, _, _ := strings.Cut(l.Symbol, "-")
	switch {
	case strings.HasSuffix(l.Slug, "coinbase-tokenized-stock") && len(base) > 1 && strings.HasSuffix(base, "C"):
		return strings.TrimSuffix(base, "C"), true
	case strings.HasSuffix(l.Slug, "robinhood-token") && base != "":
		return base, true
	}
	return "", false
}
