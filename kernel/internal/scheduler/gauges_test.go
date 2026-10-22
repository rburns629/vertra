// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/rburns629/vertra/kernel/internal/metrics"
)

// The gauges count unfinished tasks by state and age the oldest READY one.
// Measured as a difference, so rows other tests committed don't matter.
func TestSampleTasksCountsUnfinishedTasks(t *testing.T) {
	tx := txFor(t)
	ctx := context.Background()
	gauge := func(state string) float64 { return testutil.ToFloat64(metrics.Tasks.WithLabelValues(state)) }

	if err := SampleTasks(ctx, tx, time.Now()); err != nil {
		t.Fatal(err)
	}
	ready, claimed := gauge("READY"), gauge("CLAIMED")

	submit(t, tx, "idem-gauges", numbered(3)...)
	claim(t, tx, "scheduler-1", time.Minute, time.Now(), limit(1))
	if err := SampleTasks(ctx, tx, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	equal(t, "ready", gauge("READY")-ready, 2.0)
	equal(t, "claimed", gauge("CLAIMED")-claimed, 1.0)
	equal(t, "running reported though 0", testutil.CollectAndCount(metrics.Tasks) >= 5, true)
	equal(t, "oldest ready waited about an hour", testutil.ToFloat64(metrics.OldestReady) >= 3599, true)
}
