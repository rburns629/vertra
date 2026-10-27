// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// countingDB counts the round trips a pass makes.
type countingDB struct {
	DB
	calls int
}

func (c *countingDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	c.calls++
	return c.DB.Exec(ctx, sql, args...)
}

func (c *countingDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.calls++
	return c.DB.Query(ctx, sql, args...)
}

func (c *countingDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.calls++
	return c.DB.QueryRow(ctx, sql, args...)
}

// A pass over steps that are still running costs a few round trips, not a
// few per step: the database work for each is batched.
func TestPollingRunningStepsIsBatched(t *testing.T) {
	tx := txFor(t)
	const n = 30
	defs := make([]TaskDef, n)
	for i := range defs {
		defs[i] = task(fmt.Sprintf("step-%d", i))
	}
	submit(t, tx, "roundtrips", defs...)
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.ClaimLimit = n
	now := time.Now()
	k.tick(now) // claims and starts them all

	counted := &countingDB{DB: tx}
	started := time.Now()
	if _, err := RunTick(context.Background(), counted, exec, k.opts, now.Add(time.Second), quietLog); err != nil {
		t.Fatal(err)
	}
	t.Logf("polling %d running steps: %d round trips, %s", n, counted.calls, time.Since(started))
	if counted.calls > 12 {
		t.Errorf("polling %d running steps took %d round trips; want a few for the whole pass", n, counted.calls)
	}
}

// Starting steps: a handful of round trips per step started (its claim and
// its start), the pass's events written at once.
func TestStartingStepsRoundTrips(t *testing.T) {
	tx := txFor(t)
	const n = 30
	defs := make([]TaskDef, n)
	for i := range defs {
		defs[i] = task(fmt.Sprintf("step-%d", i))
	}
	submit(t, tx, "roundtrips-start", defs...)
	exec := fake()
	opts := DefaultOptions("scheduler-1")
	opts.ClaimLimit = n
	counted := &countingDB{DB: tx}
	started := time.Now()
	if _, err := RunTick(context.Background(), counted, exec, opts, time.Now(), quietLog); err != nil {
		t.Fatal(err)
	}
	t.Logf("starting %d steps: %d round trips (%.1f each), %s", n, counted.calls, float64(counted.calls)/n, time.Since(started))
	if len(exec.Started) != n {
		t.Fatalf("started %d", len(exec.Started))
	}
	if counted.calls > 6*n {
		t.Errorf("starting %d steps took %d round trips; want at most 6 each", n, counted.calls)
	}
}
