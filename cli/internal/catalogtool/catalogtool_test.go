// SPDX-License-Identifier: MIT

package catalogtool

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The repository's own catalog template.
const template = "../../../catalog-template"

func quiet(t *testing.T, root string) (*Catalog, *bytes.Buffer) {
	t.Helper()
	abs, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	return &Catalog{Root: abs, Stdout: &out, Stderr: &out, Getenv: func(string) string { return "" }}, &out
}

func TestEmbeddedSchemasMatchTheTemplates(t *testing.T) {
	for _, name := range []string{"product.schema.json", "team.schema.json", "template.schema.json", "dag.schema.json", "api.schema.json"} {
		embedded, err := schemas.ReadFile("schemas/" + name)
		if err != nil {
			t.Fatal(err)
		}
		inTemplate, err := os.ReadFile(filepath.Join(template, "tools", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(embedded, inTemplate) {
			t.Errorf("%s: internal/catalogtool/schemas and catalog-template/tools differ; copy the one you changed over the other", name)
		}
	}
}

func TestTheTemplatesStartersValidate(t *testing.T) {
	c, out := quiet(t, template)
	ok, err := c.Products(context.Background(), "validate", nil, nil)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v\n%s", ok, err, out)
	}
	if len(c.AllProducts()) == 0 {
		t.Fatal("no starters found: the test checked nothing")
	}
}

func TestCodeownersMatching(t *testing.T) {
	for _, tc := range []struct {
		pattern, path string
		want          bool
	}{
		{"*", "anything/at/all", true},
		{"/tools/", "tools/product.schema.json", true},
		{"/vertra", "vertra", true},
		{"/teams/*/secret-stores/", "teams/x/secret-stores/secretstore.yaml", true},
		{"/teams/*/secret-stores/", "teams/x/products/p/product.yaml", false},
		{"/teams/a/", "teams/ab/team.yaml", false},
	} {
		if got := codeownersMatches(tc.pattern, tc.path); got != tc.want {
			t.Errorf("%s ~ %s = %v", tc.pattern, tc.path, got)
		}
	}
	rules, problems := codeownersRules("* @admins\n/teams/a/ @a # comment\n/teams/a/x @b\n")
	if len(problems) != 0 || len(rules) != 3 {
		t.Fatal(rules, problems)
	}
	// The last matching line wins.
	if got := ownersOf(rules, "teams/a/x/y"); len(got) != 1 || got[0] != "@b" {
		t.Errorf("owners = %v", got)
	}
}

func TestBaseImagesMustBePinned(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Dockerfile")
	os.WriteFile(path, []byte("FROM golang:1.27@sha256:abc AS build\n"+
		"FROM build AS test\n"+
		"FROM --platform=linux/amd64 alpine:3\n"+
		"from scratch\n"), 0o644)
	problems := baseProblems(path)
	if len(problems) != 1 || !strings.Contains(problems[0], "line 3: base image alpine:3") {
		t.Fatal(problems)
	}
}

func TestContainsAllKeepsJSONTypes(t *testing.T) {
	load := func(s string) any {
		v, err := loadJSON([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	actual := load(`{"status":"failed","error":{"code":"BAD","message":"why"},"n":1,"list":[1,2]}`)
	for expected, want := range map[string]bool{
		`{"status":"failed"}`:        true,
		`{"error":{"code":"BAD"}}`:   true,
		`{"error":{"code":"OTHER"}}`: false,
		`{"n":1}`:                    true,
		`{"n":1.0}`:                  false, // as Python: an int isn't a float
		`{"n":"1"}`:                  false,
		`{"list":[1,2]}`:             true,
		`{"list":[1]}`:               false, // lists are compared whole
		`{"missing":null}`:           false,
		`{"status":"failed","error":{"code":"BAD"}}`: true,
	} {
		if got := containsAll(actual, load(expected)); got != want {
			t.Errorf("contains %s = %v", expected, got)
		}
	}
}

func TestSecretStoreProblems(t *testing.T) {
	store := map[string]any{
		"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": map[string]any{"name": "s"},
		"spec": map[string]any{"provider": map[string]any{"x": map[string]any{
			"auth": map[string]any{"secretRef": map[string]any{"name": "eso-auth"}},
		}}},
	}
	if p := SecretStoreProblems("team", []any{store}); len(p) != 0 {
		t.Fatal(p)
	}
	foreign := map[string]any{
		"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": map[string]any{"name": "s", "namespace": "other"},
		"spec": map[string]any{"auth": map[string]any{"secretRef": map[string]any{"name": "theirs", "namespace": "x"}}},
	}
	account := map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": "admin"}}
	problems := SecretStoreProblems("team", []any{foreign, account, "text"})
	want := []string{
		"namespace must be 'team' (or left out), not 'other'",
		"spec.auth.secretRef.namespace points into another namespace",
		"spec.auth.secretRef must name the Secret 'eso-auth'",
		"the only ServiceAccounts allowed here",
		"document 3: isn't a Kubernetes object",
	}
	joined := strings.Join(problems, "\n")
	for _, w := range want {
		if !strings.Contains(joined, w) {
			t.Errorf("no problem saying %q in:\n%s", w, joined)
		}
	}
	if p := SecretStoreProblems("team", []any{account}); !strings.Contains(strings.Join(p, "\n"), "No SecretStore in the file.") {
		t.Error(p)
	}
}

func TestReleaseActions(t *testing.T) {
	p := &Product{Dir: "/catalog/teams/web/products/site", Spec: map[string]any{
		"displayName": "Site", "description": "A site.", "serviceAccount": "site-sa", "deprecated": "Use site2.",
		"resources": map[string]any{"cpu": "100m", "memory": "64Mi"},
		"actions": []any{
			map[string]any{"name": "deploy", "input": map[string]any{"type": "object"}, "output": map[string]any{"type": "object"},
				"secretRefs": []any{map[string]any{"name": "creds"}}, "shareWith": []any{"data", "*"}},
			map[string]any{"name": "remove", "displayName": "Remove it", "input": map[string]any{"type": "object"}, "output": map[string]any{"type": "object"},
				"deprecated": "Use site2.delete."},
		},
	}}
	regs, err := p.ReleaseActions("registry/web/site@sha256:abc")
	if err != nil || len(regs) != 2 {
		t.Fatal(regs, err)
	}
	deploy, remove := regs[0], regs[1]
	if deploy.GetName() != "web-site-deploy" || deploy.GetTeam() != "web" || deploy.GetImage() != "registry/web/site@sha256:abc" ||
		deploy.GetDisplayName() != "Site" || deploy.GetServiceAccount() != "site-sa" ||
		len(deploy.GetSecretRefs()) != 1 || strings.Join(deploy.GetShareWith(), ",") != "data,*" ||
		deploy.GetDeprecated() != "Use site2." || deploy.GetResources().GetCpu() != "100m" || deploy.GetResources().GetMemoryLimit() != "" ||
		deploy.GetInputSchema().AsMap()["type"] != "object" {
		t.Errorf("deploy = %v", deploy)
	}
	// An action's own deprecation wins over its product's.
	if remove.GetDisplayName() != "Remove it" || remove.GetDescription() != "A site." || remove.GetDeprecated() != "Use site2.delete." ||
		len(remove.GetShareWith()) != 0 {
		t.Errorf("remove = %v", remove)
	}
}

func TestSettingsProblems(t *testing.T) {
	ok := Settings{Registry: "registry.example/team", SigningMode: "none"}
	if p := ok.Problems(); len(p) != 0 {
		t.Fatal(p)
	}
	bad := Settings{Registry: "https://registry/", SigningMode: "key", Platform: "amd64"}
	if p := bad.Problems(); len(p) != 3 {
		t.Fatal(p)
	}
}

func TestBuildPlatform(t *testing.T) {
	for _, c := range []struct {
		settings Settings
		want     string
	}{
		{Settings{}, ""},
		{Settings{Registry: "localhost:5001"}, ""},
		{Settings{Registry: "kind-registry:5000/catalog"}, ""},
		{Settings{Registry: "us-docker.pkg.dev/p/catalog"}, "linux/amd64"},
		{Settings{Registry: "us-docker.pkg.dev/p/catalog", Platform: "linux/arm64"}, "linux/arm64"},
		{Settings{Registry: "localhost:5001", Platform: "linux/amd64"}, "linux/amd64"},
	} {
		if got := c.settings.BuildPlatform(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.settings, got, c.want)
		}
	}
}
