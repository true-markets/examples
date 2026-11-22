package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
	"github.com/true-markets/examples/apps/cefi-quoter/reference"
)

// The books file lists the books to quote and each one's settings. The quoter writes it whenever
// a book is added or removed or its settings change on the management API, so the books come back
// as they were on the next start. You can also write it by hand; settings a book leaves out come
// from .env:
//
//	{
//	  "books": {
//	    "BTC-USDC": {"params": {"quoteSize": "0.0002", "maxQuoteAlloc": "2000"}},
//	    "GOOGLC-USDC": {"blend": {"sources": [
//	      {"ref": "hyperliquid:xyz:GOOGL", "weight": 2},
//	      {"ref": "kraken:GOOGLx/USD", "weight": 1, "multiplier": "1"}
//	    ]}}
//	  }
//	}
//
// A book with no blend uses the listing's default reference. "reference": "ETH-USD", from before
// blends, still reads as a blend of that one source.
type booksFile struct {
	Books map[string]bookEntry `json:"books"`
}

type bookEntry struct {
	Reference string                 `json:"reference,omitempty"`
	Blend     *reference.BlendConfig `json:"blend,omitempty"`
	Params    json.RawMessage        `json:"params,omitempty"`
}

type savedBook struct {
	Symbol string
	Blend  *reference.BlendConfig // nil: the listing's default
	Params quoter.Params
}

// retired are settings an earlier version saved that no longer exist, and what replaced them.
// They're dropped on load with a warning, so a file the quoter wrote itself never stops an
// upgraded quoter from starting. Any other unknown key is still an error: it's most likely a typo
// in a hand-written file.
var retired = map[string]string{
	"maxBaseAllocUsd": "set the book's \"Sizes in\" to the quote currency and put the dollar cap in maxBaseAlloc",
}

// loadBooks reads the books file. A missing file means no books yet. warnings name any retired
// settings it dropped.
func loadBooks(path string, defaults quoter.Params) (books []savedBook, warnings []string, err error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var f booksFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", path, err)
	}
	var out []savedBook
	for sym, b := range f.Books {
		p := defaults
		// Books saved before sizeUnit existed have their sizes in the base asset. Keep reading them
		// that way, whatever SIZE_UNIT says for new books.
		var keys map[string]json.RawMessage
		if json.Unmarshal(b.Params, &keys) == nil {
			if _, set := keys["sizeUnit"]; !set {
				p.SizeUnit = quoter.SizeInBase
			}
			for k, instead := range retired {
				if v, ok := keys[k]; ok {
					delete(keys, k)
					warnings = append(warnings, fmt.Sprintf("%s: dropped %s (%s) from %s: that setting is gone; %s", sym, k, strings.Trim(string(v), `"`), path, instead))
				}
			}
			b.Params, _ = json.Marshal(keys)
		}
		if len(b.Params) > 0 {
			if p, err = p.Merge(b.Params); err != nil {
				return nil, nil, fmt.Errorf("%s: %s: %w", path, sym, err)
			}
		}
		// Books saved before taking existed have no take size of their own, and the default is in
		// dollars. In a book sized in the base asset that would read as 20 coins; use the book's
		// own scale instead.
		if _, set := keys["takeMaxSize"]; !set && p.SizeUnit == quoter.SizeInBase && defaults.SizeUnit != quoter.SizeInBase {
			p.TakeMaxSize = baseTakeSize(p)
		}
		blend := b.Blend
		if blend == nil && b.Reference != "" {
			single := reference.Single(b.Reference)
			blend = &single
		}
		out = append(out, savedBook{Symbol: sym, Blend: blend, Params: p})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	sort.Strings(warnings)
	return out, warnings, nil
}

// saveBooks writes the books file in one step (write a temporary file, then rename), so a crash
// mid-write never leaves half a file.
func saveBooks(path string, books map[string]quoter.BookConfig) error {
	f := struct {
		Books map[string]quoter.BookConfig `json:"books"`
	}{Books: books}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".books-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// baseTakeSize is a take size on a base-asset book's own scale: its max position change, or a
// level's size if it has no position limit.
func baseTakeSize(p quoter.Params) decimal.Decimal {
	if p.MaxPosition.IsPositive() {
		return p.MaxPosition
	}
	return p.QuoteSize
}
