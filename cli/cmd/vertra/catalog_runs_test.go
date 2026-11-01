// SPDX-License-Identifier: MIT

package main

import (
	"testing"
	"time"

	"github.com/rburns629/vertra/cli/internal/githost"
)

// After a take-over, the old push's run (to the other registry) and an
// earlier run by hand aren't waited on: only the new run by hand.
func TestSinceDispatch(t *testing.T) {
	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	runs := []githost.Run{
		{ID: 1, Event: "push", Created: at.Add(-time.Hour)},
		{ID: 2, Event: "workflow_dispatch", Created: at.Add(-10 * time.Minute)},
		{ID: 3, Event: "workflow_dispatch", Created: at.Add(5 * time.Second)},
		{ID: 4, Event: "push", Created: at.Add(10 * time.Second)},
	}
	got := sinceDispatch(runs, at)
	if len(got) != 1 || got[0].ID != 3 {
		t.Errorf("waited on %v", got)
	}
	if len(sinceDispatch(runs, time.Time{})) != 4 {
		t.Error("a push's runs were filtered")
	}
}
