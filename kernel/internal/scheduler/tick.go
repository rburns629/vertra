// SPDX-License-Identifier: MIT

// Package scheduler runs the kernel's scheduling passes: claim READY tasks,
// resolve their inputs and start them, poll the running ones, and move each
// execution along. The kernel-scheduler process runs passes forever (Run);
// a pass is one transaction, committed by the caller.
package scheduler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
	"github.com/rburns629/vertra/kernel/internal/metrics"
)

// Options configure a pass.
type Options struct {
	// Owner is this scheduler's lease name (its Pod name).
	Owner         string
	LeaseDuration time.Duration
	// ClaimLimit is how many READY tasks one pass claims.
	ClaimLimit int
	// ExecutorConcurrency is how many executor calls (starts, status reads)
	// a pass has in flight at once.
	ExecutorConcurrency int
	// MaxRunning and MaxRunningPerTeam cap tasks claimed or running at once;
	// 0 is no cap.
	MaxRunning        int
	MaxRunningPerTeam int
	RetryBackoff      domain.RetryBackoff
	// MaxDispatchFailures is how many starts of one attempt may raise in a
	// row before the attempt fails.
	MaxDispatchFailures int
	// LogRefresh is how often a running task's logs are captured; 0, never.
	LogRefresh time.Duration
	// JobDeadlineGrace is how far past its timeout a Job's own deadline is:
	// a timed-out task whose Job can't be stopped fails only after it.
	JobDeadlineGrace time.Duration
}

// DefaultOptions are the scheduler's defaults (the Python kernel's).
func DefaultOptions(owner string) Options {
	return Options{
		Owner: owner, LeaseDuration: 60 * time.Second, ClaimLimit: 50, ExecutorConcurrency: 16,
		RetryBackoff: domain.DefaultRetryBackoff, MaxDispatchFailures: 5, JobDeadlineGrace: 600 * time.Second,
	}
}

// Outcome is what a pass did.
type Outcome struct {
	// Progressed: it claimed a task or saw a running one finish, so the next
	// pass should run at once (a finished task's dependents are claimable).
	Progressed bool
	// Finished are the handles of tasks that left RUNNING: release them
	// (Executor.Release) only once the pass has committed.
	Finished []executor.Handle
	// Events are the event types recorded: count them once committed.
	Events []domain.EventType
}

type pass struct {
	ctx    context.Context
	db     DB
	exec   executor.Executor
	opts   Options
	now    time.Time
	log    *slog.Logger
	events []domain.EventType
}

// RunTick runs one scheduling pass on db (a transaction the caller commits):
// claim, dispatch, poll. A pass that fails leaves nothing behind once its
// transaction rolls back, so running the next from scratch is always safe.
// Only executor calls overlap; every row read and write is in order.
func RunTick(ctx context.Context, db DB, exec executor.Executor, opts Options, now time.Time, log *slog.Logger) (Outcome, error) {
	p := &pass{ctx: ctx, db: db, exec: exec, opts: opts, now: now, log: log}
	claimed, err := p.claimReadyTasks()
	if err != nil {
		return Outcome{}, fmt.Errorf("claiming: %w", err)
	}
	if err := p.dispatch(claimed); err != nil {
		return Outcome{}, fmt.Errorf("dispatching: %w", err)
	}

	rows, err := db.Query(ctx, `SELECT `+taskColumns+` FROM execution_tasks
		WHERE state = 'RUNNING' AND lease_owner = $1 FOR UPDATE SKIP LOCKED`, opts.Owner)
	if err != nil {
		return Outcome{}, err
	}
	running, err := scanTasks(rows)
	if err != nil {
		return Outcome{}, err
	}
	statuses, statusErrors := gather(ctx, running, opts.ExecutorConcurrency, func(t *Task) (executor.Status, error) {
		return exec.Status(ctx, t.ExecutorHandle)
	})
	var finished []executor.Handle
	for i, t := range running {
		handle := t.ExecutorHandle
		left, err := p.poll(t, statuses[i], statusErrors[i])
		if err != nil {
			return Outcome{}, fmt.Errorf("polling %s/%s: %w", t.ExecutionID, t.TaskKey, err)
		}
		if left {
			finished = append(finished, handle)
		}
	}
	return Outcome{Progressed: len(claimed) > 0 || len(finished) > 0, Finished: finished, Events: p.events}, nil
}

