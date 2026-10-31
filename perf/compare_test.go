// SPDX-License-Identifier: MIT
package main

import (
	"strings"
	"testing"
)

func TestCompareFlagsOnlyClearRegressions(t *testing.T) {
	base := report{RunID: "a", Workload: workload{Scenario: "burst", DAGs: 100, Steps: 1}, TasksPerSec: 3.8,
		EndToEnd: stats{N: 100, P50: 10000, P95: 20000}, QueueWait: stats{N: 100, P50: 200, P95: 400}}

	same := base
	same.RunID, same.EndToEnd.P50, same.QueueWait.P50 = "b", 11000, 600 // 10% slower; 3× but under half a second
	var out strings.Builder
	if n := compare(&out, base, same); n != 0 {
		t.Errorf("noise counted: %d\n%s", n, out.String())
	}

	worse := base
	worse.RunID, worse.EndToEnd.P50, worse.TasksPerSec = "c", 14000, 2.5
	out.Reset()
	if n := compare(&out, base, worse); n != 2 {
		t.Errorf("regressions = %d, want 2 (end to end, steps/s)\n%s", n, out.String())
	}

	wrong := base
	wrong.RunID, wrong.Problems = "d", []string{"DAG 3: never finished"}
	out.Reset()
	if n := compare(&out, base, wrong); n != 1 || !strings.Contains(out.String(), "never finished") {
		t.Errorf("an incorrect run: %d\n%s", n, out.String())
	}
}
