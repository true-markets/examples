package fix

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"
)

// Signer signs the Logon with your API key (tm.APIKey satisfies it).
type Signer interface {
	Sign(message string) string
}

type Config struct {
	Addr         string // host:port, from True Markets support
	TLS          bool
	SenderCompID string // yours to choose; a session stays bound to the key that first logged on
	TargetCompID string // assigned by the exchange
	KeyID        string // your API key's key_id, sent as Username (553)
	Signer       Signer
	ClientID     string // your CeFi client id, sent in the Parties group on every order
	HeartBtInt   int    // seconds
	// CancelOnDisconnect asks the exchange to cancel every order this session placed if the
	// connection drops. REST has no equivalent, which is one reason to quote over FIX.
	CancelOnDisconnect bool
}

// Session is one FIX order-entry session that reconnects until its context ends.
type Session struct {
	cfg Config
	log *slog.Logger

	// OnCancelReject is called for each OrderCancelReject (35=9). responseTo is "1" for a cancel
	// and "2" for a cancel/replace.
	OnCancelReject func(clOrdID, origClOrdID, responseTo, text string)
	// OnExecutionReport is called for each ExecutionReport (35=8).
	OnExecutionReport func(Message)
	OnState           func(up bool, reason string)

	mu       sync.Mutex
	conn     net.Conn
	loggedOn bool
	outSeq   int
	inSeq    int
	lastOut  time.Time
	lastIn   time.Time
	testSent bool
}

func NewSession(cfg Config, log *slog.Logger) *Session {
	if cfg.HeartBtInt <= 0 {
		cfg.HeartBtInt = 30
	}
	return &Session{cfg: cfg, log: log}
}

func (s *Session) LoggedOn() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loggedOn
}

