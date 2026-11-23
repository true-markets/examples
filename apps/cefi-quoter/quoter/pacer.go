package quoter

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Pacer keeps every book's order requests (creates, modifies, cancels, takes) inside the
// exchange's rate limit. The desk has one, because the limit is per account, not per book.
//
// Two parts:
//   - A rolling window: no more than limit requests in any one second, counted back from now. (A
//     token bucket would average the limit but let a burst through on top of it, and the
//     exchange counts the burst.) A book that finds the window full stops sending for this cycle
//     and plans again on the next one, with fresh prices, rather than queueing requests that
//     would be stale by the time they went out.
//   - A pause: when the exchange rejects a request for its rate limit anyway, every book stops
//     sending for a second. Another rate-limit reject within 30s of the last pause doubles it,
//     up to 30s. Rejects from requests already on the wire land during the pause and don't
//     extend it.
type Pacer struct {
	mu          sync.Mutex
	limit       int         // requests in any one second; 0 for no window
	sent        []time.Time // when the last limit requests went out, oldest first
	pausedUntil time.Time
	pause       time.Duration
	lastLimited time.Time
	now         func() time.Time
}

// RateLimitStatus is the pacer, for the management API.
type RateLimitStatus struct {
	PerSec      int        `json:"perSec"` // 0: no limit of our own
	PausedForMs int64      `json:"pausedForMs"`
	LastAt      *time.Time `json:"lastAt"` // the last rate-limit reject this run
}

func (p *Pacer) Status() RateLimitStatus {
	if p == nil {
		return RateLimitStatus{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	s := RateLimitStatus{PerSec: p.limit, PausedForMs: max(0, p.pausedUntil.Sub(p.now()).Milliseconds())}
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

// NewPacer allows perSec requests a second. 0 or less leaves only the pause on rate-limit rejects.
func NewPacer(perSec int) *Pacer {
	return &Pacer{now: time.Now, limit: max(0, perSec)}
}

// Take spends one request. False means don't send it now.
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
	if p.limit == 0 {
		return true
	}
	if len(p.sent) == p.limit {
		if now.Sub(p.sent[0]) < time.Second {
			return false
		}
		p.sent = p.sent[1:]
	}
	p.sent = append(p.sent, now)
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
