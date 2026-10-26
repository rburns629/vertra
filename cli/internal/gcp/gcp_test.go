// SPDX-License-Identifier: MIT

package gcp

import (
	"strings"
	"testing"
)

func TestSSDQuotaWarning(t *testing.T) {
	quota := func(limit, usage string) string {
		return `{"quotas": [{"metric": "CPUS", "limit": 200, "usage": 6}, {"metric": "SSD_TOTAL_GB", "limit": ` + limit + `, "usage": ` + usage + `}]}`
	}
	// A new project's 500 GB, three nodes up (what blocked a step on GKE).
	if w := SSDQuotaWarning(quota("500", "436"), "us-central1"); !strings.Contains(w, "64 of 500 GB free") || !strings.Contains(w, "about 0 Autopilot nodes") {
		t.Errorf("got %q", w)
	}
	if w := SSDQuotaWarning(quota("500", "0"), "us-central1"); !strings.Contains(w, "about 3 Autopilot nodes") {
		t.Errorf("an empty project's 500 GB: got %q", w)
	}
	if w := SSDQuotaWarning(quota("2048", "436"), "us-central1"); w != "" {
		t.Errorf("room enough: got %q", w)
	}
	if w := SSDQuotaWarning("not json", "us-central1"); w != "" {
		t.Errorf("unreadable: got %q", w)
	}
}
