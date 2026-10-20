// SPDX-License-Identifier: MIT

package domain

// EventType names what happened, in execution_events.event_type.
type EventType string

const (
	EventExecutionCreated   EventType = "EXECUTION_CREATED"
	EventExecutionStarted   EventType = "EXECUTION_STARTED"
	EventExecutionSucceeded EventType = "EXECUTION_SUCCEEDED"
	EventExecutionFailed    EventType = "EXECUTION_FAILED"
	EventExecutionCancelled EventType = "EXECUTION_CANCELLED"
	EventExecutionResumed   EventType = "EXECUTION_RESUMED"
	EventTaskClaimed        EventType = "TASK_CLAIMED"
	EventTaskStarted        EventType = "TASK_STARTED"
	EventTaskSucceeded      EventType = "TASK_SUCCEEDED"
	EventTaskFailed         EventType = "TASK_FAILED"
	EventTaskCancelled      EventType = "TASK_CANCELLED"
	EventTaskRetried        EventType = "TASK_RETRIED"
	// Starting the attempt raised (an API timeout, say); the same attempt
	// is tried again later, adopting whatever that start left.
	EventTaskDispatchRetry EventType = "TASK_DISPATCH_RETRY"
)
