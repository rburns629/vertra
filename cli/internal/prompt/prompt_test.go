// SPDX-License-Identifier: MIT

package prompt

import (
	"io"
	"strings"
	"testing"
)

var options = []Option{{Value: "kind", Label: "kind (local)"}, {Value: "existing", Label: "existing"}}

func TestNonInteractiveTakesDefaults(t *testing.T) {
	a := New(strings.NewReader(""), io.Discard, false)
	if v, err := a.Choose("Where?", options, "existing"); err != nil || v != "existing" {
		t.Errorf("Choose: %q, %v", v, err)
	}
	if v, err := a.Confirm("Sure?", true); err != nil || !v {
		t.Errorf("Confirm: %v, %v", v, err)
	}
	if _, err := a.Text("Email", "", nil); err == nil {
		t.Error("Text without a default should fail")
	}
}

func TestChoose(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"\n", "kind"}, {"2\n", "existing"}, {"EXISTING\n", "existing"}, {"9\nnope\n1\n", "kind"},
	} {
		a := New(strings.NewReader(tc.input), io.Discard, true)
		if v, err := a.Choose("Where?", options, "kind"); err != nil || v != tc.want {
			t.Errorf("%q: got %q, %v", tc.input, v, err)
		}
	}
}

func TestConfirm(t *testing.T) {
	for _, tc := range []struct {
		input string
		def   bool
		want  bool
	}{{"\n", false, false}, {"\n", true, true}, {"y\n", false, true}, {"maybe\nno\n", true, false}} {
		a := New(strings.NewReader(tc.input), io.Discard, true)
		if v, err := a.Confirm("Sure?", tc.def); err != nil || v != tc.want {
			t.Errorf("%q: got %v, %v", tc.input, v, err)
		}
	}
}

func TestTextValidatesAndRetries(t *testing.T) {
	var out strings.Builder
	a := New(strings.NewReader("\nbad\ngood\n"), &out, true)
	v, err := a.Text("Word", "", func(s string) error {
		if s != "good" {
			return io.ErrUnexpectedEOF
		}
		return nil
	})
	if err != nil || v != "good" {
		t.Fatalf("got %q, %v", v, err)
	}
	if !strings.Contains(out.String(), "An answer is needed") {
		t.Errorf("no prompt for the empty answer:\n%s", out.String())
	}
}

func TestNumberRange(t *testing.T) {
	a := New(strings.NewReader("0\n11\nx\n4\n"), io.Discard, true)
	if n, err := a.Number("How many?", 1, 1, 10); err != nil || n != 4 {
		t.Fatalf("got %d, %v", n, err)
	}
}

func TestClosedInputFails(t *testing.T) {
	a := New(strings.NewReader(""), io.Discard, true)
	if _, err := a.Text("Word", "", nil); err == nil {
		t.Error("expected an error on closed input")
	}
}
