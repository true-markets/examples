package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
)

// The state file carries each book's position, PnL, activity and recent events, and the trade
// journal, across restarts (see quoter/state.go). In paper mode it also carries the paper
// account's balances, so the positions still match them. One file per environment:
// state.production.json, state.uat.json, state.paper.json.
//
// Delete it to start every book from zero.
type stateFile struct {
	quoter.State
	PaperBalances map[string]decimal.Decimal `json:"paperBalances,omitempty"`
}

// loadState reads the state file; nil if there isn't one yet.
func loadState(path string) (*stateFile, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s stateFile
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("%s: %w (delete it to start every book's position from zero)", path, err)
	}
	return &s, nil
}

// saveState writes the state file in one step, like the books file.
func saveState(path string, s stateFile) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-*.json")
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
