// SPDX-License-Identifier: MIT

package domain

import (
	"os"
	"strings"
	"testing"
)

// The console chart's log collector redacts credentials before Loki stores
// them, with these same patterns; this keeps the two equal.
func TestTheLogCollectorRedactsWhatTheKernelDoes(t *testing.T) {
	config, err := os.ReadFile("../../../helm/charts/execution-console/files/alloy.alloy")
	if err != nil {
		t.Fatal(err)
	}
	for _, shape := range append(append([]credentialShape{}, tokens...), logOnly...) {
		if !strings.Contains(string(config), shape.pattern.String()) {
			t.Errorf("the log collector doesn't redact a %s: add a stage.replace for `%s`", shape.kind, shape.pattern)
		}
	}
}
