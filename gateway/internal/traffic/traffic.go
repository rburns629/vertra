// SPDX-License-Identifier: MIT

// Package traffic counts what the gateway did with each API's requests, a
// minute at a time, by calling team, endpoint and outcome, and adds the
// counts to the console's api_traffic table every so often (the API's page
// shows them). The only thing the gateway writes. No caller's identity,
// body or header is kept.
package traffic

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxEndpoint is the most of a blocked request's "METHOD /path" kept.
const MaxEndpoint = 160

type key struct {
	api, team, endpoint, outcome string
	minute                       time.Time
}

type counts struct {
	n          int
	durationMs int64
}

// Recorder holds counts until they're flushed.
type Recorder struct {
	DB interface {
		Begin(context.Context) (pgx.Tx, error)
	}
	Log *slog.Logger

	mu      sync.Mutex
	pending map[key]counts
}

// Record counts one request.
func (r *Recorder) Record(apiID, team, endpoint, outcome string, at time.Time, took time.Duration) {
	if len(endpoint) > MaxEndpoint {
		endpoint = endpoint[:MaxEndpoint]
	}
	k := key{api: apiID, team: team, endpoint: endpoint, outcome: outcome, minute: at.UTC().Truncate(time.Minute)}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending == nil {
		r.pending = map[key]counts{}
	}
	c := r.pending[k]
	c.n++
	c.durationMs += took.Milliseconds()
	r.pending[k] = c
}

// Flush adds what's pending to api_traffic, in one transaction; what can't
// be written stays pending for the next flush.
func (r *Recorder) Flush(ctx context.Context) error {
	r.mu.Lock()
	batch := r.pending
	r.pending = nil
	r.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	err := pgx.BeginFunc(ctx, txStarter{r.DB}, func(tx pgx.Tx) error {
		for k, c := range batch {
			// An API deleted meanwhile has no row to count against: skipped.
			if _, err := tx.Exec(ctx, `INSERT INTO api_traffic (api_id, minute, team, endpoint, outcome, count, duration_ms)
				SELECT $1::uuid, $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM apis WHERE id = $1::uuid)
				ON CONFLICT (api_id, minute, team, endpoint, outcome) DO UPDATE
				SET count = api_traffic.count + EXCLUDED.count, duration_ms = api_traffic.duration_ms + EXCLUDED.duration_ms`,
				k.api, k.minute, k.team, k.endpoint, k.outcome, c.n, c.durationMs); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		r.mu.Lock()
		if r.pending == nil {
			r.pending = map[key]counts{}
		}
		for k, c := range batch {
			p := r.pending[k]
			p.n += c.n
			p.durationMs += c.durationMs
			r.pending[k] = p
		}
		r.mu.Unlock()
	}
	return err
}

type txStarter struct {
	db interface {
		Begin(context.Context) (pgx.Tx, error)
	}
}

func (t txStarter) Begin(ctx context.Context) (pgx.Tx, error) { return t.db.Begin(ctx) }

// Run flushes every interval until ctx ends, then once more.
func (r *Recorder) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := r.Flush(flush); err != nil {
				r.Log.Error("couldn't record the last traffic", "error", err)
			}
			cancel()
			return
		case <-t.C:
			if err := r.Flush(ctx); err != nil {
				r.Log.Error("couldn't record traffic; kept for the next try", "error", err)
			}
		}
	}
}
