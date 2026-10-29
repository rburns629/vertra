// SPDX-License-Identifier: MIT

package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInFolderFindsWholePairs(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{
		"kernel/2026-10-28T03-00-00Z.pgdump", "console/2026-10-28T03-00-00Z.pgdump",
		"kernel/2026-10-29T03-00-00Z.pgdump", "console/2026-10-29T03-00-00Z.pgdump",
		"kernel/2026-10-30T03-00-00Z.pgdump", // no console dump: not a backup
		"kernel/2026-10-31T03-00-00Z.pgdump.partial",
	} {
		path := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	p, err := InFolder(dir, "")
	if err != nil || p.Timestamp != "2026-10-29T03-00-00Z" || p.Console != filepath.Join(dir, "console", "2026-10-29T03-00-00Z.pgdump") {
		t.Errorf("newest: %+v, %v", p, err)
	}
	if p, err := InFolder(dir, "2026-10-28T03-00-00Z"); err != nil || p.Timestamp != "2026-10-28T03-00-00Z" {
		t.Errorf("by time: %+v, %v", p, err)
	}
	if _, err := InFolder(dir, "2026-10-30T03-00-00Z"); err == nil || !strings.Contains(err.Error(), "2026-10-28T03-00-00Z, 2026-10-29T03-00-00Z") {
		t.Errorf("half a pair: %v", err)
	}
	if _, err := InFolder(t.TempDir(), ""); err == nil {
		t.Error("an empty folder has no backup")
	}
}

func TestPairsAreLaidOutAsTheCronJobStoresThem(t *testing.T) {
	p := pairAt("gs://acme-backups", "2026-10-29T03-00-00Z")
	if p.Kernel != "gs://acme-backups/kernel/2026-10-29T03-00-00Z.pgdump" || p.Console != "gs://acme-backups/console/2026-10-29T03-00-00Z.pgdump" {
		t.Errorf("%+v", p)
	}
	// What the CronJob's pg-dump container logs.
	if m := timestamp.FindStringSubmatch("dumped execution_kernel to kernel/2026-10-29T03-00-00Z.pgdump\n"); m == nil || m[1] != "2026-10-29T03-00-00Z" {
		t.Errorf("log: %v", m)
	}
}

func TestOlderSchemas(t *testing.T) {
	for _, tc := range []struct {
		after, before string
		want          bool
	}{{"0008", "0009", true}, {"0009", "0009", false}, {"12", "9", false}, {"", "9", false}, {"9", "", false}} {
		if got := isOlder(tc.after, tc.before); got != tc.want {
			t.Errorf("isOlder(%q, %q) = %v", tc.after, tc.before, got)
		}
	}
}
