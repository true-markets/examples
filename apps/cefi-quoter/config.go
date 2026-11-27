package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/shopspring/decimal"
	"github.com/true-markets/examples/apps/cefi-quoter/paper"
	"github.com/true-markets/examples/apps/cefi-quoter/quoter"
)

// Config is everything set at start-up. It comes from the environment, and from a .env file next
// to the binary if there is one (real environment variables win). See .env.example.
type Config struct {
	Mode           string // live or paper
	KeyPath        string
	Environment    string // production or uat
	ClientID       string // optional; read from the token otherwise
	OrganizationID string // optional; organization keys only
	BooksFile      string // which books to quote and their settings; the management API keeps it
	StateFile      string // position, PnL, activity and trades, carried across restarts
	AutoStart      bool   // start every saved book immediately instead of waiting for "start"
	IDPrefix       string

	Transport       string // rest or fix
	OrderRate       int    // most new orders and modifies in any second, across every book
	OrderRatePerMin int    // and in any minute
	FIX             FIXConfig

	AdminAddr  string
	AdminToken string
	LogLevel   string

	// Params are the settings a newly added book starts with.
	Params quoter.Params

	// Paper mode's starting balances, by asset. Every asset other than USDC is listed as a
	// book against USDC.
	PaperBalances map[string]decimal.Decimal
	// PaperMakerFeeBps and PaperTakerFeeBps are what the paper exchange charges on each fill.
	PaperMakerFeeBps decimal.Decimal
	PaperTakerFeeBps decimal.Decimal
}

type FIXConfig struct {
	Addr               string
	TLS                bool
	SenderCompID       string
	TargetCompID       string
	HeartBtInt         int
	CancelOnDisconnect bool
}

