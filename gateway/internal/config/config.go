// SPDX-License-Identifier: MIT

// Package config is the gateway's settings, from its environment (the
// console chart's gateway values), checked at startup so a mistake fails
// the rollout, not a request.
package config

import (
	"crypto/ed25519"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Settings are every setting.
type Settings struct {
	// The console's database, read only: published APIs, and who callers are.
	DatabaseURL string
	// The console's session secret, to check sessions as it does.
	JWTSecret []byte
	// SigningKey signs Vertra-Caller; Issuer is the gateway's address, its iss.
	SigningKey ed25519.PrivateKey
	Issuer     string
	// Where it listens: inside the cluster, from the internet (empty: no
	// public listener), and for metrics.
	Listen, PublicListen, MetricsListen string
	BackendHosts, InternetTeams         []string
	DefaultPerMinute                    int
	// Minting Google ID tokens: the STS audience API ServiceAccounts'
	// tokens are exchanged for (GKE: the cluster's Workload Identity
	// pool; elsewhere a provider trusting its issuer), and the audience
	// those tokens carry. Empty: googleIdToken APIs fail with 502.
	GCPAudience, GCPTokenAudience string
	Closed                        bool
	Refresh                       time.Duration
}

// Load reads the environment.
func Load(getenv func(string) string) (*Settings, error) {
	var problems []string
	need := func(name string) string {
		v := getenv(name)
		if v == "" {
			problems = append(problems, name+" is required")
		}
		return v
	}
	or := func(name, fallback string) string {
		if v := getenv(name); v != "" {
			return v
		}
		return fallback
	}
	number := func(name string, fallback int) int {
		v := getenv(name)
		if v == "" {
			return fallback
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			problems = append(problems, fmt.Sprintf("%s: a whole number, got %q", name, v))
		}
		return n
	}
	s := &Settings{
		DatabaseURL:      need("DATABASE_URL"),
		JWTSecret:        []byte(need("JWT_SECRET")),
		Issuer:           need("GATEWAY_ISSUER"),
		Listen:           or("LISTEN", ":8080"),
		PublicListen:     getenv("PUBLIC_LISTEN"),
		MetricsListen:    or("METRICS_LISTEN", ":9090"),
		BackendHosts:     list(getenv("BACKEND_HOSTS")),
		InternetTeams:    list(getenv("INTERNET_TEAMS")),
		DefaultPerMinute: number("DEFAULT_PER_MINUTE", 600),
		GCPAudience:      getenv("GCP_STS_AUDIENCE"),
		GCPTokenAudience: getenv("GCP_TOKEN_AUDIENCE"),
		Closed:           getenv("CLOSED") == "true",
		Refresh:          time.Duration(number("REFRESH_SECONDS", 5)) * time.Second,
	}
	if path := need("SIGNING_KEY_FILE"); path != "" {
		seed, err := os.ReadFile(path)
		seed = []byte(strings.TrimSpace(string(seed)))
		if err != nil || len(seed) != ed25519.SeedSize {
			problems = append(problems, fmt.Sprintf("SIGNING_KEY_FILE: %d bytes of seed, %s", ed25519.SeedSize, path))
		} else {
			s.SigningKey = ed25519.NewKeyFromSeed(seed)
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("the gateway's settings: %s", strings.Join(problems, "; "))
	}
	return s, nil
}

func list(v string) []string {
	var out []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
