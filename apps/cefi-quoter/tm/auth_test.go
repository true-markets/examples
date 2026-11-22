package tm

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTestKey writes a key file in the format app.truemarkets.co downloads.
func writeTestKey(t *testing.T, dir string) *ecdsa.PrivateKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := priv.Bytes()
	b64 := base64.RawURLEncoding.EncodeToString
	file := map[string]any{
		"key_id":    "11112222-3333-4444-8555-666677778888",
		"algorithm": "ES256",
		"private_key": map[string]string{
			"kty": "EC", "crv": "P-256", "d": b64(raw),
		},
	}
	b, _ := json.Marshal(file)
	if err := os.WriteFile(filepath.Join(dir, "key.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	return priv
}

func TestSignIsRawES256(t *testing.T) {
	dir := t.TempDir()
	priv := writeTestKey(t, dir)
	key, err := LoadAPIKey(dir) // a folder with one key file works
	if err != nil {
		t.Fatal(err)
	}
	if key.KeyID != "11112222-3333-4444-8555-666677778888" {
		t.Fatalf("key id %q", key.KeyID)
	}
	msg := "1700000000TRUEXWS11112222-3333-4444-8555-666677778888/v1/cefi/market"
	sig, err := base64.RawURLEncoding.DecodeString(key.Sign(msg))
	if err != nil {
		t.Fatal(err)
	}
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes, want raw r||s of 64", len(sig))
	}
	digest := sha256.Sum256([]byte(msg))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&priv.PublicKey, digest[:], r, s) {
		t.Fatal("signature does not verify against the public key")
	}
}

func TestLoadAPIKeyErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadAPIKey(dir); err == nil {
		t.Fatal("empty folder should fail")
	}
	writeTestKey(t, dir)
	_ = os.WriteFile(filepath.Join(dir, "other.json"), []byte("{}"), 0o600)
	if _, err := LoadAPIKey(dir); err == nil {
		t.Fatal("two key files should fail")
	}
	if _, err := LoadAPIKey(filepath.Join(dir, "other.json")); err == nil {
		t.Fatal("a file without key_id should fail")
	}
}

func TestAPIErrorKeepsFieldViolations(t *testing.T) {
	res := &http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(
		`{"type":"invalid_argument","code":"bad_request","message":"Request could not be processed","field_violations":[{"field":"info.new_price","description":"not a multiple of the tick"}],"request_id":"abc123"}`))}
	err := apiError(res, "PATCH /orders")
	for _, want := range []string{"info.new_price", "not a multiple of the tick", "request_id abc123", "(400)"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("%q missing from %q", want, err)
		}
	}
}
