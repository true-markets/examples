package quoter

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"

	"github.com/shopspring/decimal"
)

// Params are the strategy's knobs. Every one can be changed while the quoter runs, from the
// management API (and the console's Quoter screen); a change takes effect on the next cycle.
// Start-up values come from the environment (see config.go).
//
// The `param` tags describe each knob for the management API's schema, so a new field shows up
// in the console's form without touching the console.
type Params struct {
	SizeUnit           string          `json:"sizeUnit" param:"Sizes in||Whether quote size, max position change and max base to use are in the base asset (0.01 BTC) or the quote currency (500 USDC, converted at the reference price every cycle, so a size in dollars stays the same as the price moves)|base,quote|"`
	SpreadBps          float64         `json:"spreadBps" param:"Spread|bps|Distance from the mid to the first bid and the first ask, each side|0.1|10000"`
	Levels             int             `json:"levels" param:"Levels||Orders per side|1|10"`
	LevelSpreadMult    float64         `json:"levelSpreadMult" param:"Level spread multiplier|x|Each level further out is this many times the spread of the one inside it|1|10"`
	QuoteSize          decimal.Decimal `json:"quoteSize" param:"Quote size|size|Size of the first level|0|"`
	LevelSizeMult      float64         `json:"levelSizeMult" param:"Level size multiplier|x|Each level further out is this many times the size of the one inside it|0.1|10"`
	ModifyThresholdBps float64         `json:"modifyThresholdBps" param:"Modify threshold|bps|Leave an order alone until its target price moves at least this far. Lower is tighter tracking, higher is fewer modifies|0|1000"`
	MaxPosition        decimal.Decimal `json:"maxPosition" param:"Max position change|size|How far this book may move your holdings from where they were when it started counting: what it has bought minus what it has sold since then, long or short. A side stops quoting at the limit. The count carries across restarts and starts again from 0 when you reset the book's position. 0 turns the limit and skew off|0|"`
	SkewBps            float64         `json:"skewBps" param:"Inventory skew|bps|How far to shift the mid toward getting flat when the position is at its limit (scaled in between)|0|1000"`
	MaxQuoteAlloc      decimal.Decimal `json:"maxQuoteAlloc" param:"Max quote to use|quote|Most of the quote currency the bids may hold at once. 0 means all of the free balance|0|"`
	MaxBaseAlloc       decimal.Decimal `json:"maxBaseAlloc" param:"Max base to use|size|Most of the base asset the asks may hold at once. 0 means all of the free balance|0|"`
	RefStaleMs         int             `json:"refStaleMs" param:"Reference stale after|ms|Pull every quote if the reference price is older than this|500|60000"`
	MaxRefGapBps       float64         `json:"maxRefGapBps" param:"Reference guard|bps|Stop quoting while other people's orders on this book sit this far past the reference: a bid this far above it, or an ask this far below. That is more likely a corporate action or multiplier the reference hasn't caught, or a bad reference, than an opportunity. 0 turns it off|0|5000"`
	BandRejectLimit    int             `json:"bandRejectLimit" param:"Band reject limit||Stop the book and pull its quotes after this many orders rejected for the exchange's price band within a minute. The band sits around the exchange's own reference price, so repeated band rejects mean it and your reference disagree. Start the book again once they agree. 0 turns it off|0|1000"`
	MinRequoteMs       int             `json:"minRequoteMs" param:"Min requote interval|ms|Smallest gap between two rounds of order changes|0|10000"`

	// Taking: crossing the spread with an IOC instead of waiting to be filled. See taker.go.
	ProfitTaker         bool            `json:"profitTaker" param:"Profit taker||Cross the spread to close inventory when the exchange's book pays enough over the skewed mid, and only above what the position cost. The edge it needs falls toward the flatten floor as the position nears the max position change, so a full book gets out more readily||"`
	Takeout             bool            `json:"takeout" param:"Takeout||Cross the spread to build inventory when the exchange's book sits at least the take edge past fair value. Opportunistic: it bets the dislocation closes. Off unless you turn it on||"`
	TakeEdgeBps         float64         `json:"takeEdgeBps" param:"Take edge|bps|Net edge over the skewed mid, after the taker fee, that a take needs. Takeout needs more as the position grows|0|10000"`
	TakeFlattenFloorBps float64         `json:"takeFlattenFloorBps" param:"Flatten floor|bps|The least net edge a profit take accepts, reached at the max position change|0|10000"`
	TakeMaxSize         decimal.Decimal `json:"takeMaxSize" param:"Max take size|size|Largest single take|0|"`
	TakeCoolDownMs      int             `json:"takeCoolDownMs" param:"Take cool-down|ms|Least time between two takes on this book, so one move isn't chased over and over|0|600000"`
	TakerFeeBps         float64         `json:"takerFeeBps" param:"Taker fee|bps|What the exchange charges you to take. Every take edge is counted after it. The published CeFi schedule is 0|0|1000"`
}

// Size units. Quote size, max position change and max base to use are in one or the other.
const (
	SizeInBase  = "base"
	SizeInQuote = "quote"
)

