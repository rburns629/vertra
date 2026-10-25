// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A dags/ file is one of two kinds:
//
//   - Template: what a consumer runs, filling in only its parameters. Steps
//     name actions (<product>.<action> of the team, <team>/<product>.<action>
//     of another team that shares it), never images.
//   - Dag: a concrete DAG exactly as the console's Submit page takes it, for
//     examples and walkthroughs.

// DagFiles are every team's dags/ files, and the starters'.
func (c *Catalog) DagFiles() []string {
	var files []string
	for _, pattern := range []string{"teams/*/dags/*.yaml", "templates/dags/*.yaml"} {
		files = append(files, c.glob(pattern)...)
	}
	return files
}

// dagTeam is the team a dags/ file belongs to: its team folder's name, or
// "templates" for the starters (which stand in for whichever team copies
// them, as their products do).
func (c *Catalog) dagTeam(path string) string {
	rel := strings.Split(c.rel(path), "/")
	if rel[0] == "teams" && len(rel) > 1 {
		return rel[1]
	}
	return "templates"
}

// actionIndex is every action in the catalog by "<team>/<product>.<action>",
// read from each product.yaml that parses (one that doesn't has its own
// errors from ValidateProduct).
func (c *Catalog) actionIndex() map[string]map[string]any {
	index := map[string]map[string]any{}
	for _, p := range c.AllProducts() {
		data, err := os.ReadFile(filepath.Join(p.Dir, "product.yaml"))
		if err != nil {
			continue
		}
		doc, problem := loadYAML(data)
		spec, ok := doc.(map[string]any)
		if problem != "" || !ok {
			continue
		}
		product := &Product{Dir: p.Dir, Spec: spec}
		for _, action := range product.Actions() {
			index[fmt.Sprintf("%s/%s.%s", p.Team(), p.Name(), text(action, "name"))] = action
		}
	}
	return index
}

// ValidateDags checks every dags/ file: its kind, its schema, and for a
// template, that every action it names exists, is shared with its team, and
// gets the inputs it needs from values, parameters or earlier steps.
func (c *Catalog) ValidateDags() bool {
	files := c.DagFiles()
	if len(files) == 0 {
		return true
	}
	index := c.actionIndex()
	ok := true
	for _, path := range files {
		data, err := os.ReadFile(path)
		var problems []string
		if err != nil {
			problems = []string{err.Error()}
		} else {
			doc, problem := loadYAML(data)
			if problem == "" {
				problem = formatProblem(doc, "Template", "Dag")
			}
			switch {
			case problem != "":
				problems = []string{problem}
			case doc.(map[string]any)["kind"] == "Template":
				problems = templateProblems(c.dagTeam(path), strings.TrimSuffix(filepath.Base(path), ".yaml"), doc, index)
				if len(problems) == 0 {
					steps, _ := doc.(map[string]any)["steps"].([]any)
					c.deprecationNotes(path, c.dagTeam(path), steps, index)
				}
			default:
				problems = dagProblems(doc)
			}
		}
		for _, p := range problems {
			c.errorAt(path, p)
		}
		ok = ok && len(problems) == 0
	}
	return ok
}

// stepGraphProblems checks ids are unique, dependencies exist, and there's
// no cycle; deps maps each id to what it depends on.
func stepGraphProblems(noun string, ids []string, deps map[string][]string) []string {
	var problems []string
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			problems = append(problems, fmt.Sprintf("two %ss are called %s", noun, quote(id)))
		}
		seen[id] = true
	}
	for _, id := range ids {
		for _, d := range deps[id] {
			if !seen[d] {
				problems = append(problems, fmt.Sprintf("%s %s depends on %s, which isn't a %s here", noun, id, quote(d), noun))
			} else if d == id {
				problems = append(problems, fmt.Sprintf("%s %s depends on itself", noun, id))
			}
		}
	}
	// A cycle: some step that can't be reached from the ones with no
	// dependencies, in dependency order.
	done := map[string]bool{}
	for progress := true; progress; {
		progress = false
		for _, id := range ids {
			if done[id] {
				continue
			}
			ready := true
			for _, d := range deps[id] {
				if seen[d] && !done[d] {
					ready = false
				}
			}
			if ready {
				done[id] = true
				progress = true
			}
		}
	}
	var stuck []string
	for _, id := range ids {
		if !done[id] {
			stuck = append(stuck, id)
		}
	}
	if len(stuck) > 0 {
		problems = append(problems, fmt.Sprintf("%ss %s depend on each other in a cycle", noun, strings.Join(stuck, ", ")))
	}
	return problems
}

func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		out = append(out, fmt.Sprint(x))
	}
	return out
}

// schemaKeys is a JSON Schema object's declared properties, and whether
// others are refused (additionalProperties: false).
func schemaKeys(schema any) (props map[string]bool, closed bool) {
	m, _ := schema.(map[string]any)
	props = map[string]bool{}
	p, _ := m["properties"].(map[string]any)
	for k := range p {
		props[k] = true
	}
	return props, m["additionalProperties"] == false
}

