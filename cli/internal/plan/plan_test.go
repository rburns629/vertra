// SPDX-License-Identifier: MIT

package plan

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestWrap(t *testing.T) {
	got := wrap("one two three four", 9)
	if strings.Join(got, "|") != "one two|three|four" {
		t.Errorf("got %q", got)
	}
	if got := wrap("", 10); len(got) != 1 || got[0] != "" {
		t.Errorf("empty: %q", got)
	}
	// Counted in characters, not bytes.
	if got := wrap("0.55–0.95 vCPU", 14); len(got) != 1 {
		t.Errorf("multi-byte: %q", got)
	}
}

func TestRenderAlignsAndWraps(t *testing.T) {
	p := &Plan{
		Title:    "Acyclix source → kind (local) [dev]",
		Settings: []Line{{Label: "Size", Text: "minimal"}, {Label: "Task images", Text: strings.Repeat("word ", 40)}},
		Changes:  []Line{{Label: "Will create", Text: "kind cluster acyclix"}},
		Cost:     []Line{{Label: "Estimated cost", Text: "$0"}},
		Notes:    []string{"a note"},
	}
	var b strings.Builder
	p.Render(&b)
	out := b.String()
	for _, line := range strings.Split(out, "\n") {
		if n := utf8.RuneCountInString(line); n > Width {
			t.Errorf("line of %d characters: %q", n, line)
		}
	}
	for _, want := range []string{
		"Size         minimal\n",
		"Task images  word",
		"\n             word", // continuation lines line up with the text
		"Will create  kind cluster acyclix",
		"Estimated cost  $0",
		"Note  a note",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
