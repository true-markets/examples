package quoter

import (
	"encoding/json"
	"reflect"
)

// Settings are the quoter-wide knobs: everything that isn't one book's. Like Params, each can be
// changed while the quoter runs, from the management API, and is saved in the books file. Values
// saved there win over the environment, which only sets them the first time.
type Settings struct {
	OrderRate       int `json:"orderRateLimit" param:"Orders per second|/s|Most new orders and modifies in any one second, across every book. Cancels don't count, as the exchange doesn't count them. Set it a little under the exchange's limit. 0 means no limit of our own; a rate-limit reject still pauses sending|0|100000"`
	OrderRatePerMin int `json:"orderRateLimitPerMin" param:"Orders per minute|/min|Most new orders and modifies in any one minute, across every book. 0 means no limit of our own|0|10000000"`
}

// SettingsSchema lists every quoter-wide setting, in declaration order.
func SettingsSchema() []ParamSpec { return schemaOf(reflect.TypeFor[Settings]()) }

// Validate checks every value against its schema bounds.
func (s Settings) Validate() error { return validateFields(reflect.ValueOf(s), SettingsSchema()) }

// Merge applies a partial JSON update (only the keys present change) and validates the result.
func (s Settings) Merge(patch []byte) (Settings, error) {
	if err := checkKeys(patch, SettingsSchema()); err != nil {
		return s, err
	}
	next := s
	if err := json.Unmarshal(patch, &next); err != nil {
		return s, err
	}
	if err := next.Validate(); err != nil {
		return s, err
	}
	return next, nil
}
