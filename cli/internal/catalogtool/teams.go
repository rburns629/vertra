// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A team folder is a team: each install's console makes its namespace when
// a release names it, and retires it when a release no longer does
// (release.go).

// What a team's secret-stores/*.yaml may hold (together, one team's
// SecretStores). Each install's console applies it from a release and
// enforces the same rules; this check tells the author on their pull
// request, and a release refuses a file that fails it.
var (
	esoServiceAccounts = []string{"eso-aws", "eso-azure", "eso-gcp"}
	secretStoreAPIs    = []string{"external-secrets.io/v1", "external-secrets.io/v1beta1"}
)

const credentialSecret = "eso-auth"

type found struct {
	path  string
	value any
}

// find is (path, value) for every key under node that wanted accepts.
func find(node any, path string, wanted func(string) bool) []found {
	var out []found
	switch n := node.(type) {
	case map[string]any:
		keys := make([]string, 0, len(n))
		for k := range n {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			child := path + "." + k
			if wanted(k) {
				out = append(out, found{child, n[k]})
			}
			out = append(out, find(n[k], child, wanted)...)
		}
	case []any:
		for i, v := range n {
			out = append(out, find(v, fmt.Sprintf("%s[%d]", path, i), wanted)...)
		}
	}
	return out
}

func orQuestion(v any) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return "?"
}

func pyRepr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return quote(x)
	default:
		return fmt.Sprint(x)
	}
}

// SecretStoreProblems checks a team's SecretStore documents.
func SecretStoreProblems(team string, documents []any) []string {
	var problems []string
	stores := 0
	for i, doc := range documents {
		where := fmt.Sprintf("document %d", i+1)
		m, ok := doc.(map[string]any)
		if !ok {
			problems = append(problems, where+": isn't a Kubernetes object.")
			continue
		}
		kind, api := m["kind"], m["apiVersion"]
		metadata, _ := m["metadata"].(map[string]any)
		name := metadata["name"]
		where = fmt.Sprintf("%s %s (%s)", orQuestion(kind), orQuestion(name), where)
		if ns, present := metadata["namespace"]; present && ns != nil && ns != team {
			problems = append(problems, fmt.Sprintf("%s: namespace must be %s (or left out), not %s.", where, quote(team), pyRepr(ns)))
		}
		switch {
		case kind == "ServiceAccount" && api == "v1":
			if n, _ := name.(string); !contains(esoServiceAccounts, n) {
				problems = append(problems, fmt.Sprintf("%s: the only ServiceAccounts allowed here are the ones ESO signs in as: %s.",
					where, strings.Join(esoServiceAccounts, ", ")))
			}
		case kind == "SecretStore" && contains(secretStoreAPIs, fmt.Sprint(api)):
			stores++
			spec := m["spec"]
			if spec == nil {
				spec = map[string]any{}
			}
			for _, f := range find(spec, "spec", func(k string) bool { return k == "namespace" }) {
				problems = append(problems, fmt.Sprintf("%s: %s points into another namespace; leave it out.", where, f.path))
			}
			for _, f := range find(spec, "spec", func(k string) bool { return strings.HasSuffix(strings.ToLower(k), "secretref") }) {
				ref, isMap := f.value.(map[string]any)
				if !isMap || ref["name"] != credentialSecret {
					named := any(f.value)
					if isMap {
						named = ref["name"]
					}
					problems = append(problems, fmt.Sprintf("%s: %s must name the Secret %s (where the team's BOOTSTRAP_CREDENTIAL is stored), not %s.",
						where, f.path, quote(credentialSecret), pyRepr(named)))
				}
			}
		default:
			problems = append(problems, fmt.Sprintf("%s: only SecretStore (%s) and ServiceAccount (v1) are allowed here.",
				where, strings.Join(secretStoreAPIs, " or ")))
		}
	}
	if stores == 0 {
		problems = append(problems, "No SecretStore in the file.")
	}
	return problems
}

func (c *Catalog) secretStoreFolder(team string) string {
	return c.path("teams", team, "secret-stores")
}

func (c *Catalog) secretStoreFiles(team string) []string {
	files, _ := filepath.Glob(filepath.Join(c.secretStoreFolder(team), "*.yaml"))
	return files
}

// SecretStoreTeams are the teams with SecretStore files.
func (c *Catalog) SecretStoreTeams() []string {
	var teams []string
	for _, t := range c.TeamNames() {
		if len(c.secretStoreFiles(t)) > 0 {
			teams = append(teams, t)
		}
	}
	return teams
}

func (c *Catalog) secretStoreDocuments(team string) ([]any, []string) {
	files := c.secretStoreFiles(team)
	if len(files) == 0 {
		return nil, []string{fmt.Sprintf("no teams/%s/secret-stores/*.yaml", team)}
	}
	var documents []any
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, []string{err.Error()}
		}
		docs, err := loadYAMLDocuments(data)
		if err != nil {
			return nil, []string{fmt.Sprintf("%s: not valid YAML: %v", filepath.Base(path), err)}
		}
		documents = append(documents, docs...)
	}
	return documents, nil
}

// SecretStoresCheck checks each team's SecretStore files.
func (c *Catalog) SecretStoresCheck(teams []string) bool {
	ok := true
	for _, team := range teams {
		documents, problems := c.secretStoreDocuments(team)
		if len(problems) == 0 {
			problems = SecretStoreProblems(team, documents)
		}
		for _, p := range problems {
			c.errorAt(c.secretStoreFolder(team), p)
		}
		c.info("  %s teams/%s/secret-stores", passFail(len(problems) == 0), team)
		ok = ok && len(problems) == 0
	}
	return ok
}
