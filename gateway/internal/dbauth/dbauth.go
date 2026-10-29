// SPDX-License-Identifier: MIT

// Package dbauth signs the gateway in to a managed database with its own
// cloud identity instead of a password: on Google Cloud, Cloud SQL's IAM
// database authentication, the password being the workload's short-lived
// access token (GKE Workload Identity's, from the node's metadata server).
// No database password exists anywhere.
package dbauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// GCPMetadataToken is where a GKE workload gets its Google access token.
const GCPMetadataToken = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

// Tokens gives out the workload's access token, fetched again a minute
// before it expires.
type Tokens struct {
	URL    string
	Client *http.Client
	Now    func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

// GCP is the token source a GKE workload uses.
func GCP() *Tokens {
	return &Tokens{URL: GCPMetadataToken, Client: &http.Client{Timeout: 10 * time.Second}, Now: time.Now}
}

// Password is the token to sign in with now.
func (t *Tokens) Password(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token != "" && t.Now().Before(t.expires) {
		return t.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := t.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("the database sign-in token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the database sign-in token: the metadata server answered %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.AccessToken == "" {
		return "", fmt.Errorf("the database sign-in token: an answer without one")
	}
	t.token = body.AccessToken
	t.expires = t.Now().Add(time.Duration(body.ExpiresIn)*time.Second - time.Minute)
	return t.token, nil
}

// Federated gives out an access token for a Google service account without
// the metadata server, which the gateway's NetworkPolicy keeps it from (a
// backend URL mustn't reach the node's credentials through it): its own
// Kubernetes ServiceAccount token (projected into the Pod for the cluster's
// Workload Identity pool) exchanged at Google's STS, then an hour's access
// token as Account from IAM Credentials, which the Workload Identity binding
// allows. Fetched again a minute before it expires.
type Federated struct {
	// TokenFile is the projected ServiceAccount token, which the kubelet
	// keeps fresh; STSAudience, what it's exchanged for.
	TokenFile, STSAudience string
	// Account is the Google service account it signs in as.
	Account string
	// Endpoints, replaced in tests.
	STS, IAMCredentials string
	Client              *http.Client
	Now                 func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

// Password is the token to sign in with now.
func (f *Federated) Password(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.token != "" && f.Now().Before(f.expires) {
		return f.token, nil
	}
	subject, err := os.ReadFile(f.TokenFile)
	if err != nil {
		return "", fmt.Errorf("the database sign-in token: %w", err)
	}
	var exchanged struct {
		AccessToken string `json:"access_token"`
	}
	if err := f.post(ctx, f.STS, "", map[string]any{
		"grantType":          "urn:ietf:params:oauth:grant-type:token-exchange",
		"audience":           f.STSAudience,
		"scope":              "https://www.googleapis.com/auth/cloud-platform",
		"requestedTokenType": "urn:ietf:params:oauth:token-type:access_token",
		"subjectTokenType":   "urn:ietf:params:oauth:token-type:jwt",
		"subjectToken":       strings.TrimSpace(string(subject)),
	}, &exchanged); err != nil {
		return "", fmt.Errorf("the database sign-in token, exchanged at Google: %w", err)
	}
	var minted struct {
		AccessToken string    `json:"accessToken"`
		ExpireTime  time.Time `json:"expireTime"`
	}
	endpoint := f.IAMCredentials + "/v1/projects/-/serviceAccounts/" + url.PathEscape(f.Account) + ":generateAccessToken"
	if err := f.post(ctx, endpoint, exchanged.AccessToken, map[string]any{
		"scope": []string{"https://www.googleapis.com/auth/cloud-platform"},
	}, &minted); err != nil {
		return "", fmt.Errorf("the database sign-in token as %s: %w", f.Account, err)
	}
	if minted.AccessToken == "" {
		return "", fmt.Errorf("the database sign-in token as %s: an answer without one", f.Account)
	}
	f.token, f.expires = minted.AccessToken, minted.ExpireTime.Add(-time.Minute)
	return f.token, nil
}

func (f *Federated) post(ctx context.Context, endpoint, bearer string, body, into any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		answer, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("%d: %s", resp.StatusCode, strings.TrimSpace(string(answer)))
	}
	return json.NewDecoder(resp.Body).Decode(into)
}
