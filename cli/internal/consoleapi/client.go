// SPDX-License-Identifier: MIT

// Package consoleapi is the little of the console's API acyclixctl needs:
// signing in as the admin, minting the catalog's tokens, creating a team,
// and running a DAG. It calls the console's Connect services (generated
// from proto/ into internal/gen). Tokens and passwords pass through memory
// only.
package consoleapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	consolev1 "github.com/rburns629/acyclix/cli/internal/gen/acyclix/console/v1"
	"github.com/rburns629/acyclix/cli/internal/gen/acyclix/console/v1/consolev1connect"
)

// callTimeout bounds each call but a watch, which lasts as long as its run.
const callTimeout = 2 * time.Minute

// Client talks to one console as one user.
type Client struct {
	URL        string
	token      string
	auth       consolev1connect.AuthServiceClient
	teams      consolev1connect.TeamServiceClient
	products   consolev1connect.ProductServiceClient
	tokens     consolev1connect.TokenServiceClient
	executions consolev1connect.ExecutionServiceClient
}

// New returns a client for the console at url.
func New(url string) *Client {
	c := &Client{URL: url}
	// No client-wide timeout: it would cut a watch short.
	httpClient := &http.Client{}
	base := strings.TrimSuffix(url, "/") + "/api"
	opts := []connect.ClientOption{connect.WithInterceptors(c.session())}
	c.auth = consolev1connect.NewAuthServiceClient(httpClient, base, opts...)
	c.teams = consolev1connect.NewTeamServiceClient(httpClient, base, opts...)
	c.products = consolev1connect.NewProductServiceClient(httpClient, base, opts...)
	c.tokens = consolev1connect.NewTokenServiceClient(httpClient, base, opts...)
	c.executions = consolev1connect.NewExecutionServiceClient(httpClient, base, opts...)
	return c
}

// session sends the signed-in session's token with every call.
func (c *Client) session() connect.Interceptor {
	return sessionInterceptor{c}
}

type sessionInterceptor struct{ c *Client }

func (s sessionInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if s.c.token != "" {
			req.Header().Set("Authorization", "Bearer "+s.c.token)
		}
		return next(ctx, req)
	}
}

func (s sessionInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		if s.c.token != "" {
			conn.RequestHeader().Set("Authorization", "Bearer "+s.c.token)
		}
		return conn
	}
}

func (sessionInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// Refusal is the console saying no: its Connect code, its message and,
// for a refused document, each problem it found.
type Refusal struct {
	Code     connect.Code
	Message  string
	Problems []string
}

func (r *Refusal) Error() string {
	return fmt.Sprintf("the console refused (%s): %s", r.Code, r.Message)
}

// refused says what the console refused, without Connect's code prefix.
func refused(err error) error {
	var ce *connect.Error
	if !errors.As(err, &ce) || noAnswer(err) {
		return fmt.Errorf("reaching the console: %w", err)
	}
	r := &Refusal{Code: ce.Code(), Message: ce.Message()}
	for _, d := range ce.Details() {
		if v, err := d.Value(); err == nil {
			if p, ok := v.(*consolev1.Problem); ok {
				where := ""
				if p.GetField() != "" {
					where = p.GetField() + ": "
				}
				r.Problems = append(r.Problems, where+p.GetMessage())
			}
		}
	}
	return r
}

// noAnswer says whether a call failed without the console answering (it
// couldn't be reached, or the connection dropped): an answer carries
// response headers; a network failure has none.
func noAnswer(err error) bool {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return true
	}
	switch ce.Code() {
	case connect.CodeUnavailable, connect.CodeUnknown, connect.CodeDeadlineExceeded, connect.CodeCanceled:
		return len(ce.Meta()) == 0
	}
	return false
}

// RetryDelay is the wait before the first retry of a call that got no
// answer; each later one waits that much longer.
var RetryDelay = 5 * time.Second

// idempotent makes a call that's safe to repeat, again when it got no
// answer (up to four tries), each try with its own time limit.
func idempotent(ctx context.Context, call func(context.Context) error) error {
	var err error
	for attempt := 1; attempt <= 4; attempt++ {
		tryCtx, cancel := context.WithTimeout(ctx, callTimeout)
		err = call(tryCtx)
		cancel()
		if err == nil || !noAnswer(err) || ctx.Err() != nil || attempt == 4 {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Duration(attempt) * RetryDelay):
		}
	}
	if err != nil {
		return refused(err)
	}
	return nil
}

