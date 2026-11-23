package quoter

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

func fakeClock(p *Pacer) *time.Time {
	now := time.Unix(1_700_000_000, 0)
	p.now = func() time.Time { return now }
	return &now
}

func takeN(p *Pacer, n int) int {
	got := 0
	for range n {
		if p.Take() {
			got++
		}
	}
	return got
}

// No one-second window, however it lines up, ever holds more than the limit.
func TestPacerWindow(t *testing.T) {
	p := NewPacer(10, 0)
	now := fakeClock(p)
	start := *now
	var sent []time.Time
	for i := range 3000 { // 3s in 1ms steps, asking every step
		*now = start.Add(time.Duration(i) * time.Millisecond)
		if p.Take() {
			sent = append(sent, *now)
		}
	}
	for i := range sent {
		n := 0
		for _, s := range sent[i:] {
			if s.Sub(sent[i]) < time.Second {
				n++
			}
		}
		if n > 10 {
			t.Fatalf("%d requests in the second from %s", n, sent[i].Sub(start))
		}
	}
	if len(sent) != 30 {
		t.Fatalf("%d sent in 3s, want 30", len(sent))
	}
}

// The minute limit holds across seconds: with room for 10 a second and 25 a minute, the first
// three seconds send 10, 10 and 5, then nothing until a minute after the first.
func TestPacerMinuteWindow(t *testing.T) {
	p := NewPacer(10, 25)
	now := fakeClock(p)
	start := *now
	got := []int{}
	for range 3 {
		got = append(got, takeN(p, 50))
		*now = now.Add(time.Second)
	}
	if got[0] != 10 || got[1] != 10 || got[2] != 5 {
		t.Fatalf("per second: %v", got)
	}
	*now = start.Add(59 * time.Second)
	if n := takeN(p, 50); n != 0 {
		t.Fatalf("%d sent before the minute ran out", n)
	}
	*now = start.Add(60 * time.Second) // the first second's 10 age out
	if n := takeN(p, 50); n != 10 {
		t.Fatalf("%d after the first second aged out", n)
	}
	if s := p.Status(); s.PerMin != 25 || s.UsedMin != 25 || s.Used != 10 {
		t.Fatalf("%+v", s)
	}
}

func TestPacerUsage(t *testing.T) {
	p := NewPacer(0, 0) // usage is counted with or without a limit
	now := fakeClock(p)
	takeN(p, 7)
	*now = now.Add(500 * time.Millisecond)
	takeN(p, 5)
	if s := p.Status(); s.Used != 12 || s.UsedMin != 12 || s.Peak != 12 {
		t.Fatalf("%+v", s)
	}
	*now = now.Add(600 * time.Millisecond) // the first 7 are over a second old
	if s := p.Status(); s.Used != 5 || s.Peak != 12 {
		t.Fatalf("%+v", s)
	}
	*now = now.Add(time.Minute) // the peak ages out after a minute
	if s := p.Status(); s.Used != 0 || s.Peak != 0 {
		t.Fatalf("%+v", s)
	}
}

func TestPacerPausesOnRateLimitAndBacksOff(t *testing.T) {
	p := NewPacer(0, 0) // no window: only the pause
	now := fakeClock(p)
	if !p.Take() {
		t.Fatal("unlimited pacer refused")
	}
	if d := p.Limited(); d != time.Second {
		t.Fatalf("first pause %s", d)
	}
	// The rest of the burst's rejects arrive during the pause: no new pause, no longer pause.
	if d := p.Limited(); d != 0 {
		t.Fatalf("a reject during the pause started another: %s", d)
	}
	if p.Take() {
		t.Fatal("sent while paused")
	}
	*now = now.Add(1100 * time.Millisecond)
	if !p.Take() {
		t.Fatal("still paused after it ran out")
	}
	// Limited again soon after: the pause doubles, up to 30s.
	want := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for _, w := range want {
		if d := p.Limited(); d != w {
			t.Fatalf("pause %s, want %s", d, w)
		}
		*now = now.Add(p.PausedFor() + time.Millisecond)
	}
	// Quiet for longer than the cap: back to a second.
	*now = now.Add(31 * time.Second)
	if d := p.Limited(); d != time.Second {
		t.Fatalf("after a quiet spell: %s", d)
	}
}

func TestPacerAfterPauseKeepsTheLimit(t *testing.T) {
	p := NewPacer(10, 0)
	now := fakeClock(p)
	p.Limited()
	if got := takeN(p, 50); got != 0 {
		t.Fatalf("during the pause: %d", got)
	}
	*now = now.Add(time.Second)
	if got := takeN(p, 50); got != 10 {
		t.Fatalf("after the pause: %d, want the limit", got)
	}
}

func TestRateLimitRejectText(t *testing.T) {
	for _, s := range []string{"Rate limit exceeded", "rate limited by True Markets; waiting for the window to reset", "Too Many Requests"} {
		if !isRateLimitReject(s) {
			t.Errorf("%q not recognized", s)
		}
	}
	if isRateLimitReject("Insufficient balance") || isRateLimitReject("Modification does not modify order") {
		t.Error("false positive")
	}
	if !isRateLimitErr(&tm.APIError{Status: 429}) || !isRateLimitErr(tm.ErrRateLimited) || isRateLimitErr(&tm.APIError{Status: 422, Message: "Insufficient balance"}) {
		t.Error("isRateLimitErr")
	}
}

