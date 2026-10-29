// SPDX-License-Identifier: MIT

package dbauth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/rds/auth"
)

// rdsTokenKept is how long an RDS sign-in token is used: it's good for 15
// minutes, and only to open a connection (an open one isn't affected).
const rdsTokenKept = 10 * time.Minute

// RDS gives out Amazon RDS IAM database authentication tokens: the
// workload's own role (EKS Pod Identity, which AWS's SDK finds by itself)
// signs, locally, a token for one user at one server.
type RDS struct {
	Region      string
	Credentials aws.CredentialsProvider
	Now         func() time.Time

	mu     sync.Mutex
	tokens map[string]rdsToken
}

type rdsToken struct {
	value   string
	expires time.Time
}

// AWS is the token source an EKS workload uses, in region.
func AWS(ctx context.Context, region string) (*RDS, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("the database sign-in's AWS credentials: %w", err)
	}
	return &RDS{Region: region, Credentials: cfg.Credentials, Now: time.Now}, nil
}

// Password is the token to sign in to host:port as user with now.
func (r *RDS) Password(ctx context.Context, host string, port uint16, user string) (string, error) {
	key := fmt.Sprintf("%s:%d/%s", host, port, user)
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.tokens[key]; ok && r.Now().Before(t.expires) {
		return t.value, nil
	}
	token, err := auth.BuildAuthToken(ctx, fmt.Sprintf("%s:%d", host, port), r.Region, user, r.Credentials)
	if err != nil {
		return "", fmt.Errorf("the database sign-in token: %w", err)
	}
	if r.tokens == nil {
		r.tokens = map[string]rdsToken{}
	}
	r.tokens[key] = rdsToken{value: token, expires: r.Now().Add(rdsTokenKept)}
	return token, nil
}