// UseToken signs in with a token (a bot's or an automation token).
func (c *Client) UseToken(token string) { c.token = token }

// SignIn signs in with an email and password.
func (c *Client) SignIn(ctx context.Context, email, password string) error {
	return idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.auth.Login(ctx, connect.NewRequest(&consolev1.LoginRequest{Email: email, Password: password}))
		if err == nil {
			c.token = resp.Msg.GetToken()
		}
		return err
	})
}

// MintToken creates an automation token with scopes (admins only) and
// returns its id and the token: shown nowhere, it's for the caller to store.
func (c *Client) MintToken(ctx context.Context, label string, scopes []string) (id, token string, err error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.tokens.CreateAutomationToken(ctx, connect.NewRequest(&consolev1.CreateAutomationTokenRequest{
		Label: label, Scopes: scopes,
	}))
	if err != nil {
		return "", "", refused(err)
	}
	return resp.Msg.GetTokenId(), resp.Msg.GetToken(), nil
}

// RevokeOthers revokes every live automation token labelled label except
// keep: what a new token replaces.
func (c *Client) RevokeOthers(ctx context.Context, label, keep string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.tokens.ListAutomationTokens(ctx, connect.NewRequest(&consolev1.ListAutomationTokensRequest{}))
	if err != nil {
		return 0, refused(err)
	}
	n := 0
	for _, t := range resp.Msg.GetTokens() {
		if t.GetLabel() == label && t.GetId() != keep {
			if _, err := c.tokens.RevokeToken(ctx, connect.NewRequest(&consolev1.RevokeTokenRequest{TokenId: t.GetId()})); err != nil {
				return n, refused(err)
			}
			n++
		}
	}
	return n, nil
}

// CreateTeam creates a team (and its namespace); one that exists is fine.
func (c *Client) CreateTeam(ctx context.Context, name string) error {
	_, err := c.EnsureTeam(ctx, name)
	return err
}

// EnsureTeam makes a team exist and be active, with its namespace, and says
// whether it created it.
func (c *Client) EnsureTeam(ctx context.Context, name string) (created bool, err error) {
	err = idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.teams.EnsureTeam(ctx, connect.NewRequest(&consolev1.EnsureTeamRequest{Name: name}))
		if err == nil {
			created = resp.Msg.GetCreated()
		}
		return err
	})
	return created, err
}

// RetireTeam retires a team (reversible) and says how many of its products
// were unregistered; found is false when there's no such team, which isn't
// an error.
func (c *Client) RetireTeam(ctx context.Context, name string) (found bool, unregistered int, err error) {
	err = idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.teams.RetireTeam(ctx, connect.NewRequest(&consolev1.RetireTeamRequest{Name: name}))
		if err == nil {
			unregistered = int(resp.Msg.GetUnregisteredProducts())
		}
		return err
	})
	found, err = notFoundIsFine(err)
	return found, unregistered, err
}

// PurgeTeam purges a retired team (irreversible), and says whether its
// namespace went too; found is false when there's no such team.
func (c *Client) PurgeTeam(ctx context.Context, name string) (found, namespaceDeleted bool, err error) {
	err = idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.teams.PurgeTeam(ctx, connect.NewRequest(&consolev1.PurgeTeamRequest{Name: name}))
		if err == nil {
			namespaceDeleted = resp.Msg.GetNamespaceDeleted()
		}
		return err
	})
	found, err = notFoundIsFine(err)
	return found, namespaceDeleted, err
}

func notFoundIsFine(err error) (bool, error) {
	var r *Refusal
	if errors.As(err, &r) && r.Code == connect.CodeNotFound {
		return false, nil
	}
	return err == nil, err
}

