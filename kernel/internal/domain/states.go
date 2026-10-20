// SPDX-License-Identifier: MIT

// Package domain is the kernel's vocabulary, with no I/O: task and
// execution states and how retries are spaced, event types, a step's result
// and failure, task resources and input references, and recognizing a
// credential a step sends back.
package domain

import (
	"math"
	"time"
)

// TaskState is a task's place in its lifecycle, as stored in
// execution_tasks.state.
//
// A task with no dependencies starts READY, one with dependencies BLOCKED.
// An execution starts PENDING, becomes RUNNING once its first task starts,
// and succeeds only when every task succeeds; one task's unrecoverable
// failure fails it.
type TaskState string

const (
	TaskBlocked   TaskState = "BLOCKED"
	TaskReady     TaskState = "READY"
	TaskClaimed   TaskState = "CLAIMED"
	TaskRunning   TaskState = "RUNNING"
	TaskSucceeded TaskState = "SUCCEEDED"
	TaskFailed    TaskState = "FAILED"
	TaskCancelled TaskState = "CANCELLED"
)

// ExecutionState is an execution's state, as stored in executions.state.
type ExecutionState string

const (
	ExecutionPending   ExecutionState = "PENDING"
	ExecutionRunning   ExecutionState = "RUNNING"
	ExecutionSucceeded ExecutionState = "SUCCEEDED"
	ExecutionFailed    ExecutionState = "FAILED"
	ExecutionCancelled ExecutionState = "CANCELLED"
)

// ActiveExecutionStates are the states an execution can still change from.
var ActiveExecutionStates = []ExecutionState{ExecutionPending, ExecutionRunning}

// ShouldRetry says whether a failed task goes back to READY for another
// attempt: only a failure marked retryable, and only with attempts left.
func ShouldRetry(attemptCount, maxAttempts int, retryable bool) bool {
	return retryable && attemptCount < maxAttempts
}

// RetryBackoff is how long a failed task waits before its next attempt:
// Base after the first failure, doubling with each one after, never more
// than Max. So a brief outage (the Kubernetes API restarting, a registry
// blip) doesn't use up every attempt within a second.
type RetryBackoff struct {
	Base time.Duration
	Max  time.Duration
}

// DefaultRetryBackoff is 5 seconds, doubling, at most 5 minutes.
var DefaultRetryBackoff = RetryBackoff{Base: 5 * time.Second, Max: 300 * time.Second}

// Delay is the wait after failedAttempt (1 for the first) failed.
func (b RetryBackoff) Delay(failedAttempt int) time.Duration {
	exponent := math.Max(float64(failedAttempt-1), 0)
	seconds := b.Base.Seconds() * math.Pow(2, exponent)
	return time.Duration(math.Min(seconds, b.Max.Seconds()) * float64(time.Second))
}
