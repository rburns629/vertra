// SPDX-License-Identifier: MIT

package catalogctl

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rburns629/acyclix/cli/internal/consoleapi"
)

// A team folder is a team: the console gives it a namespace when it's
// applied, relabels it when it's retired, and deletes it when it's purged.

// TeamsChanged are the team folders touched since base that still exist;
// every one when there's no usable base (a manual run, a first push).
func (c *Catalog) TeamsChanged(base string) []string {
	if !c.usableBase(base) {
		return c.TeamNames()
	}
	out, err := c.git("diff", "--name-only", base, "HEAD", "--", "teams/")
	if err != nil {
		return c.TeamNames()
	}
	touched := map[string]bool{}
	for _, n := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.Count(n, "/") >= 2 {
			touched[strings.Split(n, "/")[1]] = true
		}
	}
	teams := []string{}
	for t := range touched {
		if isDir(c.path("teams", t)) {
			teams = append(teams, t)
		}
	}
	sort.Strings(teams)
	return teams
}

// TeamsRemoved are the team folders that existed at base and are gone now.
// None without a usable base: never guess at retiring something.
func (c *Catalog) TeamsRemoved(base string) []string {
	if !c.usableBase(base) {
		return nil
	}
	out, err := c.git("ls-tree", "-d", "--name-only", base, "teams/")
	if err != nil {
		return nil
	}
	var removed []string
	for _, p := range strings.Fields(out) { // "teams/<team>"
		if !isDir(c.path(filepath.FromSlash(p))) {
			removed = append(removed, strings.SplitN(p, "/", 2)[1])
		}
	}
	sort.Strings(removed)
	return removed
}

// TeamsApply makes each team exist and be active, with its namespace.
func (c *Catalog) TeamsApply(ctx context.Context, names []string, console *consoleapi.Client) bool {
	ok := true
	for _, name := range names {
		folder := c.path("teams", name)
		if !exists(filepath.Join(folder, "team.yaml")) {
			c.errorAt(folder, fmt.Sprintf("teams/%s/ has no team.yaml, so it isn't a team yet", name))
			ok = false
			continue
		}
		created, err := console.EnsureTeam(ctx, name)
		if err != nil {
			c.errorAt(folder, fmt.Sprintf("team %s: %v", name, err))
			ok = false
			continue
		}
		state := "active"
		if created {
			state = "created"
		}
		c.info("  %s: %s, with its namespace", name, state)
	}
	return ok
}

// TeamsRetire retires teams whose folders are gone (reversible).
func (c *Catalog) TeamsRetire(ctx context.Context, names []string, console *consoleapi.Client) bool {
	ok := true
	for _, name := range names {
		if isDir(c.path("teams", name)) {
			c.errorAt("", fmt.Sprintf("teams/%s/ still exists: a team is retired by removing its folder", name))
			ok = false
			continue
		}
		found, unregistered, err := console.RetireTeam(ctx, name)
		switch {
		case err != nil:
			c.errorAt("", fmt.Sprintf("retiring %s: %v", name, err))
			ok = false
		case !found:
			c.info("  %s: no such team, nothing to retire", name)
		default:
			c.info("  %s: retired (%d product(s) unregistered)", name, unregistered)
		}
	}
	return ok
}

// TeamsPurge purges a retired team whose folder is gone (irreversible).
func (c *Catalog) TeamsPurge(ctx context.Context, name string, console *consoleapi.Client) bool {
	if isDir(c.path("teams", name)) {
		c.errorAt("", fmt.Sprintf("teams/%s/ still exists: remove it in a reviewed pull request first, which retires it", name))
		return false
	}
	found, namespaceDeleted, err := console.PurgeTeam(ctx, name)
	switch {
	case err != nil:
		c.errorAt("", fmt.Sprintf("purging %s: %v", name, err))
		return false
	case !found:
		c.info("  %s: no such team", name)
	case namespaceDeleted:
		c.info("  %s: purged, with its namespace", name)
		c.summary(fmt.Sprintf("- Purged `%s`: its team and namespace.", name))
	default:
		// The console doesn't delete namespaces unless it's allowed to (its
		// teamNamespaces.purge); the namespace stays, labelled retired.
		c.info("  %s: purged; its namespace stays, labelled retired, for an operator to delete", name)
		c.summary(fmt.Sprintf("- Purged `%s`'s team. Its namespace stays, labelled retired (nothing new runs there); "+
			"a cluster administrator deletes it: `kubectl delete namespace %s`.", name, name))
	}
	return true
}

// What a team's secret-stores/*.yaml may hold (together, one team's
// SecretStores). The console applies it and enforces the same rules; this
// check tells the author on their pull request.
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

// SecretStoresApply checks, then has the console apply, each team's
// SecretStores; credential (BOOTSTRAP_CREDENTIAL) is one team's stored
// credential, so it's applied one team at a time.
func (c *Catalog) SecretStoresApply(ctx context.Context, teams []string, credential string, console *consoleapi.Client) (bool, error) {
	if credential != "" && len(teams) != 1 {
		return false, fmt.Errorf("BOOTSTRAP_CREDENTIAL is one team's: apply one team at a time with it set")
	}
	if !c.SecretStoresCheck(teams) {
		return false, nil
	}
	ok := true
	for _, team := range teams {
		documents, _ := c.secretStoreDocuments(team)
		err := console.ApplySecretStore(ctx, team, documents, credential)
		if err == nil {
			with := ""
			if credential != "" {
				with = " (with its stored credential)"
			}
			c.info("  %s: applied%s", team, with)
			continue
		}
		ok = false
		problems := []string{err.Error()}
		if r, isRefusal := err.(*consoleapi.Refusal); isRefusal && len(r.Problems) > 0 {
			problems = r.Problems
		}
		for _, p := range problems {
			c.errorAt(c.secretStoreFolder(team), team+": "+p)
		}
	}
	return ok, nil
}
