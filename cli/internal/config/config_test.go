// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// checkout makes a directory that passes for an Acyclix checkout.
func checkout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	chart := filepath.Join(dir, "helm", "charts", "execution-kernel")
	if err := os.MkdirAll(chart, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chart, "Chart.yaml"), []byte("name: execution-kernel\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func validKind(t *testing.T) *Config {
	c := Default("kind")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	return c
}

func TestDefaultsAreValid(t *testing.T) {
	if err := validKind(t).Validate(); err != nil {
		t.Fatal(err)
	}
	c := Default("existing")
	c.Acyclix = "0.1.0"
	c.Cluster.Context = "my-cluster"
	c.TaskImages.Registry = "us-docker.pkg.dev/p/catalog"
	c.Admin.Email = "admin@example.com"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidateReportsEveryProblem(t *testing.T) {
	c := validKind(t)
	c.Target = "azure"
	c.Acyclix = "latest"
	c.Size = "huge"
	c.Namespace = "Not_A_Namespace"
	c.Admin.Email = "nobody"
	err := c.Validate()
	if err == nil {
		t.Fatal("expected problems")
	}
	for _, want := range []string{"target: azure isn't supported", `acyclix: "latest"`, `size: "huge"`, "namespace:", "admin.email:"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in:\n%v", want, err)
		}
	}
}

func TestValidateKindRegistryName(t *testing.T) {
	c := validKind(t)
	c.Kind.RegistryName = "bad name; rm -rf"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "kind.registryName") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateManagedDatabaseNeedsCloud(t *testing.T) {
	c := validKind(t)
	c.Database.Type = "managed"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "managed needs a cloud target") {
		t.Fatalf("got %v", err)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	c := validKind(t)
	dir := filepath.Join(t.TempDir(), "dev")
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, FileName))
	if !strings.HasPrefix(string(data), "# An Acyclix install's settings") {
		t.Errorf("no header:\n%s", data)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, c) {
		t.Errorf("round trip changed it:\n got %+v\nwant %+v", got, c)
	}
}

func TestLoadRejectsUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("version: 1\ntarget: kind\nsizee: minimal\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "sizee") {
		t.Fatalf("got %v", err)
	}
}

func TestGetSet(t *testing.T) {
	c := validKind(t)
	if v, err := Get(c, "scaleDown.enabled"); err != nil || v != "true" {
		t.Fatalf("got %q, %v", v, err)
	}
	changed, err := Set(c, "scaleDown.enabled", "false")
	if err != nil {
		t.Fatal(err)
	}
	if changed.ScaleDown.Enabled || changed.MinReplicas != 1 {
		t.Errorf("got %+v", changed.ScaleDown)
	}
	if c.ScaleDown.Enabled != true {
		t.Error("Set changed its input")
	}
	changed, err = Set(changed, "minReplicas", "3")
	if err != nil || changed.MinReplicas != 3 {
		t.Fatalf("got %d, %v", changed.MinReplicas, err)
	}
	if _, err := Set(c, "size", "huge"); err == nil {
		t.Error("an invalid value was accepted")
	}
	if _, err := Set(c, "cluster", "x"); err == nil {
		t.Error("a group was set")
	}
	if _, err := Set(c, "nope", "x"); err == nil {
		t.Error("an unknown key was set")
	}
}

func TestSetAddsAnOmittedOptionalKey(t *testing.T) {
	c := validKind(t)
	c.Values = ""
	changed, err := Set(c, "values", "extra.yaml")
	if err != nil || changed.Values != "extra.yaml" {
		t.Fatalf("got %q, %v", changed.Values, err)
	}
}

func TestKeys(t *testing.T) {
	keys, err := Keys(validKind(t))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(keys, "\n")
	for _, want := range []string{"size: minimal", "kind.registryPort: 5001", "scaleDown.idleAfter: 2h"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestDir(t *testing.T) {
	base := t.TempDir()
	if _, err := Dir(base, "Bad/Name"); err == nil {
		t.Error("accepted a bad environment name")
	}
	if _, err := Dir(base, ""); err == nil {
		t.Error("found an environment in an empty directory")
	}
	c := validKind(t)
	if err := c.Save(filepath.Join(base, "dev")); err != nil {
		t.Fatal(err)
	}
	if dir, err := Dir(base, ""); err != nil || dir != filepath.Join(base, "dev") {
		t.Errorf("got %q, %v", dir, err)
	}
}

func TestGCP(t *testing.T) {
	c := Default("gcp")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.GCP = GCP{Project: "my-project-123", Region: "us-central1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if !c.TaskImages.Create || !c.Database.Backups.Enabled || c.Cluster.Mode != "auto" {
		t.Errorf("gcp defaults: %+v", c)
	}
	c.GCP.Project = "My_Project"
	c.Cluster.Mode = "existing"
	c.Database.Type = "managed"
	err := c.Validate()
	for _, want := range []string{"gcp.project", "cluster.mode", "managed isn't supported"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}

func TestAWS(t *testing.T) {
	c := Default("aws")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.AWS = AWS{Profile: "acyclix", Region: "us-east-1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.AWS.Region = "us-central1"
	c.Cluster.Mode = "existing"
	c.Catalog = Catalog{Host: "github", Owner: "o", Repository: "r", Visibility: "private", Team: "t"}
	c.Console.Public = true
	err := c.Validate()
	for _, want := range []string{"aws.region", "cluster.mode", "console.zone"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}
