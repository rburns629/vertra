// SPDX-License-Identifier: MIT

package traffic

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Against the console's real, migrated test database (TEST_DATABASE_URL).
func TestCountsAddUpInTheConsolesTable(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var teamID, apiID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-traffic-' || substr(md5(random()::text), 1, 6)) RETURNING id::text`).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID) })
	if err := pool.QueryRow(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', '{}', 'https://x', 'orders-api') RETURNING id::text`, teamID).Scan(&apiID); err != nil {
		t.Fatal(err)
	}
	r := &Recorder{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	at := time.Date(2026, 10, 22, 12, 30, 15, 0, time.UTC)
	for range 3 {
		r.Record(apiID, "web", "GET /orders/{id}", "forwarded_2xx", at, 20*time.Millisecond)
	}
	r.Record(apiID, "web", "DELETE /orders/1", "blocked", at.Add(10*time.Second), time.Millisecond)
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	r.Record(apiID, "web", "GET /orders/{id}", "forwarded_2xx", at.Add(20*time.Second), 40*time.Millisecond)
	r.Record("00000000-0000-0000-0000-000000000000", "web", "GET /x", "blocked", at, 0) // a deleted API: skipped
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	var ms int64
	if err := pool.QueryRow(ctx, `SELECT count, duration_ms FROM api_traffic WHERE api_id = $1::uuid AND outcome = 'forwarded_2xx'
		AND minute = '2026-10-22T12:30:00Z'`, apiID).Scan(&count, &ms); err != nil || count != 4 || ms != 100 {
		t.Errorf("forwarded: %d in %d ms, %v", count, ms, err)
	}
	var blocked int
	_ = pool.QueryRow(ctx, `SELECT count FROM api_traffic WHERE api_id = $1::uuid AND endpoint = 'DELETE /orders/1'`, apiID).Scan(&blocked)
	if blocked != 1 {
		t.Errorf("blocked: %d", blocked)
	}
}
