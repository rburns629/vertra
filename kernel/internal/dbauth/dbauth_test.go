// SPDX-License-Identifier: MIT

package dbauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTheTokenIsKeptUntilAMinuteBeforeItExpires(t *testing.T) {
	asked := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Metadata-Flavor") != "Google" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		asked++
		fmt.Fprintf(w, `{"access_token":"token-%d","expires_in":3600,"token_type":"Bearer"}`, asked)
	}))
	defer server.Close()
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	tokens := &Tokens{URL: server.URL, Client: server.Client(), Now: func() time.Time { return now }}

	for range 3 {
		if got, err := tokens.Password(context.Background()); err != nil || got != "token-1" {
			t.Fatalf("Password = %q, %v; want token-1", got, err)
		}
	}
	now = now.Add(59*time.Minute + time.Second)
	if got, _ := tokens.Password(context.Background()); got != "token-2" {
		t.Fatalf("after 59 minutes Password = %q; want a new token", got)
	}
}

func TestNoTokenIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	tokens := &Tokens{URL: server.URL, Client: server.Client(), Now: time.Now}
	if _, err := tokens.Password(context.Background()); err == nil {
		t.Fatal("Password: no error for a 404")
	}
}