func templateProblems(team, stem string, doc any, index map[string]map[string]any) []string {
	if problems := schemaErrors(templateSchema(), doc); len(problems) > 0 {
		return problems
	}
	t := doc.(map[string]any)
	var problems []string
	if name := text(t, "name"); name != stem {
		problems = append(problems, fmt.Sprintf("name %s isn't the file's name, %s", quote(name), quote(stem)))
	}
	if why := schemaProblem(t["parameters"]); why != "" {
		problems = append(problems, "parameters isn't a valid JSON Schema: "+why)
	} else {
		problems = append(problems, exampleProblems(t)...)
	}
	params, _ := schemaKeys(t["parameters"])

	steps, _ := t["steps"].([]any)
	var ids []string
	deps := map[string][]string{}
	actionOf := map[string]map[string]any{}
	for _, s := range steps {
		step := s.(map[string]any)
		id := text(step, "id")
		ids = append(ids, id)
		deps[id] = stringList(step["dependsOn"])
		ref := text(step, "action")
		if !strings.Contains(ref, "/") {
			ref = team + "/" + ref
		}
		action := index[ref]
		switch {
		case action == nil:
			problems = append(problems, fmt.Sprintf("step %s: no action %s in this catalog", id, ref))
		case !strings.HasPrefix(ref, team+"/"):
			shared := stringList(action["shareWith"])
			if !contains(shared, "*") && !contains(shared, team) {
				problems = append(problems, fmt.Sprintf("step %s: %s isn't shared with team %s (its shareWith in product.yaml)", id, ref, team))
			}
		}
		actionOf[id] = action
	}
	problems = append(problems, stepGraphProblems("step", ids, deps)...)

	for _, s := range steps {
		step := s.(map[string]any)
		id := text(step, "id")
		action := actionOf[id]
		inputs, _ := step["inputs"].(map[string]any)
		names := make([]string, 0, len(inputs))
		for k := range inputs {
			names = append(names, k)
		}
		sort.Strings(names)
		if action != nil {
			declared, closed := schemaKeys(action["input"])
			for _, k := range names {
				if closed && !declared[k] {
					problems = append(problems, fmt.Sprintf("step %s: input %s isn't one its action takes", id, quote(k)))
				}
			}
			inputSchema, _ := action["input"].(map[string]any)
			for _, required := range stringList(inputSchema["required"]) {
				if _, given := inputs[required]; !given {
					problems = append(problems, fmt.Sprintf("step %s: its action needs input %s", id, quote(required)))
				}
			}
		}
		for _, k := range names {
			ref, isRef := inputs[k].(map[string]any)
			if !isRef {
				continue
			}
			if p, ok := ref["$param"]; ok {
				if name, _ := p.(string); !params[name] {
					problems = append(problems, fmt.Sprintf("step %s: input %s uses parameter %s, which parameters doesn't declare", id, quote(k), pyRepr(p)))
				}
			}
			if from, ok := ref["$fromStep"]; ok {
				source, _ := from.(string)
				output, _ := ref["$output"].(string)
				switch {
				case !contains(deps[id], source):
					problems = append(problems, fmt.Sprintf("step %s: input %s uses step %s's output, but doesn't depend on it (dependsOn)", id, quote(k), pyRepr(from)))
				case output == "":
					problems = append(problems, fmt.Sprintf("step %s: input %s names no $output of step %s", id, quote(k), source))
				case actionOf[source] != nil:
					outputs, _ := schemaKeys(actionOf[source]["output"])
					if len(outputs) > 0 && !outputs[output] {
						problems = append(problems, fmt.Sprintf("step %s: input %s uses output %s, which step %s's action doesn't declare", id, quote(k), quote(output), source))
					}
				}
			}
		}
	}
	return problems
}

// exampleProblems: each of a template's examples has a name of its own and
// parameters its parameters take, and is small enough for a release.
func exampleProblems(t map[string]any) []string {
	examples, _ := t["examples"].([]any)
	if len(examples) == 0 {
		return nil
	}
	parameters, err := compile("embedded:///parameters.json", t["parameters"])
	if err != nil {
		return nil // reported as the parameters' own problem
	}
	var problems []string
	seen := map[string]bool{}
	for _, raw := range examples {
		example := raw.(map[string]any)
		name := text(example, "name")
		if seen[name] {
			problems = append(problems, fmt.Sprintf("example %s: another example has this name", quote(name)))
		}
		seen[name] = true
		for _, why := range schemaErrors(parameters, example["parameters"]) {
			problems = append(problems, fmt.Sprintf("example %s: %s", quote(name), why))
		}
		if data, _ := json.Marshal(example["parameters"]); len(data) > maxExampleBytes {
			problems = append(problems, fmt.Sprintf("example %s: over %d bytes", quote(name), maxExampleBytes))
		}
	}
	return problems
}

func dagProblems(doc any) []string {
	if problems := schemaErrors(dagSchema(), doc); len(problems) > 0 {
		return problems
	}
	tasks, _ := doc.(map[string]any)["tasks"].([]any)
	var ids []string
	deps := map[string][]string{}
	for _, t := range tasks {
		task := t.(map[string]any)
		id := text(task, "id")
		ids = append(ids, id)
		deps[id] = stringList(task["dependsOn"])
	}
	problems := stepGraphProblems("task", ids, deps)
	for _, t := range tasks {
		task := t.(map[string]any)
		inputs, _ := task["inputs"].(map[string]any)
		for k, v := range inputs {
			ref, isRef := v.(map[string]any)
			if from, ok := ref["$fromTask"]; isRef && ok && !contains(deps[text(task, "id")], fmt.Sprint(from)) {
				problems = append(problems, fmt.Sprintf("task %s: input %s uses task %s's output, but doesn't depend on it (dependsOn)",
					text(task, "id"), quote(k), pyRepr(from)))
			}
		}
	}
	return problems
}
