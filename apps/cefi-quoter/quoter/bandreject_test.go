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
