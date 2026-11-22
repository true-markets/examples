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
//   - A token bucket: rate requests a second on average, bursts up to twice that. A book that
//     finds it empty stops sending for this cycle and plans again on the next one, with fresh
//     prices, rather than queueing requests that would be stale by the time they went out.
//   - A pause: when the exchange rejects a request for its rate limit anyway, every book stops
//     sending for a second. Another rate-limit reject within 30s of the last pause doubles it,
//     up to 30s. Rejects from requests already on the wire land during the pause and don't
//     extend it.
type Pacer struct {
	mu          sync.Mutex
	rate        float64 // tokens a second; 0 for no bucket
	burst       float64
	tokens      float64
	filled      time.Time
	pausedUntil time.Time
	pause       time.Duration
	now         func() time.Time
}

const (
	pauseMin = time.Second
	pauseMax = 30 * time.Second
)

// NewPacer allows perSec requests a second. 0 or less leaves only the pause on rate-limit rejects.
func NewPacer(perSec int) *Pacer {
	p := &Pacer{now: time.Now}
	if perSec > 0 {
		p.rate = float64(perSec)
		p.burst = 2 * p.rate
		p.tokens = p.burst
	}
	return p
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
	if p.rate == 0 {
		return true
	}
	if !p.filled.IsZero() {
		p.tokens = min(p.burst, p.tokens+now.Sub(p.filled).Seconds()*p.rate)
	}
	p.filled = now
	if p.tokens < 1 {
		return false
	}
	p.tokens--
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
	if now.Before(p.pausedUntil) {
		return 0
	}
	if p.pause == 0 || now.Sub(p.pausedUntil) > pauseMax {
		p.pause = pauseMin
	} else {
		p.pause = min(2*p.pause, pauseMax)
	}
	p.pausedUntil = now.Add(p.pause)
	p.tokens = 0
	p.filled = p.pausedUntil
	return p.pause
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