// InBase returns the parameters with every size in the base asset, converting from the quote
// currency at this reference price if the book is set to quote sizes. Everything that sizes
// orders works on the result, so the rest of the quoter only ever sees base units.
func (p Params) InBase(price decimal.Decimal) Params {
	if p.SizeUnit != SizeInQuote {
		return p
	}
	if !price.IsPositive() {
		// No price, no conversion: size nothing rather than misread dollars as coins.
		p.QuoteSize, p.MaxPosition, p.MaxBaseAlloc, p.TakeMaxSize = decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
		return p
	}
	p.QuoteSize = p.QuoteSize.Div(price)
	p.MaxPosition = p.MaxPosition.Div(price)
	p.MaxBaseAlloc = p.MaxBaseAlloc.Div(price)
	p.TakeMaxSize = p.TakeMaxSize.Div(price)
	p.SizeUnit = SizeInBase
	return p
}

// ParamSpec describes one parameter for a UI.
type ParamSpec struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"` // number, integer, decimal (decimals travel as strings) or choice
	// Unit is a fixed unit (bps, ms, x), "quote" for the quote currency, or "size" for a size
	// in whichever unit sizeUnit chooses.
	Unit    string   `json:"unit,omitempty"`
	Options []string `json:"options,omitempty"` // choice only
	Help    string   `json:"help"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
}

// Schema lists every parameter, in declaration order.
func Schema() []ParamSpec {
	var out []ParamSpec
	t := reflect.TypeFor[Params]()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		parts := strings.Split(f.Tag.Get("param"), "|")
		spec := ParamSpec{Key: strings.Split(f.Tag.Get("json"), ",")[0], Label: parts[0], Unit: parts[1], Help: parts[2]}
		switch f.Type.Kind() {
		case reflect.Int:
			spec.Type = "integer"
		case reflect.Float64:
			spec.Type = "number"
		case reflect.Bool:
			spec.Type = "boolean"
			out = append(out, spec)
			continue
		case reflect.String:
			spec.Type = "choice"
			spec.Options = strings.Split(parts[3], ",")
			out = append(out, spec)
			continue
		default:
			spec.Type = "decimal"
		}
		spec.Min = parseBound(parts[3])
		spec.Max = parseBound(parts[4])
		out = append(out, spec)
	}
	return out
}

func parseBound(s string) *float64 {
	var v float64
	if _, err := fmt.Sscan(s, &v); err != nil {
		return nil
	}
	return &v
}

// Validate checks every value against its schema bounds and the few rules that span fields.
func (p Params) Validate() error {
	v := reflect.ValueOf(p)
	for i, spec := range Schema() {
		f := v.Field(i)
		var x float64
		switch spec.Type {
		case "boolean":
			continue
		case "choice":
			if !slices.Contains(spec.Options, f.String()) {
				return fmt.Errorf("%s must be one of %s", spec.Key, strings.Join(spec.Options, ", "))
			}
			continue
		case "integer":
			x = float64(f.Int())
		case "number":
			x = f.Float()
			if math.IsNaN(x) || math.IsInf(x, 0) {
				return fmt.Errorf("%s must be a number", spec.Key)
			}
		default:
			x = f.Interface().(decimal.Decimal).InexactFloat64()
		}
		if spec.Min != nil && x < *spec.Min {
			return fmt.Errorf("%s must be at least %v", spec.Key, *spec.Min)
		}
		if spec.Max != nil && x > *spec.Max {
			return fmt.Errorf("%s must be at most %v", spec.Key, *spec.Max)
		}
	}
	if !p.QuoteSize.IsPositive() {
		return fmt.Errorf("quoteSize must be more than 0")
	}
	return nil
}

// Merge applies a partial JSON update (only the keys present change) and validates the result.
func (p Params) Merge(patch []byte) (Params, error) {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(patch, &keys); err != nil {
		return p, fmt.Errorf("expected a JSON object: %w", err)
	}
	known := map[string]bool{}
	for _, s := range Schema() {
		known[s.Key] = true
	}
	for k := range keys {
		if !known[k] {
			return p, fmt.Errorf("unknown parameter %q", k)
		}
	}
	next := p
	if err := json.Unmarshal(patch, &next); err != nil {
		return p, err
	}
	if err := next.Validate(); err != nil {
		return p, err
	}
	return next, nil
}

// IsUSD reports a dollar stablecoin (USDC, USDT, PYUSD, USDG, USD1, ...): every book's quote
// currency. Amounts in it are shown as USD, so nothing changes if the default stablecoin does.
func IsUSD(symbol string) bool {
	s := strings.ToUpper(symbol)
	return strings.HasPrefix(s, "USD") || strings.HasSuffix(s, "USD") || s == "DAI"
}

// QuoteUnit is how an amount in symbol is labeled: USD for any dollar stablecoin, else the symbol.
func QuoteUnit(symbol string) string {
	if IsUSD(symbol) {
		return "USD"
	}
	return symbol
}
