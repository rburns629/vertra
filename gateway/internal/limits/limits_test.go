// SPDX-License-Identifier: MIT

package limits

import (
	"testing"
	"time"
)

func TestABucketRefillsAtItsRate(t *testing.T) {
	l := New()
	now := time.Now()
	for i := range 60 {
		if ok, _ := l.Allow("a", 60, now); !ok {
			t.Fatalf("request %d of a minute's 60", i)
		}
	}
	ok, wait := l.Allow("a", 60, now)
	if ok || wait < time.Second {
		t.Errorf("the 61st: %v, wait %v", ok, wait)
	}
	if ok, _ := l.Allow("b", 60, now); !ok {
		t.Error("another team's bucket is its own")
	}
	if ok, _ := l.Allow("a", 60, now.Add(time.Second)); !ok {
		t.Error("a second later, one more")
	}
}
