// SPDX-License-Identifier: MIT

// Package credentials mints the credential the gateway adds to a request
// for its backend, per the API's backend.auth, and keeps it until shortly
// before it expires. Nothing is stored that outlives it: a token for the
// API's own ServiceAccount (Kubernetes TokenRequest, for the audience the
// API names), and through that, other clouds' (phase 4, TODO.md).
package credentials

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// ErrUnsupported is a backend.auth this gateway can't mint yet.
var ErrUnsupported = errors.New("this kind of backend credential isn't supported by this gateway yet")

// TokenLifetime is how long a minted ServiceAccount token lasts; it's
// replaced when a fifth of that is left.
const TokenLifetime = 10 * time.Minute

// Minter mints backend credentials.
type Minter struct {
	// TokenRequest asks Kubernetes for a ServiceAccount token.
	TokenRequest func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error)
	Now          func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	value   string
	refresh time.Time
}

// Header is the header to add for an API's backend.auth, or "" when it has
// none.
func (m *Minter) Header(ctx context.Context, team, serviceAccount string, auth map[string]map[string]string) (string, string, error) {
	switch {
	case len(auth) == 0:
		return "", "", nil
	case auth["serviceAccountToken"] != nil:
		token, err := m.serviceAccountToken(ctx, team, serviceAccount, auth["serviceAccountToken"]["audience"])
		if err != nil {
			return "", "", err
		}
		return "Authorization", "Bearer " + token, nil
	}
	return "", "", ErrUnsupported
}

func (m *Minter) serviceAccountToken(ctx context.Context, namespace, serviceAccount, audience string) (string, error) {
	now := time.Now
	if m.Now != nil {
		now = m.Now
	}
	key := namespace + "/" + serviceAccount + "/" + audience
	m.mu.Lock()
	if c, ok := m.cache[key]; ok && now().Before(c.refresh) {
		m.mu.Unlock()
		return c.value, nil
	}
	m.mu.Unlock()
	token, expires, err := m.TokenRequest(ctx, namespace, serviceAccount, audience)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cache == nil {
		m.cache = map[string]cached{}
	}
	// Replaced once four fifths of its life are gone.
	m.cache[key] = cached{value: token, refresh: now().Add(expires.Sub(now()) * 4 / 5)}
	return token, nil
}

// InCluster is a TokenRequest through the Kubernetes API, as the gateway's
// own ServiceAccount (its RBAC and admission policy allow tokens for API
// ServiceAccounts, *-api in team namespaces, and nothing else).
func InCluster() (func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error), error) {
	const dir = "/var/run/secrets/kubernetes.io/serviceaccount/"
	ca, err := os.ReadFile(dir + "ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the cluster's CA certificate can't be read")
	}
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	return func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error) {
		// The kubelet rotates the gateway's own token; read it each time.
		own, err := os.ReadFile(dir + "token")
		if err != nil {
			return "", time.Time{}, err
		}
		body, _ := json.Marshal(map[string]any{"apiVersion": "authentication.k8s.io/v1", "kind": "TokenRequest",
			"spec": map[string]any{"audiences": []string{audience}, "expirationSeconds": int(TokenLifetime.Seconds())}})
		url := fmt.Sprintf("https://%s:%s/api/v1/namespaces/%s/serviceaccounts/%s/token", host, port, namespace, serviceAccount)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return "", time.Time{}, err
		}
		req.Header.Set("Authorization", "Bearer "+string(bytes.TrimSpace(own)))
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return "", time.Time{}, err
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
			return "", time.Time{}, fmt.Errorf("TokenRequest for %s/%s answered %d: %.200s", namespace, serviceAccount, res.StatusCode, data)
		}
		var out struct {
			Status struct {
				Token               string    `json:"token"`
				ExpirationTimestamp time.Time `json:"expirationTimestamp"`
			} `json:"status"`
		}
		if err := json.Unmarshal(data, &out); err != nil || out.Status.Token == "" {
			return "", time.Time{}, errors.New("TokenRequest returned no token")
		}
		return out.Status.Token, out.Status.ExpirationTimestamp, nil
	}, nil
}
