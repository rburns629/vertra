// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/rburns629/vertra/kernel/internal/domain"
)

// Ported from the Python kernel's tests/unit/test_scheduler_{concurrency,shutdown}.py.
// Waiting for the schema is tested in internal/migrate.

func TestCallsOverlapUpToTheLimitAndResultsKeepTheirOrder(t *testing.T) {
	var inFlight, most atomic.Int32
	items := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
	results, errs := gather(context.Background(), items, 4, func(v int) (int, error) {
		n := inFlight.Add(1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		inFlight.Add(-1)
		return v, nil
	})
	equal(t, "results", results, items)
	equal(t, "errors", errs, make([]error, 10))
	equal(t, "most in flight", most.Load(), 4)
}

func TestAFailingCallYieldsItsErrorWithoutStoppingTheRest(t *testing.T) {
	results, errs := gather(context.Background(), []string{"ok", "boom", "ok"}, 2, func(s string) (string, error) {
		if s == "boom" {
			return "", errors.New("boom")
		}
		return s, nil
	})
	equal(t, "results", []string{results[0], results[2]}, []string{"ok", "ok"})
	equal(t, "error", errs[1] != nil && errs[0] == nil && errs[2] == nil, true)
}

// Ported from test_scheduler_shutdown.py, end to end: told to stop, the
// loop cuts its wait short, finishes, and hands back its leases.
func TestStoppingCutsTheWaitShortAndReleasesLeases(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, fmt.Sprintf("loop-stop-%d", time.Now().UnixNano()), task("only"))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })

	exec := fake()
	owner := fmt.Sprintf("loop-test-%d", time.Now().UnixNano())
	loop := &Loop{Pool: testPool, Executor: exec, Options: DefaultOptions(owner), PollInterval: time.Minute,
		RetentionDays: 36500, HeartbeatFile: filepath.Join(t.TempDir(), "heartbeat"), Log: quietLog}
	run, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- loop.Run(run) }()
	deadline := time.Now().Add(10 * time.Second)
	for tasksByKey(t, testPool, id)["only"].State != domain.TaskRunning {
		if time.Now().After(deadline) {
			t.Fatal("never dispatched")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(loop.HeartbeatFile); err != nil {
		t.Errorf("no heartbeat: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // into its minute-long wait
	stopped := time.Now()
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting")
	}
	equal(t, "stopped promptly", time.Since(stopped) < 2*time.Second, true)
	tk := tasksByKey(t, testPool, id)["only"]
	equal(t, "still running", tk.State, domain.TaskRunning)
	// Expired, not cleared: the next scheduler adopts it at once.
	equal(t, "lease handed back", tk.LeaseExpiresAt != nil && !tk.LeaseExpiresAt.After(time.Now()), true)
}
