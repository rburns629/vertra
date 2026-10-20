// SPDX-License-Identifier: MIT

package domain

import (
	"fmt"
	"slices"
	"sort"
	"strings"
)

// TaskDef is one task as submitted, already checked field by field
// (kernel-api's edge): what the DAG checks and the database rows need.
type TaskDef struct {
	ID             string
	Image          string
	Action         string
	DependsOn      []string
	Inputs         map[string]any
	TimeoutSeconds int
	MaxAttempts    int
	Team           string
	ServiceAccount string
	SecretRefs     []string
	Resources      *TaskResources
}

// InitialState is READY for a task with no dependencies, else BLOCKED.
func (t TaskDef) InitialState() TaskState {
	if len(t.DependsOn) > 0 {
		return TaskBlocked
	}
	return TaskReady
}

// ValidationIssue is one thing wrong with a submitted DAG.
type ValidationIssue struct {
	Code    string
	Message string
	TaskID  string // "" when it's about the whole DAG
}

// DAGValidationError carries every issue found, so one round trip reports
// everything wrong.
type DAGValidationError struct{ Issues []ValidationIssue }

func (e *DAGValidationError) Error() string {
	messages := make([]string, len(e.Issues))
	for i, issue := range e.Issues {
		messages[i] = issue.Message
	}
	return fmt.Sprintf("DAG validation failed with %d issue(s): %s", len(e.Issues), strings.Join(messages, "; "))
}

// ValidateDAG checks a submitted DAG before anything is stored: no tasks or
// too many, duplicate ids, unknown, self or repeated dependencies, cycles,
// $fromTask references to anything but a direct dependency, and inputs
// that look like credentials. It returns a deterministic topological
// order, or a *DAGValidationError with every issue found. Checks that need
// a well-formed graph are skipped once a structural issue makes it
// ambiguous, rather than report misleading follow-on errors.
func ValidateDAG(tasks []TaskDef, maxTasks int) ([]string, error) {
	if len(tasks) == 0 {
		return nil, &DAGValidationError{[]ValidationIssue{{Code: "EMPTY_DAG", Message: "An execution must contain at least one task."}}}
	}
	var issues []ValidationIssue
	if len(tasks) > maxTasks {
		issues = append(issues, ValidationIssue{Code: "MAX_TASK_COUNT_EXCEEDED",
			Message: fmt.Sprintf("Execution contains %d tasks, exceeding the maximum of %d.", len(tasks), maxTasks)})
	}
	for _, id := range duplicateIDs(tasks) {
		issues = append(issues, ValidationIssue{Code: "DUPLICATE_TASK_ID", Message: fmt.Sprintf("Task id '%s' is defined more than once.", id), TaskID: id})
	}
	if len(issues) > 0 {
		// Ambiguous id lookups (or a pointless oversized list): every check
		// below assumes neither.
		return nil, &DAGValidationError{issues}
	}
	known := map[string]bool{}
	for _, t := range tasks {
		known[t.ID] = true
	}
	if dependency := dependencyIssues(tasks, known); len(dependency) > 0 {
		// Cycle detection assumes every edge points at a real, distinct task.
		return nil, &DAGValidationError{dependency}
	}
	issues = append(issues, referenceIssues(tasks, known)...)
	// Inputs are stored and readable by anyone who can read the execution;
	// a step's credentials reach it as mounted secrets (secretRefs) instead.
	for _, t := range tasks {
		if kind := FindCredential(t.Inputs); kind != "" {
			issues = append(issues, ValidationIssue{Code: "INPUT_CONTAINS_CREDENTIAL", TaskID: t.ID, Message: fmt.Sprintf(
				"Task '%s' has an input that looks like a credential (%s). Register it as a team secret and list it in secretRefs instead.", t.ID, kind)})
		}
	}
	order, cycle := TopologicalSort(tasks)
	issues = append(issues, cycle...)
	if len(issues) > 0 {
		return nil, &DAGValidationError{issues}
	}
	return order, nil
}

