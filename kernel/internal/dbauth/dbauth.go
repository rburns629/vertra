// SPDX-License-Identifier: MIT

// Package dbauth signs the kernel in to a managed database with its own
// cloud identity instead of a password: on Google Cloud, Cloud SQL's IAM
// database authentication, the password being the workload's short-lived
// access token (GKE Workload Identity's, from the node's metadata server).
// No database password exists anywhere.
package dbauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