// gather runs call for each item, at most limit at once; results in order.
func gather[I, R any](ctx context.Context, items []I, limit int, call func(I) (R, error)) ([]R, []error) {
	results := make([]R, len(items))
	errs := make([]error, len(items))
	semaphore := make(chan struct{}, max(limit, 1))
	var wg sync.WaitGroup
	for i, item := range items {
		wg.Add(1)
		go func() {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			if ctx.Err() != nil {
				errs[i] = ctx.Err()
				return
			}
			results[i], errs[i] = call(item)
		}()
	}
	wg.Wait()
	return results, errs
}

// dispatch resolves each claimed task's inputs, starts them all
// (concurrently), then records each start in order.
func (p *pass) dispatch(tasks []*Task) error {
	type prepared struct {
		task     *Task
		resolved executor.ResolvedTask
	}
	var ready []prepared
	for _, t := range tasks {
		resolved, ok, err := p.resolve(t)
		if err != nil {
			return err
		}
		if ok {
			ready = append(ready, prepared{t, resolved})
		}
	}
	handles, errs := gather(p.ctx, ready, p.opts.ExecutorConcurrency, func(r prepared) (executor.Handle, error) {
		return p.exec.Start(p.ctx, r.resolved)
	})
	for i, r := range ready {
		if err := p.recordStart(r.task, r.resolved, handles[i], errs[i]); err != nil {
			return err
		}
	}
	return nil
}

// resolve is the task with its inputs resolved, or ok=false after failing it.
func (p *pass) resolve(t *Task) (executor.ResolvedTask, bool, error) {
	inputs, err := p.resolveInputs(t)
	var missing *domain.MissingOutputError
	if errors.As(err, &missing) {
		// A declared output that never showed up is a product-contract
		// violation, not a transient problem: never worth retrying.
		return executor.ResolvedTask{}, false, p.handleFailure(t, nil, domain.StructuredError{
			Code: "MISSING_UPSTREAM_OUTPUT", Message: missing.Error()}, nil)
	}
	if err != nil {
		return executor.ResolvedTask{}, false, err
	}
	return executor.ResolvedTask{
		ExecutionID: t.ExecutionID, TaskKey: t.TaskKey, Image: t.Image, Action: t.Action, Attempt: t.AttemptCount,
		ResolvedInputs: inputs, TimeoutSeconds: t.TimeoutSeconds, Team: t.Team, ServiceAccount: t.ServiceAccount,
		SecretRefs: t.SecretRefs, Resources: t.Resources,
	}, true, nil
}

