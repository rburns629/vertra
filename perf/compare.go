// SPDX-License-Identifier: MIT
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// Worse than this, a measure counts as a regression: kind's timings vary
// from run to run, so only a clear change is one.
const (
	regressionRatio = 1.25
	// Nor a change smaller than this, in milliseconds, however large a ratio.
	regressionFloorMs = 500
)

func readReport(path string) (report, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return report{}, err
	}
	var file struct {
		Report report `json:"report"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return report{}, fmt.Errorf("%s: %w", path, err)
	}
	return file.Report, nil
}

// compare writes two runs' measures side by side, and returns how many of
// them got clearly worse: a p50 or p95 time up by a quarter (and half a
// second), throughput down by a quarter, or the newer run incorrect.
func compare(w io.Writer, before, after report) int {
	regressions := 0
	mark := func(worse bool) string {
		if worse {
			regressions++
			return " **worse**"
		}
		return ""
	}
	slower := func(a, b float64) bool { return b > a*regressionRatio && b-a > regressionFloorMs }

	fmt.Fprintf(w, "# perf compared: %s %s → %s %s\n\n", before.RunID, before.Workload.Scenario, after.RunID, after.Workload.Scenario)
	if before.Workload.Scenario != after.Workload.Scenario || before.Workload.DAGs != after.Workload.DAGs || before.Workload.Steps != after.Workload.Steps {
		fmt.Fprintf(w, "Different workloads (%s %d×%d, %s %d×%d): read with care.\n\n",
			before.Workload.Scenario, before.Workload.DAGs, before.Workload.Steps, after.Workload.Scenario, after.Workload.DAGs, after.Workload.Steps)
	}
	fmt.Fprintf(w, "Commits %.12s → %.12s.\n\n| | before | after | |\n| --- | ---: | ---: | --- |\n", before.Environment.GitCommit, after.Environment.GitCommit)
	fmt.Fprintf(w, "| steps/s | %.2f | %.2f |%s |\n", before.TasksPerSec, after.TasksPerSec, mark(after.TasksPerSec < before.TasksPerSec/regressionRatio))
	for _, row := range []struct {
		name string
		a, b stats
	}{
		{"submit", before.Submit, after.Submit},
		{"end to end", before.EndToEnd, after.EndToEnd},
		{"queue wait", before.QueueWait, after.QueueWait},
		{"container start", before.ContainerStart, after.ContainerStart},
		{"completion lag", before.CompletionLag, after.CompletionLag},
		{"list runs (readers)", before.ListRuns, after.ListRuns},
		{"get a run (readers)", before.GetRun, after.GetRun},
	} {
		if row.a.N == 0 && row.b.N == 0 {
			continue
		}
		fmt.Fprintf(w, "| %s p50 ms | %.0f | %.0f |%s |\n", row.name, row.a.P50, row.b.P50, mark(slower(row.a.P50, row.b.P50)))
		fmt.Fprintf(w, "| %s p95 ms | %.0f | %.0f |%s |\n", row.name, row.a.P95, row.b.P95, mark(slower(row.a.P95, row.b.P95)))
	}
	if len(after.Problems) > 0 {
		regressions++
		fmt.Fprintf(w, "\nThe newer run had %d correctness problem(s): %s\n", len(after.Problems), strings.Join(after.Problems[:min(3, len(after.Problems))], "; "))
	}
	if regressions == 0 {
		fmt.Fprintln(w, "\nNo regression.")
	} else {
		fmt.Fprintf(w, "\n%d regression(s).\n", regressions)
	}
	return regressions
}

// compareCommand is `go run . compare <before.json> <after.json>`: exits 1
// on a regression.
func compareCommand(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: compare <before.json> <after.json>")
	}
	before, err := readReport(args[0])
	if err != nil {
		return err
	}
	after, err := readReport(args[1])
	if err != nil {
		return err
	}
	if n := compare(os.Stdout, before, after); n > 0 {
		return fmt.Errorf("%d regression(s)", n)
	}
	return nil
}
