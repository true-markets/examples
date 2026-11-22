package fix

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestEncodeFraming(t *testing.T) {
	raw := encode([]Field{{35, "0"}, {49, "ME"}, {56, "TRUEX"}, {34, "2"}, {52, "20260101-00:00:00.000"}})
	s := string(raw)
	if !strings.HasPrefix(s, "8=FIXT.1.1\x019=") {
		t.Fatalf("header: %q", s)
	}
	// BodyLength counts from after the 9= field up to (not including) 10=.
	start := strings.Index(s, "\x0135=") + 1
	end := strings.Index(s, "10=")
	n, _ := strconv.Atoi(s[strings.Index(s, "9=")+2 : start-1])
	if n != end-start {
		t.Fatalf("BodyLength %d, actual %d", n, end-start)
	}
	sum := 0
	for _, c := range raw[:end] {
		sum += int(c)
	}
	if want := "10=" + leftPad(sum%256) + "\x01"; s[end:] != want {
		t.Fatalf("checksum %q, want %q", s[end:], want)
	}
	msg, err := read(bufio.NewReader(bytes.NewReader(raw)))
	if err != nil || msg.Type != "0" || msg.Get(49) != "ME" {
		t.Fatalf("round trip: %v %+v", err, msg)
	}
}

func leftPad(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

type fakeSigner struct{ signed []string }

func (f *fakeSigner) Sign(m string) string { f.signed = append(f.signed, m); return "SIG" }

// A fake exchange: accepts the Logon, then records what the client sends.
func TestSessionLogonOrdersAndResend(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan Message, 32)
	serverConn := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		serverConn <- c
		r := bufio.NewReader(c)
		for {
			m, err := read(r)
			if err != nil {
				return
			}
			got <- m
			if m.Type == "A" {
				c.Write(encode([]Field{{35, "A"}, {49, "TRUEX"}, {56, "ME"}, {34, "1"}, {52, SendingTime(time.Now())}, {98, "0"}, {108, "30"}}))
			}
		}
	}()

	signer := &fakeSigner{}
	s := NewSession(Config{
		Addr: ln.Addr().String(), SenderCompID: "ME", TargetCompID: "TRUEX", KeyID: "kid",
		Signer: signer, ClientID: "42", HeartBtInt: 30, CancelOnDisconnect: true,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	if err := s.WaitLogon(ctx, 3*time.Second); err != nil {
		t.Fatal(err)
	}

	logon := <-got
	if logon.Get(553) != "kid" || logon.Get(554) != "SIG" || logon.Get(141) != "Y" || logon.Get(1137) != "9" || logon.Get(58) != "CancelOnDisconnect=Y" {
		t.Fatalf("logon fields: %s", logon)
	}
	// Signed string: SendingTime + MsgType + MsgSeqNum + SenderCompID + TargetCompID + Username.
	if want := logon.Get(52) + "A1METRUEXkid"; signer.signed[0] != want {
		t.Fatalf("signed %q, want %q", signer.signed[0], want)
	}

	if err := s.NewOrder("cqabc", "BTC-USDC", "BUY", "100.5", "0.01", true); err != nil {
		t.Fatal(err)
	}
	d := <-got
	if d.Type != "D" || d.Get(11) != "cqabc" || d.Get(54) != "1" || d.Get(44) != "100.5" || d.Get(38) != "0.01" || d.Get(18) != "6" || d.Get(448) != "42" || d.Get(452) != "3" || d.Get(34) != "2" {
		t.Fatalf("NewOrderSingle: %s", d)
	}
	if err := s.Replace("cqdef", "cqabc", "101", "0.02"); err != nil {
		t.Fatal(err)
	}
	g := <-got
	if g.Type != "G" || g.Get(41) != "cqabc" || g.Get(40) != "" {
		t.Fatalf("replace: %s", g)
	}

	// The exchange asks for a resend of everything: we gap-fill instead of replaying orders.
	c := <-serverConn
	c.Write(encode([]Field{{35, "2"}, {49, "TRUEX"}, {56, "ME"}, {34, "2"}, {52, SendingTime(time.Now())}, {7, "1"}, {16, "0"}}))
	gf := <-got
	if gf.Type != "4" || gf.Get(123) != "Y" || gf.Get(36) != "4" || gf.Get(34) != "1" || gf.Get(43) != "Y" {
		t.Fatalf("gap fill: %s", gf)
	}

	// TestRequest gets a Heartbeat carrying its id.
	c.Write(encode([]Field{{35, "1"}, {49, "TRUEX"}, {56, "ME"}, {34, "3"}, {52, SendingTime(time.Now())}, {112, "ping"}}))
	hb := <-got
	if hb.Type != "0" || hb.Get(112) != "ping" {
		t.Fatalf("heartbeat: %s", hb)
	}

	// A cancel/replace reject reaches the callback.
	rejected := make(chan string, 1)
	s.OnCancelReject = func(cl, orig, to, text string) { rejected <- cl + "/" + to }
	c.Write(encode([]Field{{35, "9"}, {49, "TRUEX"}, {56, "ME"}, {34, "4"}, {52, SendingTime(time.Now())}, {11, "cqdef"}, {41, "cqabc"}, {434, "2"}, {58, "nope"}}))
	select {
	case r := <-rejected:
		if r != "cqdef/2" {
			t.Fatalf("reject callback got %q", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no cancel reject callback")
	}
}
