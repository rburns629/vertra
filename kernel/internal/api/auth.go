// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	authv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// kernel-api has no users or teams; it trusts its caller (the console) to
// have authorized each request. So the one thing it checks is that the
// caller really is the console: its ServiceAccount token, projected for
// this API's audience so it's useless anywhere else. A TokenReview says
// whose it is (and that it's valid, unexpired and meant for this
// audience); the username must then be on the allowlist.
//
// Successful reviews are remembered for cacheFor, in a bounded cache, so a
// busy console doesn't cost a TokenReview per request. A TokenReview
// doesn't say when the token expires, so a token can stay accepted up to
// that long after it expires or its ServiceAccount is deleted.

const (
	cacheFor     = 60 * time.Second
	cacheEntries = 256
)

// ReviewToken says whose token this is, for this audience ("" for no one).
type ReviewToken func(ctx context.Context, token, audience string) (string, error)

// KubernetesReview asks the API server.
func KubernetesReview(client kubernetes.Interface, timeout time.Duration) ReviewToken {
	return func(ctx context.Context, token, audience string) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		review, err := client.AuthenticationV1().TokenReviews().Create(ctx, &authv1.TokenReview{
			Spec: authv1.TokenReviewSpec{Token: token, Audiences: []string{audience}}}, metav1.CreateOptions{})
		if err != nil {
			return "", err
		}
		s := review.Status
		if !s.Authenticated || !slices.Contains(s.Audiences, audience) {
			return "", nil
		}
		return s.User.Username, nil
	}
}

type remembered struct {
	username string
	until    time.Time
}

// Callers is the check: only allowed callers' tokens pass.
type Callers struct {
	Review   ReviewToken
	Audience string
	Allowed  []string
	Log      *slog.Logger
	now      func() time.Time

	mu    sync.Mutex
	cache map[[32]byte]remembered
	order [][32]byte // oldest first
}

func (c *Callers) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// Caller is the allowed caller's username, or an unauthenticated or
// permission_denied error. A failing review fails the request.
func (c *Callers) Caller(ctx context.Context, authorization string) (string, error) {
	scheme, token, _ := strings.Cut(authorization, " ")
	token = strings.TrimSpace(token)
	if !strings.EqualFold(scheme, "bearer") || token == "" {
		return "", connect.NewError(connect.CodeUnauthenticated, errors.New("A bearer token is required."))
	}
	key := sha256.Sum256([]byte(token))
	now := c.clock()
	c.mu.Lock()
	cached, ok := c.cache[key]
	c.mu.Unlock()
	if ok && cached.until.After(now) {
		return cached.username, nil
	}
	username, err := c.Review(ctx, token, c.Audience)
	if err != nil {
		return "", err
	}
	if username == "" {
		return "", connect.NewError(connect.CodeUnauthenticated, errors.New("Invalid or expired token."))
	}
	if !slices.Contains(c.Allowed, username) {
		c.Log.Warn("kernel-api call refused", "caller", username)
		return "", connect.NewError(connect.CodePermissionDenied, errors.New("This caller may not use kernel-api."))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cache == nil {
		c.cache = map[[32]byte]remembered{}
	}
	if _, ok := c.cache[key]; ok {
		c.order = slices.DeleteFunc(c.order, func(k [32]byte) bool { return k == key })
	}
	c.cache[key] = remembered{username, now.Add(cacheFor)}
	c.order = append(c.order, key)
	for len(c.order) > cacheEntries {
		delete(c.cache, c.order[0])
		c.order = c.order[1:]
	}
	return username, nil
}

// Interceptor refuses every call but an allowed caller's.
func (c *Callers) Interceptor() connect.Interceptor {
	return connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if _, err := c.Caller(ctx, req.Header().Get("Authorization")); err != nil {
				return nil, err
			}
			return next(ctx, req)
		}
	})
}
