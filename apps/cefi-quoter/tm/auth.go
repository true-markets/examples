// Package tm talks to the True Markets CeFi exchange: API key signing, access tokens, the CeFi
// REST API and the CeFi WebSocket.
package tm

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// APIKey is the JSON file app.truemarkets.co downloads when you create an API key:
// { "key_id": "...", "private_key": { "kty": "EC", "crv": "P-256", "d": "...", ... } }.
// The same key signs REST token requests, WebSocket subscriptions and the FIX Logon.
type APIKey struct {
	KeyID string
	priv  *ecdsa.PrivateKey
}

// LoadAPIKey reads a key file, or a folder holding exactly one .json key file.
func LoadAPIKey(path string) (*APIKey, error) {
	file, err := findKeyFile(path)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("reading API key: %w", err)
	}
	var parsed struct {
		KeyID      string `json:"key_id"`
		PrivateKey struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			D   string `json:"d"`
		} `json:"private_key"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%s is not JSON: %w", file, err)
	}
	jwk := parsed.PrivateKey
	if parsed.KeyID == "" || jwk.Kty != "EC" || jwk.Crv != "P-256" || jwk.D == "" {
		return nil, fmt.Errorf("%s is not a True Markets API key file (expected key_id and a P-256 private_key)", file)
	}
	d, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(jwk.D, "="))
	if err != nil {
		return nil, fmt.Errorf("%s: bad private key: %w", file, err)
	}
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		return nil, fmt.Errorf("%s: bad private key: %w", file, err)
	}
	return &APIKey{KeyID: parsed.KeyID, priv: priv}, nil
}

func findKeyFile(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("no API key at %s: create one at app.truemarkets.co (Settings, API keys) and put the downloaded file there", path)
	}
	if !st.IsDir() {
		return path, nil
	}
	matches, _ := filepath.Glob(filepath.Join(path, "*.json"))
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no .json key file in %s: create an API key at app.truemarkets.co (Settings, API keys) and move the downloaded file there", path)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("found %d key files in %s: set TM_API_KEY_PATH to the one to use", len(matches), path)
	}
}

// Sign returns an ES256 signature the way True Markets wants it everywhere: SHA-256, ECDSA P-256,
// the raw 64-byte r || s (not DER), base64url without padding.
func (k *APIKey) Sign(message string) string {
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, k.priv, digest[:])
	if err != nil {
		// Only fails if the system random source does, and then nothing else will work either.
		panic(fmt.Sprintf("ecdsa sign: %v", err))
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig)
}

// UnixSeconds is the timestamp every signed request carries. The exchange accepts 15 seconds in
// the past and 1 second ahead, so make it right before sending.
func UnixSeconds() string { return strconv.FormatInt(time.Now().Unix(), 10) }

// TokenSource mints access tokens from the API key and mints again two minutes before expiry.
type TokenSource struct {
	key      *APIKey
	authBase string
	http     *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

func NewTokenSource(key *APIKey, authBase string) *TokenSource {
	return &TokenSource{key: key, authBase: authBase, http: &http.Client{Timeout: 10 * time.Second}}
}

const remintBefore = 2 * time.Minute

// Token returns a valid access token, minting one if needed.
func (t *TokenSource) Token(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token != "" && time.Until(t.expires) > remintBefore {
		return t.token, nil
	}
	// POST /v1/auth/api-key/token with a signature over "{key_id}.{unix seconds}".
	ts := time.Now().Unix()
	body, _ := json.Marshal(map[string]any{
		"key_id":    t.key.KeyID,
		"timestamp": ts,
		"signature": t.key.Sign(fmt.Sprintf("%s.%d", t.key.KeyID, ts)),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.authBase+"/api-key/token", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/json")
	res, err := t.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("minting a token: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return "", apiError(res, "minting a token")
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   string `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || out.AccessToken == "" {
		return "", errors.New("minting a token: no access_token in the response")
	}
	t.token = out.AccessToken
	// expires_in is a timestamp, not a duration.
	if exp, err := time.Parse(time.RFC3339, out.ExpiresIn); err == nil {
		t.expires = exp
	} else {
		t.expires = time.Now().Add(time.Hour)
	}
	return t.token, nil
}

// Claim reads a claim from the access token. Claims sit at the top level or under "tm",
// depending on the key type.
func (t *TokenSource) Claim(ctx context.Context, name string) (string, error) {
	tok, err := t.Token(ctx)
	if err != nil {
		return "", err
	}
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return "", errors.New("access token is not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", err
	}
	// UseNumber: client ids are 17+ digit integers, which a float64 would round.
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var claims map[string]any
	if err := dec.Decode(&claims); err != nil {
		return "", err
	}
	v, ok := claims[name]
	if !ok {
		if nested, isMap := claims["tm"].(map[string]any); isMap {
			v, ok = nested[name]
		}
	}
	if !ok || v == nil {
		return "", nil
	}
	switch x := v.(type) {
	case string:
		return x, nil
	case json.Number:
		return x.String(), nil
	default:
		return fmt.Sprint(x), nil
	}
}