// Run keeps the session up until ctx ends, then logs out.
func (s *Session) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := s.connect(ctx)
		s.mu.Lock()
		s.loggedOn = false
		s.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		if s.OnState != nil {
			s.OnState(false, err.Error())
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		s.log.Warn("FIX session down, reconnecting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// WaitLogon blocks until the first logon succeeds or the timeout passes.
func (s *Session) WaitLogon(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.LoggedOn() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return fmt.Errorf("FIX logon to %s timed out after %s", s.cfg.Addr, timeout)
}

func (s *Session) connect(ctx context.Context) error {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if s.cfg.TLS {
		conn, err = (&tls.Dialer{NetDialer: dialer}).DialContext(ctx, "tcp", s.cfg.Addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", s.cfg.Addr)
	}
	if err != nil {
		return err
	}
	defer conn.Close()

	s.mu.Lock()
	s.conn = conn
	s.outSeq = 1
	s.inSeq = 1
	s.lastIn = time.Now()
	s.testSent = false
	s.mu.Unlock()

	if err := s.sendLogon(); err != nil {
		return err
	}

	done := make(chan struct{})
	defer close(done)
	go s.keepAlive(ctx, conn, done)

	r := bufio.NewReader(conn)
	for {
		msg, err := read(r)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if err := s.handle(msg); err != nil {
			return err
		}
	}
}

// keepAlive sends a Heartbeat when we've been quiet for HeartBtInt, a TestRequest when the
// exchange has, and drops the connection if the TestRequest goes unanswered. On shutdown it
// sends Logout.
func (s *Session) keepAlive(ctx context.Context, conn net.Conn, done chan struct{}) {
	hb := time.Duration(s.cfg.HeartBtInt) * time.Second
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			_ = s.send("5", nil)
			// Give the exchange a moment to answer the Logout before the socket closes.
			time.Sleep(500 * time.Millisecond)
			conn.Close()
			return
		case <-t.C:
		}
		s.mu.Lock()
		quietOut, quietIn, testSent := time.Since(s.lastOut), time.Since(s.lastIn), s.testSent
		s.mu.Unlock()
		switch {
		case quietIn > hb*5/2:
			s.log.Warn("FIX: no reply to TestRequest, dropping the connection")
			conn.Close()
			return
		case quietIn > hb*3/2 && !testSent:
			s.mu.Lock()
			s.testSent = true
			s.mu.Unlock()
			_ = s.send("1", []Field{{112, strconv.FormatInt(time.Now().UnixMilli(), 10)}})
		case quietOut >= hb:
			_ = s.send("0", nil)
		}
	}
}

// sendLogon signs the Logon: an ES256 signature over SendingTime + MsgType + MsgSeqNum +
// SenderCompID + TargetCompID + Username, in Password (554), with key_id in Username (553).
func (s *Session) sendLogon() error {
	now := SendingTime(time.Now())
	signature := s.cfg.Signer.Sign(now + "A" + "1" + s.cfg.SenderCompID + s.cfg.TargetCompID + s.cfg.KeyID)
	cod := "N"
	if s.cfg.CancelOnDisconnect {
		cod = "Y"
	}
	return s.sendAt("A", 0, now, []Field{
		{98, "0"},                             // EncryptMethod: none
		{108, strconv.Itoa(s.cfg.HeartBtInt)}, // HeartBtInt
		{141, "Y"},                            // ResetSeqNumFlag: every logon starts at 1
		{553, s.cfg.KeyID},                    // Username
		{554, signature},                      // Password
		{58, "CancelOnDisconnect=" + cod},     // session options, space separated
		{1137, "9"},                           // DefaultApplVerID: FIX50SP2
	})
}

func (s *Session) handle(msg Message) error {
	s.mu.Lock()
	s.lastIn = time.Now()
	s.testSent = false
	seq, _ := strconv.Atoi(msg.Get(34))
	possDup := msg.Get(43) == "Y"
	expected := s.inSeq
	if seq >= expected {
		s.inSeq = seq + 1
	}
	s.mu.Unlock()

	if seq < expected && !possDup && msg.Type != "4" {
		return fmt.Errorf("MsgSeqNum %d lower than expected %d", seq, expected)
	}
	if seq > expected && msg.Type != "A" {
		// We don't ask for a resend: the drop copy, not FIX, is our record of order state.
		s.log.Warn("FIX: inbound sequence gap", "expected", expected, "got", seq)
	}

	switch msg.Type {
	case "A": // Logon accepted
		s.mu.Lock()
		s.loggedOn = true
		s.mu.Unlock()
		s.log.Info("FIX logon", "sender", s.cfg.SenderCompID, "target", s.cfg.TargetCompID)
		if s.OnState != nil {
			s.OnState(true, "")
		}
	case "0": // Heartbeat
	case "1": // TestRequest: answer with its TestReqID
		return s.send("0", []Field{{112, msg.Get(112)}})
	case "2": // ResendRequest: gap-fill everything; never replay an old order
		begin, _ := strconv.Atoi(msg.Get(7))
		return s.gapFill(begin)
	case "3": // Reject
		s.log.Warn("FIX session reject", "refSeq", msg.Get(45), "tag", msg.Get(371), "reason", msg.Get(373), "text", msg.Get(58))
	case "4": // SequenceReset
		if next, err := strconv.Atoi(msg.Get(36)); err == nil {
			s.mu.Lock()
			s.inSeq = next
			s.mu.Unlock()
		}
	case "5": // Logout
		text := msg.Get(58)
		s.mu.Lock()
		wasOn := s.loggedOn
		s.loggedOn = false
		s.mu.Unlock()
		if wasOn {
			_ = s.send("5", nil)
		}
		return errors.New("logged out by the exchange: " + text)
	case "8":
		if s.OnExecutionReport != nil {
			s.OnExecutionReport(msg)
		}
	case "9":
		if s.OnCancelReject != nil {
			s.OnCancelReject(msg.Get(11), msg.Get(41), msg.Get(434), msg.Get(58))
		}
	case "j": // BusinessMessageReject
		s.log.Warn("FIX business reject", "refType", msg.Get(372), "reason", msg.Get(380), "text", msg.Get(58))
	}
	return nil
}

// --- order entry --------------------------------------------------------------------------

func (s *Session) parties() []Field {
	// Exactly one party: our CeFi client id, PartyRole 3 (Client ID).
	return []Field{{453, "1"}, {448, s.cfg.ClientID}, {452, "3"}}
}

// NewOrder sends a GTC limit NewOrderSingle (35=D) on symbol (as the exchange names it, e.g.
// BTC-USDC). postOnly adds ExecInst 6 (Add Liquidity Only).
func (s *Session) NewOrder(clOrdID, symbol, side, price, qty string, postOnly bool) error {
	fields := []Field{
		{11, clOrdID},
		{55, symbol},
		{54, sideCode(side)},
		{38, qty},
		{40, "2"}, // Limit
		{44, price},
		{59, "1"}, // GTC
	}
	if postOnly {
		fields = append(fields, Field{18, "6"})
	}
	return s.send("D", append(fields, s.parties()...))
}

// Replace sends an OrderCancelReplaceRequest (35=G): a new ClOrdID pointing back at the order's
// current one. qty is the order's new total.
func (s *Session) Replace(clOrdID, origClOrdID, price, qty string) error {
	fields := []Field{{11, clOrdID}, {41, origClOrdID}, {38, qty}, {44, price}}
	return s.send("G", append(fields, s.parties()...))
}

// Cancel sends an OrderCancelRequest (35=F).
func (s *Session) Cancel(clOrdID, origClOrdID string) error {
	fields := []Field{{11, clOrdID}, {41, origClOrdID}}
	return s.send("F", append(fields, s.parties()...))
}

func sideCode(side string) string {
	if side == "BUY" {
		return "1"
	}
	return "2"
}

// --- sending ------------------------------------------------------------------------------

var ErrNotLoggedOn = errors.New("FIX session not logged on")

func (s *Session) send(msgType string, body []Field) error {
	if msgType != "A" && msgType != "5" && !s.LoggedOn() {
		return ErrNotLoggedOn
	}
	return s.sendAt(msgType, 0, SendingTime(time.Now()), body)
}

// sendAt writes a message. seq 0 means "the next sequence number"; a gap fill passes its own.
func (s *Session) sendAt(msgType string, seq int, sendingTime string, body []Field) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return ErrNotLoggedOn
	}
	useSeq := seq
	if seq == 0 {
		useSeq = s.outSeq
	}
	header := []Field{
		{35, msgType},
		{49, s.cfg.SenderCompID},
		{56, s.cfg.TargetCompID},
		{34, strconv.Itoa(useSeq)},
		{52, sendingTime},
	}
	if seq != 0 {
		header = append(header, Field{43, "Y"}, Field{122, sendingTime})
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := s.conn.Write(encode(append(header, body...))); err != nil {
		return err
	}
	if seq == 0 {
		s.outSeq++
	}
	s.lastOut = time.Now()
	return nil
}

// gapFill answers a ResendRequest with one SequenceReset-GapFill covering everything from begin.
func (s *Session) gapFill(begin int) error {
	s.mu.Lock()
	next := s.outSeq
	s.mu.Unlock()
	if begin <= 0 || begin >= next {
		return nil
	}
	return s.sendAt("4", begin, SendingTime(time.Now()), []Field{{123, "Y"}, {36, strconv.Itoa(next)}})
}
