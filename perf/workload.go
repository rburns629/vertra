// SPDX-License-Identifier: MIT
package main

import (
	"fmt"
	"strconv"
)

// Hard caps: no flag goes past them, so an ordinary run can't overwhelm the
// machine. Larger runs need -allow-large, and still stop here.
const (
	maxDags     = 500
	maxSteps    = 50
	maxTasks    = 5000
	maxSleepMs  = 60000
	largeTasks  = 1000
	maxSubmitRe = 64
)

type shape string

const (
	single shape = "single" // one step
	chain  shape = "chain"  // each step after the one before
	wide   shape = "wide"   // every step at once
	fanout shape = "fanout" // one, then the middle at once, then one joining them
)

// workload is one benchmark's DAGs: how many, their shape and steps.
type workload struct {
	Scenario    string `json:"scenario"`
	Shape       shape  `json:"shape"`
	DAGs        int    `json:"dags"`
	Steps       int    `json:"steps"`
	SleepMs     int    `json:"sleepMs"`
	Fail        string `json:"fail"`
	Concurrency int    `json:"concurrency"`
	// Submissions a second, across every submitter; 0: as fast as they go.
	Rate float64 `json:"rate"`
	// Each run cancelled this long after it was submitted; 0: none are.
	CancelAfterMs int `json:"cancelAfterMs,omitempty"`
}

// scenarios is the starting matrix (README.md): starting points, not targets.
var scenarios = map[string]workload{
	"baseline":   {Shape: single, DAGs: 10, Steps: 1},
	"burst":      {Shape: single, DAGs: 100, Steps: 1},
	"dependency": {Shape: chain, DAGs: 10, Steps: 20},
	"sustained":  {Shape: fanout, DAGs: 100, Steps: 10},
	"higher":     {Shape: fanout, DAGs: 500, Steps: 10},
}

func (w workload) tasks() int { return w.DAGs * w.Steps }

// check refuses a workload past the caps, or a large one not asked for.
func (w workload) check(allowLarge bool) error {
	switch {
	case w.DAGs < 1 || w.DAGs > maxDags:
		return fmt.Errorf("dags: 1 to %d", maxDags)
	case w.Steps < 1 || w.Steps > maxSteps:
		return fmt.Errorf("steps: 1 to %d", maxSteps)
	case w.Shape == single && w.Steps != 1:
		return fmt.Errorf("a single-step DAG has 1 step")
	case w.Shape == fanout && w.Steps < 3:
		return fmt.Errorf("a fan-out has at least 3 steps")
	case w.tasks() > maxTasks:
		return fmt.Errorf("%d steps in all: at most %d", w.tasks(), maxTasks)
	case w.tasks() > largeTasks && !allowLarge:
		return fmt.Errorf("%d steps in all is a large run: add -allow-large to mean it", w.tasks())
	case w.SleepMs < 0 || w.SleepMs > maxSleepMs:
		return fmt.Errorf("sleep-ms: 0 to %d", maxSleepMs)
	case w.Concurrency < 1 || w.Concurrency > maxSubmitRe:
		return fmt.Errorf("concurrency: 1 to %d", maxSubmitRe)
	case w.Fail != "never" && w.Fail != "always" && w.Fail != "first-attempt":
		return fmt.Errorf("fail: never, always or first-attempt")
	}
	switch w.Shape {
	case single, chain, wide, fanout:
		return nil
	}
	return fmt.Errorf("shape: single, chain, wide or fanout")
}

// build is DAG i of the run: steps of the no-op product, wired by shape.
func (w workload) build(runID string, i int, image, team string) dag {
	d := dag{Name: fmt.Sprintf("perf-%s-%d", w.Scenario, i), RequestID: fmt.Sprintf("perf-%s-%d", runID, i)}
	id := func(n int) string { return "s" + strconv.Itoa(n) }
	for n := 0; n < w.Steps; n++ {
		t := taskDefinition{
			ID: id(n), Image: image, Action: "run", Team: team,
			Inputs: map[string]any{"sleepMs": w.SleepMs, "fail": w.Fail, "label": fmt.Sprintf("%s/%d/%d", runID, i, n)},
		}
		switch {
		case w.Shape == chain && n > 0:
			t.DependsOn = []string{id(n - 1)}
		case w.Shape == fanout && n > 0 && n < w.Steps-1:
			t.DependsOn = []string{id(0)}
		case w.Shape == fanout && n == w.Steps-1:
			for m := 1; m < w.Steps-1; m++ {
				t.DependsOn = append(t.DependsOn, id(m))
			}
		}
		d.Tasks = append(d.Tasks, t)
	}
	return d
}