// resolveInputs replaces the task's $fromTask references with its direct
// dependencies' stored outputs.
func (p *pass) resolveInputs(t *Task) (map[string]any, error) {
	rows, err := p.db.Query(p.ctx, `SELECT d.task_key, o.outputs FROM execution_tasks d
		JOIN task_dependencies td ON td.depends_on_task_id = d.id
		JOIN task_outputs o ON o.task_id = d.id
		WHERE td.task_id = $1`, t.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	outputs := map[string]map[string]any{}
	for rows.Next() {
		var key string
		var data []byte
		if err := rows.Scan(&key, &data); err != nil {
			return nil, err
		}
		var o map[string]any
		if err := decodeJSON(data, &o); err != nil {
			return nil, err
		}
		outputs[key] = o
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return domain.ResolveInputs(t.OriginalInputs, outputs)
}

// discard removes what a failed start left behind, best effort: a Job left
// behind still has its activeDeadlineSeconds.
func (p *pass) discard(task executor.ResolvedTask) {
	if err := p.exec.Discard(p.ctx, task); err != nil {
		p.log.Error("couldn't remove what a failed start left behind", "executionId", task.ExecutionID,
			"taskKey", task.TaskKey, "attempt", task.Attempt, "error", err.Error())
	}
}

func (p *pass) recordStart(t *Task, resolved executor.ResolvedTask, handle executor.Handle, startErr error) error {
	if rejected, ok := executor.IsDispatchRejected(startErr); ok {
		// Refused by cluster policy: the same attempt would be refused again.
		p.log.Warn("task dispatch rejected by cluster policy", "code", rejected.Code, "executionId", t.ExecutionID,
			"taskKey", t.TaskKey, "team", t.Team, "image", t.Image, "reason", rejected.Message)
		p.discard(resolved)
		t.DispatchFailures = 0
		return p.handleFailure(t, nil, domain.StructuredError{Code: rejected.Code, Message: rejected.Message}, nil)
	}
	if startErr != nil {
		// The start raised but may still have created the Job. Retrying the
		// same attempt reuses its Job name, so the retry adopts that Job
		// instead of starting a second one. Bounded: past the limit the
		// attempt fails, and whatever it left is removed.
		t.DispatchFailures++
		if t.DispatchFailures < p.opts.MaxDispatchFailures {
			p.log.Warn("starting a task failed; retrying the same attempt", "executionId", t.ExecutionID,
				"taskKey", t.TaskKey, "attempt", t.AttemptCount, "dispatchFailures", t.DispatchFailures, "error", startErr.Error())
			message := startErr.Error()
			if len(message) > 500 {
				message = message[:500]
			}
			if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskDispatchRetry, map[string]any{
				"taskKey": t.TaskKey, "attempt": t.AttemptCount, "dispatchFailures": t.DispatchFailures, "error": message,
			}); err != nil {
				return err
			}
			if err := p.returnUnstartedAttempt(t); err != nil {
				return err
			}
			t.AvailableAt = p.now.Add(p.opts.RetryBackoff.Delay(t.DispatchFailures))
			return saveTask(p.ctx, p.db, t)
		}
		t.DispatchFailures = 0
		p.discard(resolved)
		return p.handleFailure(t, nil, domain.StructuredError{Code: "EXECUTOR_START_FAILED", Message: startErr.Error(), Retryable: true}, nil)
	}

	t.DispatchFailures = 0
	t.ResolvedInputs = resolved.ResolvedInputs
	t.ExecutorHandle = handle
	t.State = domain.TaskRunning
	if err := saveTask(p.ctx, p.db, t); err != nil {
		return err
	}
	attempt, err := currentAttempt(p.ctx, p.db, t)
	if err != nil {
		return err
	}
	attempt.StartedAt = ptr(p.now)
	attempt.Handle = handle
	if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
		return err
	}
	if err := p.markExecutionRunning(t.ExecutionID); err != nil {
		return err
	}
	return p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskStarted, map[string]any{"taskKey": t.TaskKey, "attempt": t.AttemptCount})
}

// poll acts on a RUNNING task's status (read before, alongside the others')
// and says whether the task left RUNNING. A task only leaves RUNNING for a
// retry once its attempt is known to have stopped (finished, stopped, or
// past its Job's own deadline): otherwise a retry could run beside it.
func (p *pass) poll(t *Task, status executor.Status, statusErr error) (bool, error) {
	attempt, err := currentAttempt(p.ctx, p.db, t)
	if err != nil {
		return false, err
	}
	handle := t.ExecutorHandle

	var executionState string
	if err := p.db.QueryRow(p.ctx, `SELECT state FROM executions WHERE id = $1`, t.ExecutionID).Scan(&executionState); err != nil {
		return false, err
	}
	if domain.ExecutionState(executionState) == domain.ExecutionCancelled {
		// Cancelled through kernel-api, which only marks rows: only the
		// scheduler can stop an in-flight attempt.
		_ = p.exec.Cancel(p.ctx, handle)
		attempt.CompletedAt = ptr(p.now)
		if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
			return false, err
		}
		t.State = domain.TaskCancelled
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return false, err
		}
		return true, p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskCancelled, map[string]any{"taskKey": t.TaskKey, "attempt": t.AttemptCount})
	}

	// A result already in wins over the timeout: a task that finished is
	// never failed for taking too long, even when seen late.
	if statusErr == nil && status.State == executor.Succeeded {
		attempt.CompletedAt = ptr(p.now)
		if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
			return false, err
		}
		if _, err := p.db.Exec(p.ctx, `INSERT INTO task_outputs (task_id, outputs) VALUES ($1, $2::jsonb)
			ON CONFLICT (task_id) DO UPDATE SET outputs = EXCLUDED.outputs, created_at = now()`, t.ID, jsonValue(status.Outputs)); err != nil {
			return false, err
		}
		if err := p.captureLogs(t, handle, nil); err != nil {
			return false, err
		}
		t.State = domain.TaskSucceeded
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return false, err
		}
		if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskSucceeded, map[string]any{
			"taskKey": t.TaskKey, "attempt": t.AttemptCount, "outputs": status.Outputs}); err != nil {
			return false, err
		}
		if err := p.releaseReadyDependents(t); err != nil {
			return false, err
		}
		return true, p.settleExecution(t.ExecutionID)
	}
	if statusErr == nil && status.State == executor.Failed {
		return true, p.handleFailure(t, attempt, *status.Error, handle)
	}

	if attempt.StartedAt != nil {
		elapsed := p.now.Sub(*attempt.StartedAt)
		timeout := time.Duration(t.TimeoutSeconds) * time.Second
		if elapsed > timeout {
			if err := p.exec.Cancel(p.ctx, handle); err != nil && elapsed <= timeout+p.opts.JobDeadlineGrace {
				// Before the Job's own deadline the attempt may still be
				// running: it stays ours, and the cancel is tried again.
				p.log.Warn("couldn't stop a task past its timeout; trying again next pass", "executionId", t.ExecutionID,
					"taskKey", t.TaskKey, "attempt", t.AttemptCount, "error", err.Error())
				t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
				return false, saveTask(p.ctx, p.db, t)
			}
			return true, p.handleFailure(t, attempt, domain.StructuredError{
				Code: "TASK_TIMEOUT", Message: fmt.Sprintf("Task exceeded its %ds timeout.", t.TimeoutSeconds), Retryable: true,
			}, handle)
		}
	}

	if statusErr != nil {
		// Not knowing isn't failing: the attempt may still be running, and a
		// retry would start a second one beside it. Read again next pass;
		// the timeout above still applies.
		metrics.StatusReadErrors.Inc()
		p.log.Warn("couldn't read a running task's status; reading it again next pass", "executionId", t.ExecutionID,
			"taskKey", t.TaskKey, "attempt", t.AttemptCount, "error", statusErr.Error())
		t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		return false, saveTask(p.ctx, p.db, t)
	}

	t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration)) // heartbeat: still alive, still ours
	if err := saveTask(p.ctx, p.db, t); err != nil {
		return false, err
	}
	if p.opts.LogRefresh > 0 {
		// So a long step's progress shows while it runs, not only at the end.
		var capturedAt time.Time
		err := p.db.QueryRow(p.ctx, `SELECT created_at FROM task_logs WHERE task_id = $1`, t.ID).Scan(&capturedAt)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && p.now.Sub(capturedAt) >= p.opts.LogRefresh) {
			return false, p.captureLogs(t, handle, &p.now)
		}
		if err != nil {
			return false, err
		}
	}
	return false, nil
}

