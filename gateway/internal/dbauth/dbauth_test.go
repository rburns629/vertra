// SPDX-License-Identifier: MIT

package dbauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestFederatedExchangesItsOwnTokenForTheAccountsAndKeepsIt(t *testing.T) {
	dir := t.TempDir()
	file := dir + "/token"
	if err := os.WriteFile(file, []byte("k8s-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	minted := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/sts":
			if body["subjectToken"] != "k8s-token" || body["audience"] != "identitynamespace:p.svc.id.goog:cluster" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"access_token":"federated"}`)
		case "/v1/projects/-/serviceAccounts/gw@p.iam.gserviceaccount.com:generateAccessToken":
			if r.Header.Get("Authorization") != "Bearer federated" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			minted++
			fmt.Fprintf(w, `{"accessToken":"db-token-%d","expireTime":%q}`, minted, now.Add(time.Hour).Format(time.RFC3339))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	f := &Federated{TokenFile: file, STSAudience: "identitynamespace:p.svc.id.goog:cluster", Account: "gw@p.iam.gserviceaccount.com",
		STS: server.URL + "/sts", IAMCredentials: server.URL, Client: server.Client(), Now: func() time.Time { return now }}
	for range 2 {
		if got, err := f.Password(context.Background()); err != nil || got != "db-token-1" {
			t.Fatalf("Password = %q, %v", got, err)
		}
	}
	now = now.Add(59*time.Minute + time.Second)
	if got, _ := f.Password(context.Background()); got != "db-token-2" {
		t.Fatalf("after 59 minutes: %q", got)
	}
}
