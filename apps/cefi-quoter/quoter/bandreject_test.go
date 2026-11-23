package quoter

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestBandRejectLimitStopsTheBook(t *testing.T) {
	const band = "Order outside book price bands"
	e := &Engine{params: Params{BandRejectLimit: 3}, enabled: true, log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	e.bandRejectLocked("Insufficient balance") // other rejects don't count
	e.bandRejectLocked(band)
	e.bandRejectLocked(band)
	if !e.enabled {
		t.Fatal("stopped after 2 band rejects; the limit is 3")
	}
	// One that fell out of the minute no longer counts.
	e.bandRejects[0] = time.Now().Add(-2 * bandRejectWindow)
	e.bandRejectLocked(band)
	if !e.enabled {
		t.Fatal("stopped counting a reject from over a minute ago")
	}
	e.bandRejectLocked(band)
	if e.enabled {
		t.Fatal("still quoting after 3 band rejects within a minute")
	}
	if halt, pull := e.haltReasonLocked(); halt != "stopped" || !pull {
		t.Fatalf("halt = %q, pull = %v; want stopped and pulled", halt, pull)
	}

	// 0 turns it off.
	off := &Engine{params: Params{}, enabled: true, log: e.log}
	for range 100 {
		off.bandRejectLocked(band)
	}
	if !off.enabled {
		t.Fatal("a limit of 0 stopped the book")
	}
}

func TestRejectLogKeepsTheLatestNewestFirst(t *testing.T) {
	e := &Engine{market: Market{Symbol: "NVDA-USDC"}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for i := range maxRejects + 5 {
		e.rejectLocked(Reject{Request: Create, Side: Buy, Level: "L0", Price: "1", Qty: "1", Reason: "Order outside book price bands", Via: "drop copy"})
		e.rejects[len(e.rejects)-1].Time = time.Unix(int64(i), 0)
	}
	got := e.Rejects()
	if len(got) != maxRejects || got[0].Time.Unix() != maxRejects+4 || got[0].Book != "NVDA-USDC" {
		t.Fatalf("kept %d, newest at %d, book %q", len(got), got[0].Time.Unix(), got[0].Book)
	}
	e.ResetRejects()
	if len(e.Rejects()) != 0 {
		t.Fatal("reset left rejects in the log")
	}
}
