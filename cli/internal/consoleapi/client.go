// SPDX-License-Identifier: MIT

// Package consoleapi is the little of the console's API acyclixctl needs:
// signing in as the admin, minting the catalog's tokens, creating a team,
// and running a DAG. Tokens and passwords pass through memory only.
package consoleapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to one console as one user.
type Client struct {
	URL   string
	token string
	http  *http.Client
}

// New returns a client for the console at url.
func New(url string) *Client {
	return &Client{URL: url, http: &http.Client{Timeout: 2 * time.Minute}}
}

// Error is a refusal from the console.
type Error struct {
	Status  int
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("the console answered %d %s: %s", e.Status, e.Code, e.Message)
}

func (c *Client) call(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("reaching the console: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		e := &Error{Status: resp.StatusCode}
		_ = json.Unmarshal(data, e)
		return e
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// SignIn signs in with an email and password.
func (c *Client) SignIn(ctx context.Context, email, password string) error {
	var out struct {
		Token string `json:"token"`
	}
	if err := c.call(ctx, "POST", "/api/auth/login", map[string]string{"email": email, "password": password}, &out); err != nil {
		return err
	}
	c.token = out.Token
	return nil
}

// MintToken creates an automation token with scopes (admins only) and
// returns its id and the token: shown nowhere, it's for the caller to store.
func (c *Client) MintToken(ctx context.Context, label string, scopes []string) (id, token string, err error) {
	var out struct {
		ID    string `json:"tokenId"`
		Token string `json:"token"`
	}
	err = c.call(ctx, "POST", "/api/automation-tokens", map[string]any{"label": label, "scopes": scopes}, &out)
	return out.ID, out.Token, err
}

// RevokeOthers revokes every live automation token labelled label except
// keep: what a new token replaces.
func (c *Client) RevokeOthers(ctx context.Context, label, keep string) (int, error) {
	var tokens []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	}
	if err := c.call(ctx, "GET", "/api/automation-tokens", nil, &tokens); err != nil {
		return 0, err
	}
	n := 0
	for _, t := range tokens {
		if t.Label == label && t.ID != keep {
			if err := c.call(ctx, "DELETE", "/api/tokens/"+t.ID, nil, nil); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}

// CreateTeam creates a team (and its namespace); one that exists is fine.
func (c *Client) CreateTeam(ctx context.Context, name string) error {
	err := c.call(ctx, "POST", "/api/teams", map[string]string{"name": name}, nil)
	if e, ok := err.(*Error); ok && e.Status == http.StatusConflict {
		return nil
	}
	return err
}

// Submit runs a DAG and returns its execution's id.
func (c *Client) Submit(ctx context.Context, dag map[string]any) (string, error) {
	var out struct {
		ExecutionID string `json:"executionId"`
	}
	err := c.call(ctx, "POST", "/api/executions", dag, &out)
	return out.ExecutionID, err
}

// Execution is an execution's state and its tasks' outputs.
type Execution struct {
	State string `json:"state"`
	Tasks []struct {
		ID      string         `json:"taskId"`
		State   string         `json:"state"`
		Outputs map[string]any `json:"outputs"`
		Failure map[string]any `json:"failure"`
	} `json:"tasks"`
}

// Get reads an execution.
func (c *Client) Get(ctx context.Context, id string) (*Execution, error) {
	var out Execution
	return &out, c.call(ctx, "GET", "/api/executions/"+id, nil, &out)
}
