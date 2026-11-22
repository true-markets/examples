package quoter

import (
	"context"
	"errors"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/fix"
	"github.com/true-markets/examples/apps/cefi-quoter/tm"
)

// Transport sends order requests. REST and FIX implement it; the rest of the quoter can't tell
// them apart, because either way the answers come back on the WebSocket drop copy.
type Transport interface {
	Name() string
	Ready() bool
	Create(ctx context.Context, o *Order) (orderID string, err error)
	// Modify and Cancel get our root ExternalID (REST names the order by it) and the FIX
	// ClOrdIDs for this request and the one it replaces (FIX names the order by those).
	Modify(ctx context.Context, externalID, clOrdID, origClOrdID string, price, qty decimal.Decimal) error
	Cancel(ctx context.Context, externalID, clOrdID, origClOrdID string) error
}

// notSent reports an error that proves the exchange did not act on the request, so the request can
// be rolled back. Anything else (a timeout, a dropped connection) leaves the request pending until
// the drop copy, or a resync, says what happened.
func notSent(err error) bool {
	return tm.IsRejection(err) || errors.Is(err, tm.ErrRateLimited) || errors.Is(err, fix.ErrNotLoggedOn)
}

// RESTTransport sends one book's orders over the CeFi REST API.
type RESTTransport struct {
	REST         *tm.REST
	ClientID     string
	InstrumentID string
}

func (t *RESTTransport) Name() string { return "rest" }
func (t *RESTTransport) Ready() bool  { return true }

func (t *RESTTransport) Create(ctx context.Context, o *Order) (string, error) {
	return t.REST.CreateOrder(ctx, tm.NewOrder{
		ClientID:     t.ClientID,
		InstrumentID: t.InstrumentID,
		ExternalID:   o.ExternalID,
		Side:         string(o.Side),
		Price:        o.Price.String(),
		Qty:          o.Qty.String(),
		PostOnly:     true,
	})
}

func (t *RESTTransport) Modify(ctx context.Context, externalID, _, _ string, price, qty decimal.Decimal) error {
	return t.REST.ModifyOrder(ctx, t.ClientID, externalID, price.String(), qty.String())
}

func (t *RESTTransport) Cancel(ctx context.Context, externalID, _, _ string) error {
	return t.REST.CancelOrder(ctx, externalID)
}

// FIXTransport sends one book's orders over a FIX session that every book shares. Sends are fire
// and forget: success means the message left, and the drop copy says what the exchange did with
// it.
type FIXTransport struct {
	Session *fix.Session
	Symbol  string
}

func (t *FIXTransport) Name() string { return "fix" }
func (t *FIXTransport) Ready() bool  { return t.Session.LoggedOn() }

func (t *FIXTransport) Create(_ context.Context, o *Order) (string, error) {
	// The first ClOrdID is the external id, so the drop copy echoes it exactly as for REST.
	return "", t.Session.NewOrder(o.ExternalID, t.Symbol, string(o.Side), o.Price.String(), o.Qty.String(), true)
}

func (t *FIXTransport) Modify(_ context.Context, _, clOrdID, origClOrdID string, price, qty decimal.Decimal) error {
	return t.Session.Replace(clOrdID, origClOrdID, price.String(), qty.String())
}

func (t *FIXTransport) Cancel(_ context.Context, _, clOrdID, origClOrdID string) error {
	return t.Session.Cancel(clOrdID, origClOrdID)
}
