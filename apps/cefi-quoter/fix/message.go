// Package fix is a small FIX 5.0 SP2 (FIXT.1.1) order-entry client for the True Markets CeFi
// exchange. It is deliberately minimal: it sends NewOrderSingle, OrderCancelReplaceRequest and
// OrderCancelRequest and reads back what the session needs. Order state comes from the WebSocket
// drop copy, exactly as it does for REST, so nothing here has to track orders.
//
// Every logon resets sequence numbers (141=Y), so there is no message store to manage: a
// restart starts at 1. When the exchange asks for a resend, we gap-fill rather than replay old
// orders, because an order we sent a minute ago should never be re-sent.
package fix

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"time"
)

const soh = '\x01'

// Field is one tag=value pair. Order matters in FIX, so messages are slices, not maps.
type Field struct {
	Tag   int
	Value string
}

// Message is a parsed inbound message. Get returns the first value for a tag, which is all this
// client needs (it never reads inside repeating groups).
type Message struct {
	Type   string
	Fields []Field
}

func (m Message) Get(tag int) string {
	for _, f := range m.Fields {
		if f.Tag == tag {
			return f.Value
		}
	}
	return ""
}

// String renders the message with | for SOH, for logs.
func (m Message) String() string {
	var b bytes.Buffer
	for i, f := range m.Fields {
		if i > 0 {
			b.WriteByte('|')
		}
		fmt.Fprintf(&b, "%d=%s", f.Tag, f.Value)
	}
	return b.String()
}

// SendingTime is the FIX UTC timestamp format with milliseconds.
func SendingTime(t time.Time) string { return t.UTC().Format("20060102-15:04:05.000") }

// encode builds the full wire message: BeginString, BodyLength, the body (which starts with
// MsgType and the rest of the header), and CheckSum.
func encode(body []Field) []byte {
	var b bytes.Buffer
	for _, f := range body {
		b.WriteString(strconv.Itoa(f.Tag))
		b.WriteByte('=')
		b.WriteString(f.Value)
		b.WriteByte(soh)
	}
	var out bytes.Buffer
	out.WriteString("8=FIXT.1.1\x01")
	out.WriteString("9=" + strconv.Itoa(b.Len()) + "\x01")
	out.Write(b.Bytes())
	sum := 0
	for _, c := range out.Bytes() {
		sum += int(c)
	}
	out.WriteString(fmt.Sprintf("10=%03d\x01", sum%256))
	return out.Bytes()
}

// read reads one message: BeginString, then BodyLength, then exactly that many bytes, then the
// 7-byte CheckSum field.
func read(r *bufio.Reader) (Message, error) {
	begin, err := r.ReadString(soh)
	if err != nil {
		return Message{}, err
	}
	if len(begin) < 3 || begin[:2] != "8=" {
		return Message{}, fmt.Errorf("expected BeginString, got %q", begin)
	}
	lenField, err := r.ReadString(soh)
	if err != nil {
		return Message{}, err
	}
	if len(lenField) < 3 || lenField[:2] != "9=" {
		return Message{}, fmt.Errorf("expected BodyLength, got %q", lenField)
	}
	n, err := strconv.Atoi(lenField[2 : len(lenField)-1])
	if err != nil || n <= 0 || n > 1<<20 {
		return Message{}, fmt.Errorf("bad BodyLength %q", lenField)
	}
	body := make([]byte, n+7) // body + "10=NNN\x01"
	if _, err := io.ReadFull(r, body); err != nil {
		return Message{}, err
	}
	var msg Message
	for _, part := range bytes.Split(body[:n], []byte{soh}) {
		if len(part) == 0 {
			continue
		}
		eq := bytes.IndexByte(part, '=')
		if eq <= 0 {
			return Message{}, fmt.Errorf("bad field %q", part)
		}
		tag, err := strconv.Atoi(string(part[:eq]))
		if err != nil {
			return Message{}, fmt.Errorf("bad tag %q", part)
		}
		msg.Fields = append(msg.Fields, Field{tag, string(part[eq+1:])})
	}
	msg.Type = msg.Get(35)
	return msg, nil
}
