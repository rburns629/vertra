// SPDX-License-Identifier: MIT

package catalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The repository's own catalog template.
const template = "../../../catalog-template"

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAssemble(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "catalog")
	products, err := Assemble(Options{
		Template: template, Team: "platform", Owners: "@octocat", Languages: []string{"python", "go"},
		Registry: "us-central1-docker.pkg.dev/p/vertra-products",
	}, dst)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(products, ",") != "slug,title-case" {
		t.Errorf("products: %v", products)
	}

	team := read(t, filepath.Join(dst, "teams/platform/team.yaml"))
	for _, want := range []string{"name: platform\n", "owner: octocat\n", "description: The first team"} {
		if !strings.Contains(team, want) {
			t.Errorf("team.yaml lacks %q:\n%s", want, team)
		}
	}
	if strings.Contains(team, "CHANGE") || strings.Contains(team, "anna") {
		t.Errorf("team.yaml kept the template's placeholders:\n%s", team)
	}

	product := read(t, filepath.Join(dst, "teams/platform/products/title-case/product.yaml"))
	if !strings.Contains(product, "\nteam: platform\n") || strings.Contains(product, "team: local") {
		t.Errorf("starter's team not rewritten:\n%s", product)
	}
	if _, err := os.Stat(filepath.Join(dst, "teams/platform/products/reverse")); err == nil {
		t.Error("an unpicked language's starter was copied")
	}

	owners := read(t, filepath.Join(dst, ".github/CODEOWNERS"))
	if strings.Contains(owners, "@your-org") || !strings.Contains(owners, "\n/teams/platform/ @octocat\n") || !strings.Contains(owners, "* @octocat") {
		t.Errorf("CODEOWNERS:\n%s", owners)
	}
	settings := read(t, filepath.Join(dst, "vertra.yaml"))
	if !strings.Contains(settings, "registry: us-central1-docker.pkg.dev/p/vertra-products\n") || strings.Contains(settings, "\nconsole:") {
		t.Errorf("vertra.yaml:\n%s", settings)
	}
	if info, err := os.Stat(filepath.Join(dst, "catalogctl")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Error("catalogctl should stay executable")
	}
	// The samples stay, to copy from later; a second team's worth of them
	// isn't added.
	if _, err := os.Stat(filepath.Join(dst, "samples/local/products/reverse")); err != nil {
		t.Error("samples/ should stay")
	}
}