// captureLogs stores the attempt's output, replacing the last capture. Best
// effort: a task's outcome never depends on reading its logs.
func (p *pass) captureLogs(t *Task, handle executor.Handle, at *time.Time) error {
	lines, err := p.exec.Logs(p.ctx, handle)
	if err != nil {
		return nil
	}
	if lines == nil {
		lines = []string{}
	}
	capturedAt := time.Now()
	if at != nil {
		capturedAt = *at
	}
	_, err = p.db.Exec(p.ctx, `INSERT INTO task_logs (task_id, lines, created_at) VALUES ($1, $2, $3)
		ON CONFLICT (task_id) DO UPDATE SET lines = EXCLUDED.lines, created_at = EXCLUDED.created_at`, t.ID, lines, capturedAt)
	return err
}

// handleFailure records a failed attempt, then retries the task (READY,
// after a backoff) or fails it and its execution. attempt and handle are
// nil for failures before anything ran (resolving inputs, starting).
func (p *pass) handleFailure(t *Task, attempt *Attempt, failure domain.StructuredError, handle executor.Handle) error {
	if attempt == nil {
		var err error
		if attempt, err = currentAttempt(p.ctx, p.db, t); err != nil {
			return err
		}
	}
	attempt.CompletedAt = ptr(p.now)
	attempt.Failure = failure.AsMap()
	if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
		return err
	}
	if handle != nil {
		// A task that failed is often the one someone most wants logs for.
		if err := p.captureLogs(t, handle, nil); err != nil {
			return err
		}
	}
	retry := domain.ShouldRetry(t.AttemptCount, t.MaxAttempts, failure.Retryable)
	if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskFailed, map[string]any{
		"taskKey": t.TaskKey, "attempt": t.AttemptCount, "error": failure.AsMap(), "willRetry": retry}); err != nil {
		return err
	}
	if retry {
		t.State = domain.TaskReady
		t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
		t.AvailableAt = p.now.Add(p.opts.RetryBackoff.Delay(t.AttemptCount))
		return saveTask(p.ctx, p.db, t)
	}
	t.State = domain.TaskFailed
	t.Failure = failure.AsMap()
	if err := saveTask(p.ctx, p.db, t); err != nil {
		return err
	}
	return p.failExecution(t.ExecutionID)
}

