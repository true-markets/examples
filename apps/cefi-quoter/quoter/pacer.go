package quoter

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Pacer keeps every book's order requests inside the exchange's rate limits. The desk has one,
// because the limits are per account, not per book.
//
// The exchange's order checks (celeritas trading/common/risk/order_rate_limiter.hpp) hold each
// account to a number of orders per second and a number per minute. Each is a fixed window that
// opens on the first request after the last one ran out. New orders and modifies count; cancels
// never do and are never refused for the rate. A request the per-minute limit refuses doesn't count
// toward it, so once the minute is spent everything is refused until that window ends, up to a
// minute later.
//
// So the pacer:
//   - Counts creates, modifies and takes, and lets cancels through untouched (Take is only called
//     for the counted kinds).
//   - Holds them to perSec in any one second and perMin in any one minute, counted back from now.
//     A rolling window never holds more than a fixed window of the same length can, so staying
//     under it keeps the exchange's count under too, however its windows line up. A book that
//     finds a window full stops sending for this cycle and plans again on the next one, with fresh
//     prices, rather than queueing requests that would be stale by the time they went out.
//   - Pauses on a rate-limit reject anyway: every book stops sending new orders and modifies for
//     a second, doubling up to 30s while the rejects continue (the exchange's minute can take that
//     long to run out). Rejects from requests already on the wire land during the pause and don't
//     extend it.
type Pacer struct {
	mu          sync.Mutex
	sec, min    window
	peaks       [60]peak // the busiest second-long stretch ending in each of the last 60 seconds
	pausedUntil time.Time
	pause       time.Duration
	lastLimited time.Time
	now         func() time.Time
}

// window is the requests sent in the last span, oldest first, and how many it may hold (0 for no
// limit: still counted, for the usage report).
type window struct {
	limit int
	span  time.Duration
	sent  []time.Time
}

func (w *window) trim(now time.Time) {
	i := 0
	for i < len(w.sent) && now.Sub(w.sent[i]) >= w.span {
		i++
	}
	w.sent = w.sent[i:]
}

func (w *window) full() bool { return w.limit > 0 && len(w.sent) >= w.limit }

type peak struct {
	sec int64 // unix second
	n   int
}

// RateLimitStatus is the pacer, for the management API.
type RateLimitStatus struct {
	PerSec int `json:"perSec"` // 0: no limit of our own
	PerMin int `json:"perMin"` // 0: no limit of our own
	// Used is the orders and modifies sent in the last second, UsedMin in the last minute; Peak is
	// the most in any second over the last minute. Cancels aren't counted, as the exchange doesn't.
	Used        int        `json:"used"`
	UsedMin     int        `json:"usedMin"`
	Peak        int        `json:"peak"`
	PausedForMs int64      `json:"pausedForMs"`
	LastAt      *time.Time `json:"lastAt"` // the last rate-limit reject this run
}

func (p *Pacer) Status() RateLimitStatus {
	if p == nil {
		return RateLimitStatus{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	p.sec.trim(now)
	p.min.trim(now)
	s := RateLimitStatus{
		PerSec: p.sec.limit, PerMin: p.min.limit, Used: len(p.sec.sent), UsedMin: len(p.min.sent),
		PausedForMs: max(0, p.pausedUntil.Sub(now).Milliseconds()),
	}
	for _, pk := range p.peaks {
		if now.Unix()-pk.sec < 60 {
			s.Peak = max(s.Peak, pk.n)
		}
	}
	if !p.lastLimited.IsZero() {
		t := p.lastLimited
		s.LastAt = &t
	}
	return s
}

const (
	pauseMin = time.Second
	pauseMax = 30 * time.Second
)

// NewPacer allows perSec orders and modifies in any second and perMin in any minute. 0 turns that
// limit off; with both off only the pause on rate-limit rejects is left.
func NewPacer(perSec, perMin int) *Pacer {
	return &Pacer{
		now: time.Now,
		sec: window{limit: max(0, perSec), span: time.Second},
		min: window{limit: max(0, perMin), span: time.Minute},
	}
}

// SetLimits changes the limits from now on. What was already sent still counts against them.
func (p *Pacer) SetLimits(perSec, perMin int) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sec.limit, p.min.limit = max(0, perSec), max(0, perMin)
}

// Take spends one new order, modify or take. False means don't send it now. Cancels don't call it:
// the exchange neither counts nor refuses them.
func (p *Pacer) Take() bool {
	if p == nil {
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	if now.Before(p.pausedUntil) {
		return false
	}
	p.sec.trim(now)
	p.min.trim(now)
	if p.sec.full() || p.min.full() {
		return false
	}
	p.sec.sent = append(p.sec.sent, now)
	p.min.sent = append(p.min.sent, now)
	pk := &p.peaks[now.Unix()%60]
	if pk.sec != now.Unix() {
		*pk = peak{sec: now.Unix()}
	}
	pk.n = max(pk.n, len(p.sec.sent))
	return true
}

// Limited records a rate-limit reject from the exchange. It returns the pause it started, or 0
// when one was already running.
func (p *Pacer) Limited() time.Duration {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	p.lastLimited = now
	if now.Before(p.pausedUntil) {
		return 0
	}
	if p.pause == 0 || now.Sub(p.pausedUntil) > pauseMax {
		p.pause = pauseMin
	} else {
		p.pause = min(2*p.pause, pauseMax)
	}
	p.pausedUntil = now.Add(p.pause)
	return p.pause
}

// Forget clears when the limit was last hit, for a reset of the counts. A pause still running, and
// the backoff, are left alone: they're about the exchange, not the display.
func (p *Pacer) Forget() {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.lastLimited = time.Time{}
	p.mu.Unlock()
}

// PausedFor is how long the pause has left (0 when not paused).
func (p *Pacer) PausedFor() time.Duration {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return max(0, p.pausedUntil.Sub(p.now()))
}

// isRateLimitReject reports a reject that names the exchange's rate limit ("Rate limit exceeded"
// on FIX and the drop copy).
func isRateLimitReject(text string) bool {
	t := strings.ToLower(text)
	return strings.Contains(t, "rate limit") || strings.Contains(t, "too many requests")
}

// isRateLimitErr reports a request refused for the rate limit: a 429 over REST, or REST still
// waiting out the last 429's window.
func isRateLimitErr(err error) bool {
	var apiErr *tm.APIError
	return errors.Is(err, tm.ErrRateLimited) || (errors.As(err, &apiErr) && apiErr.Status == http.StatusTooManyRequests) || isRateLimitReject(err.Error())
}
