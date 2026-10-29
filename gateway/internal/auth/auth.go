// SPDX-License-Identifier: MIT

// Package auth signs a gateway caller in exactly as the console does
// (console/src/auth/plugin.ts, kept in step): a person's session JWT
// (EdDSA, checked with the console's public key, keys.go: the gateway can
// verify a session but never make one; one issued before the account's
// last password change, or signed out, is revoked), or a bot's API token
// (mp_..., found by its SHA-256 in api_tokens, unless revoked or expired). The caller's teams are read from
// the console's database on every request, so a membership change counts at
// once. A token is never logged or kept.
package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// APITokenPrefix marks a bot's API token (console/src/auth/apiToken.ts).
const APITokenPrefix = "mp_"

// Caller is who's calling.
type Caller struct {
	UserID  string
	Email   string
	IsAdmin bool
	IsBot   bool
	// Teams are the teams the caller is in.
	Teams []string
}

// ErrUnauthenticated is a missing, malformed, expired or revoked credential.
var ErrUnauthenticated = errors.New("missing, invalid, expired or revoked credential")

// DB is what the lookups run on (a pool).
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Resolver signs callers in.
type Resolver struct {
	DB DB
	// The console's session keys (ConsoleKeys).
	Keys Keys
	// SSO: the console signs people in with single sign-on, so a password's
	// session is refused for someone a team requires it of (as the
	// console's auth/plugin.ts does; admins are exempt).
	SSO bool
	Now func() time.Time
}

// Resolve turns an Authorization header into its caller.
func (r *Resolver) Resolve(ctx context.Context, authorization string) (*Caller, error) {
	bearer, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || bearer == "" {
		return nil, ErrUnauthenticated
	}
	var c Caller
	var passwordChanged *time.Time
	var mustChangePassword bool
	passwordSession := false
	if strings.HasPrefix(bearer, APITokenPrefix) {
		sum := sha256.Sum256([]byte(bearer))
		err := r.DB.QueryRow(ctx, `SELECT u.id::text, u.email, u.is_admin, u.is_bot FROM api_tokens t
			JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL
			AND (t.expires_at IS NULL OR t.expires_at > now())`, hex.EncodeToString(sum[:])).
			Scan(&c.UserID, &c.Email, &c.IsAdmin, &c.IsBot)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			return nil, err
		}
	} else {
		claims, err := r.verifyJWT(ctx, bearer)
		if errors.Is(err, ErrUnauthenticated) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			// The console's keys couldn't be read: not the caller's fault.
			return nil, err
		}
		err = r.DB.QueryRow(ctx, `SELECT id::text, email, is_admin, is_bot, password_changed_at, must_change_password FROM users WHERE id::text = $1`, claims.UserID).
			Scan(&c.UserID, &c.Email, &c.IsAdmin, &c.IsBot, &passwordChanged, &mustChangePassword)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			return nil, err
		}
		// Whole seconds, as the console compares: the token a password
		// change issues in the same second still counts.
		if passwordChanged != nil && claims.IssuedAt < passwordChanged.Unix() {
			return nil, ErrUnauthenticated
		}
		// Signed out before it expired (the console's AuthService.SignOut).
		if claims.SessionID != "" {
			var revoked bool
			if err := r.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = $1)`, claims.SessionID).Scan(&revoked); err != nil {
				return nil, err
			}
			if revoked {
				return nil, ErrUnauthenticated
			}
		}
		passwordSession = !claims.SSO
		// A password someone else set: the console allows nothing but
		// changing it, and neither does the gateway.
		if passwordSession && mustChangePassword {
			return nil, ErrUnauthenticated
		}
	}
	rows, err := r.DB.Query(ctx, `SELECT t.name, t.require_sso FROM team_memberships m JOIN teams t ON t.id = m.team_id
		WHERE m.user_id::text = $1 ORDER BY t.name`, c.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ssoRequired := false
	for rows.Next() {
		var team string
		var requireSSO bool
		if err := rows.Scan(&team, &requireSSO); err != nil {
			return nil, err
		}
		c.Teams = append(c.Teams, team)
		ssoRequired = ssoRequired || requireSSO
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if r.SSO && passwordSession && ssoRequired && !c.IsAdmin {
		return nil, ErrUnauthenticated
	}
	return &c, nil
}

type claims struct {
	UserID string `json:"userId"`
	// Made by single sign-on, not a password.
	SSO bool `json:"sso"`
	// The session's id, which signing out revokes; empty on older sessions.
	SessionID string `json:"sid"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// verifyJWT checks an EdDSA JWT signed with the console's session key, and
// that it hasn't expired.
func (r *Resolver) verifyJWT(ctx context.Context, token string) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrUnauthenticated
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodeSegment(parts[0], &header); err != nil || header.Alg != "EdDSA" || header.Kid == "" {
		return nil, ErrUnauthenticated
	}
	key, err := r.Keys.Key(ctx, header.Kid)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, ErrUnauthenticated
	}
	var c claims
	if err := decodeSegment(parts[1], &c); err != nil || c.UserID == "" {
		return nil, ErrUnauthenticated
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	if c.ExpiresAt == 0 || now().Unix() >= c.ExpiresAt {
		return nil, ErrUnauthenticated
	}
	return &c, nil
}

func decodeSegment(segment string, into any) error {
	data, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}
