// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"time"
)

// DeleteFinishedExecutions deletes up to limit finished executions whose
// last event is older than finishedBefore (every row of theirs cascades),
// and returns how many. Called repeatedly, a few at a time, so one pass
// never holds a long transaction. An execution has no timestamp of its own
// for finishing; its last event says when.
func DeleteFinishedExecutions(ctx context.Context, db DB, finishedBefore time.Time, limit int) (int, error) {
	tag, err := db.Exec(ctx, `DELETE FROM executions WHERE id IN (
		SELECT id FROM executions
		WHERE state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
		AND id IN (SELECT execution_id FROM execution_events GROUP BY execution_id HAVING max(created_at) < $1)
		LIMIT $2 FOR UPDATE SKIP LOCKED)`, finishedBefore, limit)
	return int(tag.RowsAffected()), err
}
