// SPDX-License-Identifier: MIT

package scheduler

import (
	"testing"
	"time"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
)

// A product's cap: at most so many of its steps claimed or running at once,
// across its actions and runs; the rest wait READY, and another product's
// steps aren't held by it.
func TestAProductsCapHoldsItsExtraSteps(t *testing.T) {
	tx := txFor(t)
	cap2 := capped("teams/web/products/site", 2)
	first := submit(t, tx, "cap-first", task("a", cap2), task("b", cap2))
	second := submit(t, tx, "cap-second", task("c", cap2), task("other", capped("teams/web/products/db", 2)))
	exec := fake()
	k := newTicker(t, tx, exec)
	now := time.Now()
	k.tick(now)

	states := map[string]domain.TaskState{}
	for _, id := range []string{first, second} {
		for key, tk := range tasksByKey(t, tx, id) {
			states[key] = tk.State
		}
	}
	held := 0
	for _, key := range []string{"a", "b", "c"} {
		if states[key] == domain.TaskReady {
			held++
		}
	}
	equal(t, "one of the product's three waits", held, 1)
	equal(t, "another product's step isn't held", states["other"], domain.TaskRunning)

	// One finishes: the waiting one may run.
	var done executor.Handle
	for _, id := range []string{first, second} {
		for key, tk := range tasksByKey(t, tx, id) {
			if key != "other" && tk.State == domain.TaskRunning && done == nil {
				done = tk.ExecutorHandle
			}
		}
	}
	exec.Complete(done, map[string]any{})
	k.tick(now.Add(time.Second))
	k.tick(now.Add(2 * time.Second))
	running := 0
	for _, id := range []string{first, second} {
		for key, tk := range tasksByKey(t, tx, id) {
			if key != "other" && tk.State == domain.TaskRunning {
				running++
			}
		}
	}
	equal(t, "two running again", running, 2)
}