// ApplySecretStore has the console check and apply a team's SecretStore
// documents, with credential (a stored credential) when there is one. A
// refusal lists each problem.
func (c *Client) ApplySecretStore(ctx context.Context, team string, documents []any, credential string) error {
	req := &consolev1.ApplySecretStoreRequest{Team: team}
	for i, doc := range documents {
		m, ok := doc.(map[string]any)
		if !ok {
			return fmt.Errorf("document %d isn't an object", i+1)
		}
		s, err := StructOf(m)
		if err != nil {
			return fmt.Errorf("document %d: %w", i+1, err)
		}
		req.Documents = append(req.Documents, s)
	}
	if credential != "" {
		req.Credential = &credential
	}
	return idempotent(ctx, func(ctx context.Context) error {
		_, err := c.teams.ApplySecretStore(ctx, connect.NewRequest(req))
		return err
	})
}

// RegisterProduct registers (or updates) one product action.
func (c *Client) RegisterProduct(ctx context.Context, req *consolev1.RegisterProductRequest) error {
	return idempotent(ctx, func(ctx context.Context) error {
		_, err := c.products.RegisterProduct(ctx, connect.NewRequest(req))
		return err
	})
}

// StructOf is a JSON-shaped object as a protobuf Struct.
func StructOf(v any) (*structpb.Struct, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	s := &structpb.Struct{}
	return s, s.UnmarshalJSON(data)
}

// Task is one step of a DAG to submit.
type Task struct {
	ID, Image, Action, Team string
	Inputs                  map[string]any
}

// Submit runs a DAG of tasks and returns its execution's id.
func (c *Client) Submit(ctx context.Context, name, requestID string, tasks []Task) (string, error) {
	dag := &consolev1.Dag{Name: name, RequestId: requestID}
	for _, t := range tasks {
		inputs, err := structpb.NewStruct(t.Inputs)
		if err != nil {
			return "", fmt.Errorf("task %s's inputs: %w", t.ID, err)
		}
		dag.Tasks = append(dag.Tasks, &consolev1.TaskDefinition{
			Id: t.ID, Image: t.Image, Action: t.Action, Team: t.Team, Inputs: inputs,
		})
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.executions.SubmitExecution(ctx, connect.NewRequest(&consolev1.SubmitExecutionRequest{Dag: dag}))
	if err != nil {
		return "", refused(err)
	}
	return resp.Msg.GetExecutionId(), nil
}

// Execution is an execution's state and its tasks' outcomes.
type Execution struct {
	State string
	Tasks []TaskOutcome
}

// TaskOutcome is one task's state, outputs and failure (if it failed).
type TaskOutcome struct {
	ID, State string
	Outputs   map[string]any
	Failure   string
}

// Finished says whether the execution has stopped.
func (e *Execution) Finished() bool {
	return e.State == "SUCCEEDED" || e.State == "FAILED" || e.State == "CANCELLED"
}

func execution(m *consolev1.Execution) *Execution {
	e := &Execution{State: strings.TrimPrefix(m.GetState().String(), "EXECUTION_STATE_")}
	for _, t := range m.GetTasks() {
		outcome := TaskOutcome{
			ID:      t.GetTaskId(),
			State:   strings.TrimPrefix(t.GetState().String(), "TASK_STATE_"),
			Outputs: t.GetOutputs().AsMap(),
		}
		if f := t.GetFailure(); f != nil {
			outcome.Failure = f.GetCode() + ": " + f.GetMessage()
		}
		e.Tasks = append(e.Tasks, outcome)
	}
	return e
}

// Wait follows an execution until it finishes, or until limit has passed,
// and returns it as last seen. A stream that ends or drops before the
// execution finishes (the console's limit per stream, a load balancer's
// timeout) is reopened; a refusal ends the wait.
func (c *Client) Wait(ctx context.Context, id string, limit time.Duration) (*Execution, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var last *Execution
	for {
		stream, err := c.executions.WatchExecution(ctx, connect.NewRequest(&consolev1.WatchExecutionRequest{ExecutionId: id}))
		if err == nil {
			for stream.Receive() {
				last = execution(stream.Msg().GetExecution())
				if last.Finished() {
					_ = stream.Close()
					return last, nil
				}
			}
			err = stream.Err()
			_ = stream.Close()
		}
		if ctx.Err() != nil {
			return last, fmt.Errorf("execution %s didn't finish within %s", id, limit)
		}
		var ce *connect.Error
		if errors.As(err, &ce) && ce.Code() != connect.CodeUnavailable && ce.Code() != connect.CodeUnknown && ce.Code() != connect.CodeInternal {
			return last, refused(err)
		}
		// Ended or dropped: watch again after a moment.
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}
