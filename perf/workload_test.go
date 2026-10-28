// SPDX-License-Identifier: MIT
package main

import (
	"slices"
	"testing"
	"time"
)

func TestShapesWireTheirSteps(t *testing.T) {
	deps := func(s shape, steps int) [][]string {
		d := workload{Shape: s, Steps: steps}.build("r", 0, "img", "perf")
		var out [][]string
		for _, task := range d.Tasks {
			out = append(out, task.DependsOn)
		}
		return out
	}
	if got := deps(chain, 3); !slices.EqualFunc(got, [][]string{nil, {"s0"}, {"s1"}}, slices.Equal) {
		t.Errorf("chain: %v", got)
	}
	if got := deps(wide, 3); !slices.EqualFunc(got, [][]string{nil, nil, nil}, slices.Equal) {
		t.Errorf("wide: %v", got)
	}
	if got := deps(fanout, 4); !slices.EqualFunc(got, [][]string{nil, {"s0"}, {"s0"}, {"s1", "s2"}}, slices.Equal) {
		t.Errorf("fanout: %v", got)
	}
	d := workload{Shape: single, Steps: 1, SleepMs: 5, Fail: "never"}.build("r", 7, "img", "perf")
	if d.RequestID != "perf-r-7" || d.Tasks[0].Inputs["label"] != "r/7/0" {
		t.Errorf("dag: %+v", d)
	}
}

func TestWorkloadsAreCapped(t *testing.T) {
	ok := workload{Shape: chain, DAGs: 10, Steps: 20, Fail: "never", Concurrency: 8}
	if err := ok.check(false); err != nil {
		t.Fatal(err)
	}
	for name, w := range map[string]workload{
		"too many DAGs":      {Shape: single, DAGs: 501, Steps: 1, Fail: "never", Concurrency: 1},
		"large, not asked":   {Shape: fanout, DAGs: 200, Steps: 10, Fail: "never", Concurrency: 1},
		"a single of two":    {Shape: single, DAGs: 1, Steps: 2, Fail: "never", Concurrency: 1},
		"too long a sleep":   {Shape: single, DAGs: 1, Steps: 1, SleepMs: 60001, Fail: "never", Concurrency: 1},
		"an unknown failure": {Shape: single, DAGs: 1, Steps: 1, Fail: "sometimes", Concurrency: 1},
	} {
		if w.check(false) == nil {
			t.Errorf("%s: allowed", name)
		}
	}
	if (workload{Shape: fanout, DAGs: 200, Steps: 10, Fail: "never", Concurrency: 1}).check(true) != nil {
		t.Error("a large run asked for was refused")
	}
}

func TestPercentiles(t *testing.T) {
	var d []time.Duration
	for i := 1; i <= 100; i++ {
		d = append(d, time.Duration(i)*time.Millisecond)
	}
	s := summarize(d)
	if s.P50 != 50 || s.P95 != 95 || s.P99 != 99 || s.Max != 100 || s.N != 100 {
		t.Errorf("%+v", s)
	}
}
