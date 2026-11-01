// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSavePassword(t *testing.T) {
	dir := t.TempDir()
	// An older file anyone could read, and a .gitignore without a last newline.
	if err := os.WriteFile(filepath.Join(dir, "admin-password"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("tofu/"), 0o644); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		path, err := savePassword(dir, "s3cret")
		if err != nil {
			t.Fatal(err)
		}
		if path != filepath.Join(dir, "admin-password") {
			t.Errorf("path %q", path)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "admin-password"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", info.Mode().Perm())
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "admin-password")); string(b) != "s3cret\n" {
		t.Errorf("password file %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "tofu/\nadmin-password\n" {
		t.Errorf(".gitignore %q", b)
	}
}

func TestSavePasswordNewFolder(t *testing.T) {
	dir := t.TempDir()
	if _, err := savePassword(dir, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "admin-password\n" {
		t.Errorf(".gitignore %q", b)
	}
}