// releaseReadyDependents makes each BLOCKED dependent of t READY once every
// one of its dependencies has succeeded. The dependent is locked before its
// dependencies are read: two schedulers finishing two of its dependencies
// at once would otherwise each see the other still running, and neither
// would release it. FOR NO KEY UPDATE, like an ordinary UPDATE's lock:
// rows inserted meanwhile that reference it (events, outputs) take FOR KEY
// SHARE, which FOR UPDATE would conflict with, deadlocking.
func (p *pass) releaseReadyDependents(t *Task) error {
	rows, err := p.db.Query(p.ctx, `SELECT task_id::text FROM task_dependencies WHERE depends_on_task_id = $1`, t.ID)
	if err != nil {
		return err
	}
	var dependents []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		dependents = append(dependents, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range dependents {
		var state string
		if err := p.db.QueryRow(p.ctx, `SELECT state FROM execution_tasks WHERE id = $1 FOR NO KEY UPDATE`, id).Scan(&state); err != nil {
			return err
		}
		if domain.TaskState(state) != domain.TaskBlocked {
			continue
		}
		var unfinished int
		if err := p.db.QueryRow(p.ctx, `SELECT count(*) FROM execution_tasks d
			JOIN task_dependencies td ON td.depends_on_task_id = d.id
			WHERE td.task_id = $1 AND d.state <> 'SUCCEEDED'`, id).Scan(&unfinished); err != nil {
			return err
		}
		if unfinished == 0 {
			if _, err := p.db.Exec(p.ctx, `UPDATE execution_tasks SET state = 'READY', available_at = $2, updated_at = now()
				WHERE id = $1`, id, p.now); err != nil {
				return err
			}
		}
	}
	return nil
}

// The execution transitions below are compare-and-set, never a loaded
// row's state written back: kernel-api may have cancelled it since.

func (p *pass) markExecutionRunning(executionID string) error {
	moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionRunning, domain.ExecutionPending)
	if err != nil || !moved {
		return err
	}
	return p.recordEvent(executionID, nil, domain.EventExecutionStarted, nil)
}

// settleExecution, after a task succeeds: SUCCEEDED once every task has, or
// FAILED if a task failed and nothing that could still run is left (after
// a manual retry resumed an execution with more than one failed task). The
// execution's row is locked before its tasks are counted, as in
// releaseReadyDependents: two schedulers finishing its last two tasks would
// each count the other's as unfinished.
func (p *pass) settleExecution(executionID string) error {
	if _, err := p.db.Exec(p.ctx, `SELECT id FROM executions WHERE id = $1 FOR NO KEY UPDATE`, executionID); err != nil {
		return err
	}
	rows, err := p.db.Query(p.ctx, `SELECT state, count(*) FROM execution_tasks WHERE execution_id = $1 GROUP BY state`, executionID)
	if err != nil {
		return err
	}
	counts := map[domain.TaskState]int{}
	total := 0
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			rows.Close()
			return err
		}
		counts[domain.TaskState(state)] = n
		total += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if counts[domain.TaskSucceeded] == total {
		moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionSucceeded, domain.ActiveExecutionStates...)
		if err != nil || !moved {
			return err
		}
		return p.recordEvent(executionID, nil, domain.EventExecutionSucceeded, nil)
	}
	runnable := counts[domain.TaskReady] + counts[domain.TaskClaimed] + counts[domain.TaskRunning]
	if counts[domain.TaskFailed] > 0 && runnable == 0 {
		return p.failExecution(executionID)
	}
	return nil
}

// failExecution cancels the tasks that were never going to run (waiting on
// a dependency, or to be claimed) and fails the execution. Tasks before the
// execution's own row, in the order kernel-api's cancel locks them too.
func (p *pass) failExecution(executionID string) error {
	if _, err := p.db.Exec(p.ctx, `UPDATE execution_tasks SET state = 'CANCELLED', updated_at = now()
		WHERE execution_id = $1 AND state IN ('READY', 'BLOCKED')`, executionID); err != nil {
		return err
	}
	moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionFailed, domain.ActiveExecutionStates...)
	if err != nil || !moved {
		return err
	}
	return p.recordEvent(executionID, nil, domain.EventExecutionFailed, nil)
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
