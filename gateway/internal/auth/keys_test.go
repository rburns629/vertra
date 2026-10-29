// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestConsoleKeysFollowTheConsolesJWKS(t *testing.T) {
	current := atomic.Value{}
	current.Store("one")
	var fetches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches.Add(1)
		kid := current.Load().(string)
		x := base64.RawURLEncoding.EncodeToString(secret.Public().(ed25519.PublicKey))
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
			{"kty": "OKP", "crv": "Ed25519", "x": x, "kid": kid, "alg": "EdDSA"},
			{"kty": "RSA", "kid": "ignored"},
		}})
	}))
	defer server.Close()
	k := &ConsoleKeys{URL: server.URL}
	ctx := context.Background()

	if _, err := k.Key(ctx, "one"); err != nil {
		t.Fatalf("the published key: %v", err)
	}
	if _, err := k.Key(ctx, "one"); err != nil || fetches.Load() != 1 {
		t.Fatalf("a known key is kept, not fetched again: %v, %d fetches", err, fetches.Load())
	}
	// An unknown id right after a fetch is refused without asking again, so
	// made-up ids can't make the gateway hammer the console.
	if _, err := k.Key(ctx, "made-up"); err != ErrUnauthenticated || fetches.Load() != 1 {
		t.Fatalf("an unknown id, just after a fetch: %v, %d fetches", err, fetches.Load())
	}
	// A rotated JWT_SECRET: the new id is fetched once the pause has passed.
	current.Store("two")
	k.fetched = time.Now().Add(-refetchAfter)
	if _, err := k.Key(ctx, "two"); err != nil || fetches.Load() != 2 {
		t.Fatalf("the rotated key: %v, %d fetches", err, fetches.Load())
	}
}

func TestConsoleKeysSayWhenTheConsoleCantBeRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	_, err := (&ConsoleKeys{URL: server.URL}).Key(context.Background(), "one")
	if err == nil || err == ErrUnauthenticated {
		t.Fatalf("an unreadable console is the gateway's problem, not the caller's: %v", err)
	}
}