// Every book draws on one pacer: with room for 3 requests a second, two books asking for 6 each
// send 3 between them in the first second, then 3 more in the next.
func TestBooksShareThePacer(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "eth": "10", "usdc": "100000"})
	desk := NewDesk(DeskConfig{
		Mode: "paper", Environment: "test", IDPrefix: "cq", Defaults: testParams(), Catalog: testCatalog,
		Venue: fx, NewTransport: fx.transport, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), OrderRate: 3,
	})
	fx.desk = desk
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go desk.Run(ctx)
	for _, c := range []string{ConnDropCopy, ConnMarket, ConnReference} {
		desk.SetConn(c, true, "")
	}
	books := []string{"BTC-USDC", "ETH-USDC"}
	for _, s := range books {
		addBook(t, desk, s, testParams())
	}
	tick(desk, "BTC-USD", "50000")
	tick(desk, "ETH-USD", "3000")
	for _, s := range books {
		desk.Engine(s).SetEnabled(true)
	}
	time.Sleep(300 * time.Millisecond)
	if n := fx.counts()["create"]; n != 3 {
		t.Fatalf("%d creates in the first 300ms, want the limit of 3", n)
	}
	waitFor(t, "three more the next second", func() bool { return fx.counts()["create"] >= 6 })

	// The window is full, but cancels don't count: stopping pulls every quote at once.
	for _, b := range books {
		desk.Engine(b).SetEnabled(false)
	}
	time.Sleep(300 * time.Millisecond)
	if n := fx.resting(""); n != 0 {
		t.Fatalf("%d quotes still resting 300ms after stopping", n)
	}
}

// A rate-limit reject pauses every book, says so once, and leaves the resting quotes alone.
func TestRateLimitRejectPausesEveryBook(t *testing.T) {
	fx := newFake(map[string]string{"btc": "1", "eth": "10", "usdc": "100000"})
	desk := startDesk(t, fx)
	btc := addBook(t, desk, "BTC-USDC", testParams())
	eth := addBook(t, desk, "ETH-USDC", testParams())
	tick(desk, "BTC-USD", "50000")
	tick(desk, "ETH-USD", "3000")
	btc.SetEnabled(true)
	eth.SetEnabled(true)
	waitFor(t, "both books quoting", func() bool { return fx.resting("") == 12 && settled(btc) && settled(eth) })

	btc.mu.Lock()
	for range 5 {
		btc.rateLimitedLocked("Rate limit exceeded")
	}
	btc.mu.Unlock()
	waitFor(t, "both books paused", func() bool {
		return strings.HasPrefix(btc.Status().Reason, "rate limited") && strings.HasPrefix(eth.Status().Reason, "rate limited")
	})
	n := 0
	for _, ev := range btc.Status().Events {
		if strings.Contains(ev.Message, "every book pauses") {
			n++
		}
	}
	if st := btc.Status().Stats; n != 1 || st.RateLimited != 5 || st.RateLimitPauses != 1 {
		t.Fatalf("%d pause events, %d refused, %d pauses", n, st.RateLimited, st.RateLimitPauses)
	}
	ds := desk.Status()
	if tot := ds.Totals[0].Stats; tot.RateLimited != 5 || tot.RateLimitPauses != 1 {
		t.Fatalf("totals %+v", tot)
	}
	if ds.RateLimit.PausedForMs <= 0 || ds.RateLimit.LastAt == nil {
		t.Fatalf("desk rate limit %+v", ds.RateLimit)
	}
	if fx.resting("") != 12 {
		t.Fatal("pulled quotes while rate limited")
	}

	// Resetting one book clears its counts only; resetting all clears the rest and the last hit.
	eth.mu.Lock()
	eth.stats.Rejects, eth.stats.RateLimited = 2, 2
	eth.mu.Unlock()
	if err := desk.ResetRejects("BTC-USDC"); err != nil {
		t.Fatal(err)
	}
	if st := btc.Status().Stats; st.RateLimited != 0 || st.RateLimitPauses != 0 || st.Rejects != 0 || eth.Status().Stats.RateLimited != 2 {
		t.Fatalf("one-book reset: btc %+v eth %+v", st, eth.Status().Stats)
	}
	if desk.Status().RateLimit.LastAt == nil {
		t.Fatal("a one-book reset forgot the last hit")
	}
	if err := desk.ResetRejects(""); err != nil {
		t.Fatal(err)
	}
	if st := eth.Status().Stats; st.RateLimited != 0 || st.Rejects != 0 || desk.Status().RateLimit.LastAt != nil {
		t.Fatalf("all-books reset: eth %+v", st)
	}
	if err := desk.ResetRejects("NOPE-USDC"); err == nil {
		t.Fatal("reset an unknown book")
	}
	before := fx.counts()["modify"]
	tick(desk, "BTC-USD", "50100")
	time.Sleep(300 * time.Millisecond)
	if fx.counts()["modify"] != before {
		t.Fatal("sent during the pause")
	}
	waitFor(t, "requotes after the pause", func() bool { return fx.counts()["modify"] > before })
}
