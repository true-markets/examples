package quoter

import (
	"io"
	"log/slog"
	"testing"
)

func TestUpdateSettingsChangesTheRateLimitsAndSaves(t *testing.T) {
	var saved Settings
	d := NewDesk(DeskConfig{
		OrderRate: 90, OrderRatePerMin: 1800, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Save: func(_ map[string]BookConfig, s Settings) error { saved = s; return nil },
	})
	got, err := d.UpdateSettings([]byte(`{"orderRateLimit": 20}`))
	if err != nil || got.OrderRate != 20 || got.OrderRatePerMin != 1800 {
		t.Fatalf("%+v %v", got, err)
	}
	if st := d.pacer.Status(); st.PerSec != 20 || st.PerMin != 1800 {
		t.Fatalf("pacer %+v", st)
	}
	if saved != got {
		t.Fatalf("saved %+v, want %+v", saved, got)
	}
	for _, bad := range []string{`{"orderRateLimit": -1}`, `{"nope": 1}`, `[]`} {
		if _, err := d.UpdateSettings([]byte(bad)); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
	if d.Settings().OrderRate != 20 {
		t.Fatal("a refused update changed the settings")
	}
}
