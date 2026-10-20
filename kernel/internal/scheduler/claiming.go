// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"time"

	"github.com/rburns629/acyclix/kernel/internal/domain"
)

// Claiming uses SELECT ... FOR UPDATE SKIP LOCKED, so several schedulers
// poll at once without blocking each other or claiming the same task. It
// doesn't make execution exactly-once: a task can still run twice (a
// scheduler crashes after its Pod acted, and the task is retried).
// Execution is at-least-once; product actions must be idempotent.

// recoverExpiredLeases takes over every CLAIMED or RUNNING task whose lease
// has expired. A RUNNING task already has a Job, so this scheduler adopts
// it (the next poll reads the same Job through its handle); starting it
// again would run every in-flight task twice on each scheduler rollout. A
// CLAIMED task never got a Job, so it goes back to READY. Neither touches
// attempt_count.
func (p *pass) recoverExpiredLeases() (int, error) {
	rows, err := p.db.Query(p.ctx, `SELECT `+taskColumns+` FROM execution_tasks
		WHERE state IN ('CLAIMED', 'RUNNING') AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED`, p.now)
	if err != nil {
		return 0, err
	}
	expired, err := scanTasks(rows)
	if err != nil {
		return 0, err
	}
	for _, t := range expired {
		if t.State == domain.TaskRunning && t.ExecutorHandle != nil {
			p.log.Info("adopting running task from an expired lease", "executionId", t.ExecutionID,
				"taskKey", t.TaskKey, "previousOwner", deref(t.LeaseOwner), "owner", p.opts.Owner)
			t.LeaseOwner = &p.opts.Owner
			t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		} else {
			t.State = domain.TaskReady
			t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
		}
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return 0, err
		}
	}
	return len(expired), nil
}

// returnUnstartedAttempt hands a claimed task back as if the claim never
// happened (its attempt row and number undone), for a start that raised:
// the next claim gets the same attempt number, and so the same Job name,
// which the executor adopts if that start did create it. The caller sets
// when it may be claimed again.
func (p *pass) returnUnstartedAttempt(t *Task) error {
	if _, err := p.db.Exec(p.ctx, `DELETE FROM task_attempts WHERE task_id = $1 AND attempt_number = $2`,
		t.ID, t.AttemptCount); err != nil {
		return err
	}
	t.AttemptCount--
	t.State = domain.TaskReady
	t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
	return nil
}

// ReleaseLeases expires every lease owner holds, for a scheduler shutting
// down: the next scheduler recovers (adopts) those tasks at once rather
// than when the leases run out.
func ReleaseLeases(ctx context.Context, db DB, owner string, now time.Time) (int, error) {
	tag, err := db.Exec(ctx, `UPDATE execution_tasks SET lease_expires_at = $2, updated_at = now()
		WHERE state IN ('CLAIMED', 'RUNNING') AND lease_owner = $1`, owner, now)
	return int(tag.RowsAffected()), err
}

// How many candidates to read per claimable slot when a per-team cap applies.
const perTeamCandidates = 4

func (p *pass) runningPerTeam() (map[string]int, error) {
	rows, err := p.db.Query(p.ctx, `SELECT team, count(*) FROM execution_tasks
		WHERE state IN ('CLAIMED', 'RUNNING') GROUP BY team`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var team string
		var n int
		if err := rows.Scan(&team, &n); err != nil {
			return nil, err
		}
		counts[team] = n
	}
	return counts, rows.Err()
}

// claimReadyTasks claims up to ClaimLimit READY tasks whose available_at
// has passed and whose execution is still active, after recovering expired
// leases. MaxRunning caps how many tasks are claimed or running across the
// platform, MaxRunningPerTeam per team; a task over a cap stays READY. The
// caps are exact with one scheduler; with several, each counts on its own.
// Nothing is committed here: a pass commits claims and dispatches together,
// so a commit that fails after a Job was created rolls the claim back, and
// the next claim gets the same attempt number (and Job name) to adopt.
func (p *pass) claimReadyTasks() ([]*Task, error) {
	if _, err := p.recoverExpiredLeases(); err != nil {
		return nil, err
	}
	limit := p.opts.ClaimLimit
	var perTeam map[string]int
	if p.opts.MaxRunning > 0 || p.opts.MaxRunningPerTeam > 0 {
		var err error
		if perTeam, err = p.runningPerTeam(); err != nil {
			return nil, err
		}
	}
	if p.opts.MaxRunning > 0 {
		total := 0
		for _, n := range perTeam {
			total += n
		}
		limit = min(limit, p.opts.MaxRunning-total)
		if limit <= 0 {
			return nil, nil
		}
	}
	candidates := limit
	if p.opts.MaxRunningPerTeam > 0 {
		// Some candidates may be teams already at their cap; reading a few
		// more keeps one busy team from starving the rest.
		candidates = limit * perTeamCandidates
	}
	rows, err := p.db.Query(p.ctx, `SELECT `+taskColumnsOf("t")+` FROM execution_tasks t
		JOIN executions e ON e.id = t.execution_id
		WHERE t.state = 'READY' AND t.available_at <= $1 AND e.state IN ('PENDING', 'RUNNING')
		ORDER BY t.available_at LIMIT $2 FOR UPDATE OF t SKIP LOCKED`, p.now, candidates)
	if err != nil {
		return nil, err
	}
	ready, err := scanTasks(rows)
	if err != nil {
		return nil, err
	}

	var claimed []*Task
	for _, t := range ready {
		if len(claimed) == limit {
			break
		}
		if p.opts.MaxRunningPerTeam > 0 {
			if perTeam[t.Team] >= p.opts.MaxRunningPerTeam {
				continue
			}
			perTeam[t.Team]++
		}
		claimed = append(claimed, t)
	}
	for _, t := range claimed {
		t.State = domain.TaskClaimed
		t.LeaseOwner = &p.opts.Owner
		t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		t.AttemptCount++
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return nil, err
		}
		if _, err := p.db.Exec(p.ctx, `INSERT INTO task_attempts (id, task_id, attempt_number)
			VALUES (gen_random_uuid(), $1, $2)`, t.ID, t.AttemptCount); err != nil {
			return nil, err
		}
		if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskClaimed,
			map[string]any{"taskKey": t.TaskKey, "owner": p.opts.Owner, "attempt": t.AttemptCount}); err != nil {
			return nil, err
		}
	}
	return claimed, nil
}

func ptr[T any](v T) *T { return &v }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
