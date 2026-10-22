// SPDX-License-Identifier: MIT

// Package store holds the gateway's view of the published APIs: read from
// the console's apis table (which the catalog's releases fill) every few
// seconds, each with its OpenAPI validator, built again only when its row
// changes. An API whose team is retired or purged isn't there at all.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/pb33f/libopenapi"
	validator "github.com/pb33f/libopenapi-validator"
)

// API is one published API, as the gateway serves it.
type API struct {
	Team, Name     string
	BackendURL     *url.URL
	BackendAuth    map[string]map[string]string
	ServiceAccount string
	ShareWith      []string
	Internet       bool
	PerMinute      map[string]int
	Timeout        time.Duration
	MaxRequest     int64
	PausedMessage  *string
	UpdatedAt      time.Time
	// Validator checks a request against the spec; Problem says why there
	// isn't one (the API then answers 503: it can't be checked, so it isn't
	// forwarded).
	Validator validator.Validator
	Problem   string
}

// Key is <team>/<name>.
func (a *API) Key() string { return a.Team + "/" + a.Name }

// Store is the published APIs.
type Store struct {
	DB interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	}
	Log *slog.Logger

	mu   sync.RWMutex
	apis map[string]*API
}

// Get is an API by team and name.
func (s *Store) Get(team, name string) *API {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.apis[team+"/"+name]
}

// Len is how many APIs it holds.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.apis)
}

// Refresh reads the APIs again, building a validator for each that's new or changed.
func (s *Store) Refresh(ctx context.Context) error {
	rows, err := s.DB.Query(ctx, `SELECT t.name, a.name, a.openapi::text, a.backend_url, coalesce(a.backend_auth::text, ''),
			a.service_account, a.share_with, a.internet, a.per_minute::text, a.timeout_seconds, a.max_request_bytes,
			a.paused_message, a.updated_at
		FROM apis a JOIN teams t ON t.id = a.team_id WHERE t.retired_at IS NULL AND t.deleted_at IS NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	s.mu.RLock()
	old := s.apis
	s.mu.RUnlock()
	next := map[string]*API{}
	for rows.Next() {
		var a API
		var spec, backendURL, auth, perMinute string
		var timeout int
		if err := rows.Scan(&a.Team, &a.Name, &spec, &backendURL, &auth, &a.ServiceAccount, &a.ShareWith, &a.Internet,
			&perMinute, &timeout, &a.MaxRequest, &a.PausedMessage, &a.UpdatedAt); err != nil {
			return err
		}
		if prev := old[a.Key()]; prev != nil && prev.UpdatedAt.Equal(a.UpdatedAt) {
			next[a.Key()] = prev
			continue
		}
		a.Timeout = time.Duration(timeout) * time.Second
		_ = json.Unmarshal([]byte(perMinute), &a.PerMinute)
		if auth != "" {
			_ = json.Unmarshal([]byte(auth), &a.BackendAuth)
		}
		if a.BackendURL, err = url.Parse(backendURL); err != nil {
			a.Problem = "its backend URL can't be read"
		} else if v, problem := build([]byte(spec)); problem != "" {
			a.Problem = problem
		} else {
			a.Validator = v
		}
		if a.Problem != "" {
			s.Log.Warn("an API can't be served", "api", a.Key(), "problem", a.Problem)
		}
		next[a.Key()] = &a
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	s.apis = next
	s.mu.Unlock()
	return nil
}

// Put adds an API whose spec is given, for tests.
func (s *Store) Put(a *API, spec []byte) {
	if a.Validator == nil {
		a.Validator, a.Problem = build(spec)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.apis == nil {
		s.apis = map[string]*API{}
	}
	s.apis[a.Key()] = a
}

func build(spec []byte) (validator.Validator, string) {
	doc, err := libopenapi.NewDocument(spec)
	if err != nil {
		return nil, "its OpenAPI document can't be read: " + err.Error()
	}
	v, errs := validator.NewValidator(doc)
	if len(errs) > 0 {
		return nil, fmt.Sprintf("its OpenAPI document can't be used: %v", errs[0])
	}
	return v, ""
}

// Run refreshes every interval until ctx ends; a failed refresh keeps
// what it had, and is logged.
func (s *Store) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Refresh(ctx); err != nil {
				s.Log.Error("couldn't read the published APIs", "error", err)
			}
		}
	}
}

// BackendAllowed: the URL's host is one of hosts, exactly or below a "*."
// pattern (the console's rule, console/src/core/apis.ts).
func BackendAllowed(u *url.URL, hosts []string) bool {
	host := strings.ToLower(u.Hostname())
	for _, pattern := range hosts {
		p := strings.ToLower(pattern)
		if suffix, ok := strings.CutPrefix(p, "*"); ok && strings.HasPrefix(suffix, ".") {
			if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
				return true
			}
		} else if host == p {
			return true
		}
	}
	return false
}