func loadConfig() (Config, error) {
	loadDotEnv(".env")
	var errs []string
	get := func(k, def string) string {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
		return def
	}
	getBool := func(k string, def bool) bool {
		v := get(k, strconv.FormatBool(def))
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s must be true or false, got %q", k, v))
		}
		return b
	}
	getInt := func(k string, def int) int {
		v := get(k, strconv.Itoa(def))
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s must be a whole number, got %q", k, v))
		}
		return n
	}
	getFloat := func(k string, def float64) float64 {
		v := get(k, strconv.FormatFloat(def, 'f', -1, 64))
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s must be a number, got %q", k, v))
		}
		return f
	}
	getDec := func(k, def string) decimal.Decimal {
		v := get(k, def)
		d, err := decimal.NewFromString(v)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s must be a decimal number, got %q", k, v))
		}
		return d
	}

	c := Config{
		KeyPath:         get("TM_API_KEY_PATH", ".secrets"),
		Environment:     get("TM_ENV", "production"),
		ClientID:        get("TM_CLIENT_ID", ""),
		OrganizationID:  get("TM_ORGANIZATION_ID", ""),
		BooksFile:       get("QUOTER_BOOKS_FILE", "books.json"),
		AutoStart:       getBool("QUOTER_AUTOSTART", false),
		IDPrefix:        get("QUOTER_ID_PREFIX", "cq"),
		Transport:       get("ORDER_TRANSPORT", "rest"),
		OrderRate:       getInt("ORDER_RATE_LIMIT", 90),
		OrderRatePerMin: getInt("ORDER_RATE_LIMIT_PER_MIN", 1800),
		AdminAddr:       get("ADMIN_ADDR", "127.0.0.1:4860"),
		AdminToken:      get("ADMIN_TOKEN", ""),
		LogLevel:        get("LOG_LEVEL", "info"),
		Params: quoter.Params{
			SizeUnit:            get("SIZE_UNIT", quoter.SizeInQuote),
			SpreadBps:           getFloat("SPREAD_BPS", 10),
			Levels:              getInt("LEVELS", 3),
			LevelSpreadMult:     getFloat("LEVEL_SPREAD_MULT", 1.5),
			QuoteSize:           getDec("QUOTE_SIZE", "10"),
			LevelSizeMult:       getFloat("LEVEL_SIZE_MULT", 1),
			ModifyThresholdBps:  getFloat("MODIFY_THRESHOLD_BPS", 2),
			MaxPosition:         getDec("MAX_POSITION", "100"),
			SkewBps:             getFloat("SKEW_BPS", 5),
			MaxQuoteAlloc:       getDec("MAX_QUOTE_ALLOC", "0"),
			MaxBaseAlloc:        getDec("MAX_BASE_ALLOC", "0"),
			RefStaleMs:          getInt("REF_STALE_MS", 3000),
			MaxRefGapBps:        getFloat("REF_GUARD_BPS", 500),
			BandRejectLimit:     getInt("BAND_REJECT_LIMIT", 0),
			MinRequoteMs:        getInt("MIN_REQUOTE_MS", 100),
			ProfitTaker:         getBool("PROFIT_TAKER", true),
			Takeout:             getBool("TAKEOUT", false),
			TakeEdgeBps:         getFloat("TAKE_EDGE_BPS", 25),
			TakeFlattenFloorBps: getFloat("TAKE_FLATTEN_FLOOR_BPS", 2),
			TakeCoolDownMs:      getInt("TAKE_COOL_DOWN_MS", 3000),
			TakerFeeBps:         getFloat("TAKER_FEE_BPS", 0),
		},
	}
	// Live when there's a key to use, paper when there isn't; QUOTER_MODE overrides.
	c.Mode = get("QUOTER_MODE", "")
	if c.Mode == "" {
		c.Mode = "paper"
		if keyExists(c.KeyPath) {
			c.Mode = "live"
		}
	}
	if c.Mode != "live" && c.Mode != "paper" {
		errs = append(errs, fmt.Sprintf("QUOTER_MODE must be live or paper, got %q", c.Mode))
	}
	// The default take size is $20, which only makes sense in dollars: with sizes in the base
	// asset it defaults to the max position change instead.
	if get("TAKE_MAX_SIZE", "") != "" {
		c.Params.TakeMaxSize = getDec("TAKE_MAX_SIZE", "")
	} else if c.Params.SizeUnit == quoter.SizeInBase {
		c.Params.TakeMaxSize = baseTakeSize(c.Params)
	} else {
		c.Params.TakeMaxSize = decimal.NewFromInt(20)
	}
	if v := get("QUOTER_SYMBOL", ""); v != "" {
		errs = append(errs, "QUOTER_SYMBOL is gone: one quoter now runs every book. Add books from the console's Quoter screen, or list them in "+c.BooksFile+" (see README)")
	}
	pb, err := paper.ParseBalances(get("PAPER_BALANCES", "USDC=10000,BTC=0.05,ETH=1,SOL=20"))
	if err != nil {
		errs = append(errs, "PAPER_BALANCES "+err.Error())
	} else if _, ok := pb["USDC"]; !ok {
		errs = append(errs, "PAPER_BALANCES needs a USDC balance: every paper book is priced in USDC")
	}
	c.PaperBalances = pb
	for _, f := range []struct {
		key, def string
		to       *decimal.Decimal
	}{{"PAPER_MAKER_FEE_BPS", "0", &c.PaperMakerFeeBps}, {"PAPER_TAKER_FEE_BPS", "0", &c.PaperTakerFeeBps}} {
		v, err := decimal.NewFromString(get(f.key, f.def))
		if err != nil || v.IsNegative() {
			errs = append(errs, f.key+" must be a number of bps, 0 or more")
			continue
		}
		*f.to = v
	}
	// One state file per environment, so switching TM_ENV (or paper and live) never mixes them.
	stateEnv := c.Environment
	if c.Mode == "paper" {
		stateEnv = "paper"
	}
	c.StateFile = get("QUOTER_STATE_FILE", "state."+stateEnv+".json")

	c.FIX = FIXConfig{
		Addr:               get("FIX_ADDR", ""),
		TLS:                getBool("FIX_TLS", false),
		SenderCompID:       get("FIX_SENDER_COMP_ID", ""),
		TargetCompID:       get("FIX_TARGET_COMP_ID", ""),
		HeartBtInt:         getInt("FIX_HEARTBEAT_SECS", 30),
		CancelOnDisconnect: getBool("FIX_CANCEL_ON_DISCONNECT", true),
	}

	if c.Environment != "production" && c.Environment != "uat" {
		errs = append(errs, fmt.Sprintf("TM_ENV must be production or uat, got %q", c.Environment))
	}
	if c.Transport != "rest" && c.Transport != "fix" {
		errs = append(errs, fmt.Sprintf("ORDER_TRANSPORT must be rest or fix, got %q", c.Transport))
	}
	if c.Transport == "fix" && c.Mode == "live" {
		for k, v := range map[string]string{"FIX_ADDR": c.FIX.Addr, "FIX_SENDER_COMP_ID": c.FIX.SenderCompID, "FIX_TARGET_COMP_ID": c.FIX.TargetCompID} {
			if v == "" {
				errs = append(errs, k+" is required with ORDER_TRANSPORT=fix (FIX endpoints come from support@truemarkets.co)")
			}
		}
	}
	if len(c.IDPrefix) == 0 || len(c.IDPrefix) > 8 {
		errs = append(errs, "QUOTER_ID_PREFIX must be 1 to 8 characters")
	}
	if err := c.Params.Validate(); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return c, fmt.Errorf("configuration:\n  %s", strings.Join(errs, "\n  "))
	}
	return c, nil
}

// loadDotEnv sets KEY=VALUE lines from a file, without overriding the real environment.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(strings.TrimPrefix(k, "export "))
		v = strings.TrimSpace(v)
		if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		v = strings.Trim(v, `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

// keyExists reports a key file at path, or a folder holding at least one .json file.
func keyExists(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	if !st.IsDir() {
		return true
	}
	matches, _ := filepath.Glob(filepath.Join(path, "*.json"))
	return len(matches) > 0
}
