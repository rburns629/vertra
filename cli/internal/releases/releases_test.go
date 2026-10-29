// SPDX-License-Identifier: MIT

package releases

import (
	"slices"
	"strings"
	"testing"
)

func TestParseKeepsReleasesNewestFirst(t *testing.T) {
	got, err := parse([]byte(`[{"tag_name":"v0.5.1"},{"tag_name":"v0.10.0"},{"tag_name":"v0.6.0-rc.1","prerelease":true},
		{"tag_name":"v0.9.0","draft":true},{"tag_name":"v0.5.2"},{"tag_name":"nightly"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"0.10.0", "0.5.2", "0.5.1"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestBetweenAndChartVersion(t *testing.T) {
	versions := []string{"0.6.0", "0.5.2", "0.5.1", "0.5.0", "0.4.0"}
	if got := Between(versions, "0.4.0", "0.6.0"); !slices.Equal(got, []string{"0.5.0", "0.5.1", "0.5.2"}) {
		t.Errorf("between: %v", got)
	}
	if got := ChartVersion("execution-kernel-0.5.2"); got != "0.5.2" {
		t.Errorf("chart version: %q", got)
	}
	if got := ChartVersion("execution-kernel"); got != "" {
		t.Errorf("no version: %q", got)
	}
}

func TestUpgrade(t *testing.T) {
	versions := []string{"0.6.0", "0.5.2", "0.5.1", "0.5.0"}
	for name, tc := range map[string]struct {
		installed, target, cli string
		versions               []string
		notes                  []string // a word each note has
		refused                bool
	}{
		"next release":       {"0.5.2", "0.6.0", "0.6.0", versions, nil, false},
		"passing some over":  {"0.5.0", "0.6.0", "0.6.0", versions, []string{"0.5.1, 0.5.2"}, false},
		"back":               {"0.6.0", "0.5.2", "0.6.0", versions, nil, true},
		"a newer one is out": {"0.5.1", "0.5.2", "0.6.0", versions, []string{"0.6.0 is out"}, false},
		"vertra too old":     {"0.5.2", "0.6.0", "0.5.2", versions, []string{"get vertra 0.6.0"}, false},
		"a fresh install":    {"", "0.6.0", "0.6.0", versions, nil, false},
		"from source":        {"0.1.0", "source", "dev", versions, nil, false},
		"list unreadable":    {"0.5.0", "0.6.0", "0.6.0", nil, nil, false},
		"same version":       {"0.6.0", "0.6.0", "dev", versions, nil, false},
	} {
		notes, err := Upgrade(tc.installed, tc.target, tc.cli, tc.versions)
		if (err != nil) != tc.refused {
			t.Errorf("%s: refused %v, want %v", name, err, tc.refused)
			continue
		}
		if len(notes) != len(tc.notes) {
			t.Errorf("%s: notes %q, want %d", name, notes, len(tc.notes))
			continue
		}
		for i, want := range tc.notes {
			if !strings.Contains(notes[i], want) {
				t.Errorf("%s: %q lacks %q", name, notes[i], want)
			}
		}
	}
}
