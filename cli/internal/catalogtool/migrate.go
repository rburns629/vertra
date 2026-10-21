// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

var (
	topLevelAPIVersion = regexp.MustCompile(`(?m)^apiVersion:`)
	formerAPIVersion   = regexp.MustCompile(`(?m)^apiVersion:[ \t]*["']?` + regexp.QuoteMeta(FormerAPIVersion) + `["']?[ \t]*$`)
)

// Migrate rewrites a catalog written in the format from before v2: each
// team.yaml, product.yaml and dags/ file gets its apiVersion and kind, and
// an action's requiredSecrets becomes its secretRefs. A catalog from before
// the platform was renamed Vertra (2026-10-20) gets the new apiVersion, and
// its acyclix.yaml becomes vertra.yaml. It edits the text, so comments and
// layout stay as they were; a file already current is left alone. Teams,
// the starters and the samples are all rewritten. It returns how many files
// changed, and what it couldn't do.
func (c *Catalog) Migrate() (int, []string, error) {
	type target struct {
		patterns []string
		kind     func(doc map[string]any) string
	}
	fixed := func(kind string) func(map[string]any) string { return func(map[string]any) string { return kind } }
	targets := []target{
		{[]string{"teams/*/team.yaml", "templates/*/team.yaml", "samples/*/team.yaml"}, fixed("Team")},
		{[]string{"teams/*/products/*/product.yaml", "templates/*/product.yaml", "samples/*/products/*/product.yaml"}, fixed("Product")},
		{[]string{"teams/*/dags/*.yaml", "templates/dags/*.yaml", "samples/*/dags/*.yaml"}, func(doc map[string]any) string {
			if _, ok := doc["tasks"]; ok {
				return "Dag"
			}
			return ""
		}},
	}
	changed := 0
	var problems []string
	if _, err := os.Stat(c.path(FormerSettingsFile)); err == nil {
		if _, err := os.Stat(c.path("vertra.yaml")); err == nil {
			problems = append(problems, FormerSettingsFile+": vertra.yaml exists too; merge them by hand")
		} else if err := os.Rename(c.path(FormerSettingsFile), c.path("vertra.yaml")); err != nil {
			return changed, problems, err
		} else {
			c.info("  %s: renamed vertra.yaml", FormerSettingsFile)
			changed++
		}
	}
	for _, t := range targets {
		for _, pattern := range t.patterns {
			for _, path := range c.glob(pattern) {
				data, err := os.ReadFile(path)
				if err != nil {
					return changed, problems, err
				}
				text := string(data)
				if formerAPIVersion.MatchString(text) {
					text = formerAPIVersion.ReplaceAllString(text, "apiVersion: "+APIVersion)
					if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
						return changed, problems, err
					}
					c.info("  %s: apiVersion %s", c.rel(path), APIVersion)
					changed++
					continue
				}
				if topLevelAPIVersion.MatchString(text) {
					continue
				}
				doc, problem := loadYAML(data)
				m, ok := doc.(map[string]any)
				if problem != "" || !ok {
					problems = append(problems, fmt.Sprintf("%s: not valid YAML, left as it is: %s", c.rel(path), problem))
					continue
				}
				kind := t.kind(m)
				if kind == "" {
					problems = append(problems, fmt.Sprintf("%s: not a DAG (no tasks): give it apiVersion %s and its kind by hand", c.rel(path), APIVersion))
					continue
				}
				if kind == "Product" {
					text = strings.ReplaceAll(text, "requiredSecrets", "secretRefs")
				}
				text = withHeader(text, kind)
				// Still the same document, plus its header.
				if after, problem := loadYAML([]byte(text)); problem != "" || formatProblem(after, kind) != "" {
					problems = append(problems, fmt.Sprintf("%s: couldn't be rewritten safely; left as it is", c.rel(path)))
					continue
				}
				if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
					return changed, problems, err
				}
				c.info("  %s: %s", c.rel(path), kind)
				changed++
			}
		}
	}
	return changed, problems, nil
}

// withHeader puts apiVersion and kind at the top of a YAML document, after
// the comment block it starts with, which describes the file and so stays
// first.
func withHeader(text, kind string) string {
	lines := strings.SplitAfter(text, "\n")
	i := 0
	for i < len(lines) && (strings.HasPrefix(lines[i], "#") || strings.TrimSpace(lines[i]) == "") {
		i++
	}
	header := fmt.Sprintf("apiVersion: %s\nkind: %s\n", APIVersion, kind)
	return strings.Join(lines[:i], "") + header + strings.Join(lines[i:], "")
}