// TopologicalSort orders tasks so every dependency precedes its dependents,
// ties broken by submission order; on a cycle, an issue for each task in
// or after it.
func TopologicalSort(tasks []TaskDef) ([]string, []ValidationIssue) {
	index := map[string]int{}
	inDegree := map[string]int{}
	dependents := map[string][]string{}
	for i, t := range tasks {
		index[t.ID] = i
		inDegree[t.ID] = 0
	}
	for _, t := range tasks {
		for _, dep := range t.DependsOn {
			inDegree[t.ID]++
			dependents[dep] = append(dependents[dep], t.ID)
		}
	}
	bySubmission := func(ids []string) { sort.Slice(ids, func(i, j int) bool { return index[ids[i]] < index[ids[j]] }) }
	var ready []string
	for _, t := range tasks {
		if inDegree[t.ID] == 0 {
			ready = append(ready, t.ID)
		}
	}
	var order []string
	for len(ready) > 0 {
		current := ready[0]
		ready = ready[1:]
		order = append(order, current)
		for _, dependent := range dependents[current] {
			inDegree[dependent]--
			if inDegree[dependent] == 0 {
				ready = append(ready, dependent)
			}
		}
		bySubmission(ready)
	}
	if len(order) == len(tasks) {
		return order, nil
	}
	var remaining []string
	for _, t := range tasks {
		if !slices.Contains(order, t.ID) {
			remaining = append(remaining, t.ID)
		}
	}
	sort.Strings(remaining)
	issues := make([]ValidationIssue, len(remaining))
	for i, id := range remaining {
		issues[i] = ValidationIssue{Code: "CYCLE_DETECTED", TaskID: id,
			Message: fmt.Sprintf("Cycle detected involving task(s): %s.", strings.Join(remaining, ", "))}
	}
	return nil, issues
}

func duplicateIDs(tasks []TaskDef) []string {
	seen, duplicate := map[string]bool{}, map[string]bool{}
	for _, t := range tasks {
		if seen[t.ID] {
			duplicate[t.ID] = true
		}
		seen[t.ID] = true
	}
	ids := make([]string, 0, len(duplicate))
	for id := range duplicate {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func dependencyIssues(tasks []TaskDef, known map[string]bool) []ValidationIssue {
	var issues []ValidationIssue
	for _, t := range tasks {
		counts := map[string]int{}
		for _, dep := range t.DependsOn {
			counts[dep]++
		}
		var repeated []string
		for dep, n := range counts {
			if n > 1 {
				repeated = append(repeated, dep)
			}
		}
		sort.Strings(repeated)
		for _, dep := range repeated {
			issues = append(issues, ValidationIssue{Code: "DUPLICATE_DEPENDENCY", TaskID: t.ID,
				Message: fmt.Sprintf("Task '%s' lists '%s' in dependsOn more than once.", t.ID, dep)})
		}
		for _, dep := range t.DependsOn {
			switch {
			case dep == t.ID:
				issues = append(issues, ValidationIssue{Code: "SELF_DEPENDENCY", TaskID: t.ID, Message: fmt.Sprintf("Task '%s' cannot depend on itself.", t.ID)})
			case !known[dep]:
				issues = append(issues, ValidationIssue{Code: "UNKNOWN_DEPENDENCY", TaskID: t.ID, Message: fmt.Sprintf("Task '%s' depends on unknown task '%s'.", t.ID, dep)})
			}
		}
	}
	return issues
}

func referenceIssues(tasks []TaskDef, known map[string]bool) []ValidationIssue {
	var issues []ValidationIssue
	for _, t := range tasks {
		for _, ref := range InputReferences(t.Inputs) {
			switch {
			case !known[ref.FromTask]:
				issues = append(issues, ValidationIssue{Code: "UNKNOWN_INPUT_REFERENCE_TASK", TaskID: t.ID,
					Message: fmt.Sprintf("Task '%s' references output of unknown task '%s'.", t.ID, ref.FromTask)})
			case !slices.Contains(t.DependsOn, ref.FromTask):
				issues = append(issues, ValidationIssue{Code: "NON_UPSTREAM_INPUT_REFERENCE", TaskID: t.ID,
					Message: fmt.Sprintf("Task '%s' references output of task '%s', which is not declared in its dependsOn list.", t.ID, ref.FromTask)})
			}
		}
	}
	return issues
}

// InputReferences is every $fromTask/$output reference in value, at any
// depth, in a deterministic order.
func InputReferences(value any) []InputReference {
	if ref, ok := ParseInputReference(value); ok {
		return []InputReference{ref}
	}
	var found []InputReference
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			found = append(found, InputReferences(v[k])...)
		}
	case []any:
		for _, item := range v {
			found = append(found, InputReferences(item)...)
		}
	}
	return found
}
