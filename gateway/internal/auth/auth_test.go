// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Against the console's real, migrated test database (TEST_DATABASE_URL,
// execution_console_test), in a transaction rolled back after: the same
// rules as console/src/auth/plugin.ts.

var secret = []byte("test-secret")

func jwt(t *testing.T, key []byte, alg string, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	signing := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func tx(t *testing.T) pgx.Tx {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	conn, err := pgx.Connect(context.Background(), url)
	if err != nil {
		t.Fatalf("the console's test database (TEST_DATABASE_URL): %v", err)
	}
	tx, err := conn.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(context.Background())
		_ = conn.Close(context.Background())
	})
	return tx
}

func TestCallersSignInAsTheyDoAtTheConsole(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var userID, botID, teamID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_admin) VALUES ('gw-person@example.com', false) RETURNING id::text`).Scan(&userID))
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_bot) VALUES ('gw-bot@bots.vertra.local', true) RETURNING id::text`).Scan(&botID))
	must(db.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-test-web') RETURNING id::text`).Scan(&teamID))
	for _, id := range []string{userID, botID} {
		_, err := db.Exec(ctx, `INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, 'member')`, id, teamID)
		must(err)
	}
	token := APITokenPrefix + "abc123"
	sum := sha256.Sum256([]byte(token))
	_, err := db.Exec(ctx, `INSERT INTO api_tokens (user_id, label, token_hash) VALUES ($1, 'ci', $2)`, botID, hex.EncodeToString(sum[:]))
	must(err)

	now := time.Now()
	r := &Resolver{DB: db, JWTSecret: secret, Now: func() time.Time { return now }}
	session := jwt(t, secret, "HS256", map[string]any{"userId": userID, "iat": now.Unix() - 60, "exp": now.Unix() + 3600})
	who, err := r.Resolve(ctx, "Bearer "+session)
	if err != nil || who.UserID != userID || who.Email != "gw-person@example.com" || len(who.Teams) != 1 || who.Teams[0] != "gw-test-web" {
		t.Fatalf("a session: %+v, %v", who, err)
	}
	bot, err := r.Resolve(ctx, "Bearer "+token)
	if err != nil || bot.UserID != botID || !bot.IsBot || bot.Teams[0] != "gw-test-web" {
		t.Fatalf("a bot token: %+v, %v", bot, err)
	}

	for name, header := range map[string]string{
		"nothing":            "",
		"not a bearer":       "Basic " + session,
		"another secret":     "Bearer " + jwt(t, []byte("other"), "HS256", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}),
		"expired":            "Bearer " + jwt(t, secret, "HS256", map[string]any{"userId": userID, "iat": now.Unix() - 7200, "exp": now.Unix() - 1}),
		"no expiry":          "Bearer " + jwt(t, secret, "HS256", map[string]any{"userId": userID, "iat": now.Unix()}),
		"alg none":           "Bearer " + jwt(t, secret, "none", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}),
		"an unknown token":   "Bearer " + APITokenPrefix + "nope",
		"an unknown account": "Bearer " + jwt(t, secret, "HS256", map[string]any{"userId": "00000000-0000-0000-0000-000000000000", "iat": now.Unix(), "exp": now.Unix() + 60}),
	} {
		if _, err := r.Resolve(ctx, header); err != ErrUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}

	// A password change revokes sessions issued before it (in whole seconds).
	_, err = db.Exec(ctx, `UPDATE users SET password_changed_at = $2 WHERE id = $1`, userID, now)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+session); err != ErrUnauthenticated {
		t.Errorf("a session from before the password change: %v", err)
	}
	same := jwt(t, secret, "HS256", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60})
	if _, err := r.Resolve(ctx, "Bearer "+same); err != nil {
		t.Errorf("the session the change issued, in the same second: %v", err)
	}
	// A revoked token.
	_, err = db.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1`, botID)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+token); err != ErrUnauthenticated {
		t.Errorf("a revoked token: %v", err)
	}
}
