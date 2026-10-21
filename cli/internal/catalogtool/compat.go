// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"sort"
	"strings"
)

// Compatibility: a product's contract (its actions, their input and output
// schemas, who it's shared with) is what other teams' templates rely on, so
// a change that could break them is refused unless the product says so by
// raising its version. The last release is the product as it is at base,
// which is what main publishes; so CI, a laptop and a publish all agree.
//
// Breaking: an action removed; a new required input, an input no longer
// accepted, an input retyped, or the input schema newly closed; an output
// removed, retyped or no longer guaranteed; a team no longer shared with.
// A product or action may only be removed once its last release was
// deprecated (deprecate, publish, then remove).

// Compatibility checks the products changed since base, and products
// removed since then, and says whether every change is allowed.
func (c *Catalog) Compatibility(base string, products []*Product) bool {
	if !c.usableBase(base) {
		return true
	}
	ok := true
	for _, p := range products {
		if p.Spec == nil {
			continue // invalid: ValidateProduct has said why
		}
		before, found := c.specAt(base, p.Label()+"/product.yaml")
		if !found {
			continue // new
		}
		breaks := compatibilityBreaks(before, p.Spec)
		if len(breaks) == 0 {
			continue
		}
		was, now := versionOf(before), versionOf(p.Spec)
		if now > was {
			c.info("  %s: version %d → %d, for %d breaking change(s)", p.Label(), was, now, len(breaks))
			continue
		}
		for _, b := range breaks {
			c.errorAt(p.Dir+"/product.yaml", fmt.Sprintf("%s: other teams' templates may rely on it; if the change is meant, raise version (now %d) to %d", b, was, was+1))
		}
		ok = false
	}
	// Products whose folder is gone. A whole team folder removed is the
	// team being retired, which has its own reviewed workflow.
	out, err := c.git("ls-tree", "-r", "--name-only", base, "--", "teams/")
	if err != nil {
		return ok
	}
	for _, path := range strings.Split(strings.TrimSpace(out), "\n") {
		if !strings.HasSuffix(path, "/product.yaml") || strings.Count(path, "/") != 4 || exists(c.path(path)) {
			continue
		}
		if team := strings.Split(path, "/")[1]; !isDir(c.path("teams", team)) {
			continue
		}
		before, found := c.specAt(base, path)
		if found && text(before, "deprecated") == "" {
			c.errorAt("", fmt.Sprintf("%s: removed without being deprecated first: mark it deprecated (deprecated: <what to use instead>), publish that, then remove it", strings.TrimSuffix(path, "/product.yaml")))
			ok = false
		}
	}
	return ok
}

func (c *Catalog) specAt(base, path string) (map[string]any, bool) {
	out, err := c.git("show", base+":"+path)
	if err != nil {
		return nil, false
	}
	doc, problem := loadYAML([]byte(out))
	spec, isMap := doc.(map[string]any)
	return spec, problem == "" && isMap
}

func versionOf(spec map[string]any) int {
	var v int
	if _, err := fmt.Sscan(fmt.Sprint(spec["version"]), &v); err != nil || v < 1 {
		return 1
	}
	return v
}

func actionsByName(spec map[string]any) map[string]map[string]any {
	byName := map[string]map[string]any{}
	for _, a := range (&Product{Spec: spec}).Actions() {
		byName[text(a, "name")] = a
	}
	return byName
}

// schemaParts is an object schema's properties' types, its required list,
// and whether it refuses properties it doesn't declare.
func schemaParts(schema any) (types map[string]string, required map[string]bool, closed bool) {
	m, _ := schema.(map[string]any)
	types, required = map[string]string{}, map[string]bool{}
	props, _ := m["properties"].(map[string]any)
	for name, p := range props {
		prop, _ := p.(map[string]any)
		types[name] = fmt.Sprint(prop["type"])
	}
	for _, r := range stringList(m["required"]) {
		required[r] = true
	}
	return types, required, m["additionalProperties"] == false
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func compatibilityBreaks(before, after map[string]any) []string {
	var breaks []string
	was, now := actionsByName(before), actionsByName(after)
	for _, name := range sortedKeys(was) {
		old := was[name]
		cur, kept := now[name]
		if !kept {
			if text(old, "deprecated") == "" && text(before, "deprecated") == "" {
				breaks = append(breaks, fmt.Sprintf("action %s was removed without being deprecated first", name))
			}
			continue
		}
		at := "action " + name

		oldIn, oldReq, oldClosed := schemaParts(old["input"])
		newIn, newReq, newClosed := schemaParts(cur["input"])
		for _, r := range sortedKeys(newReq) {
			if !oldReq[r] {
				breaks = append(breaks, fmt.Sprintf("%s: input %s is newly required", at, quote(r)))
			}
		}
		for _, in := range sortedKeys(oldIn) {
			newType, still := newIn[in]
			switch {
			case !still && newClosed:
				breaks = append(breaks, fmt.Sprintf("%s: input %s is no longer accepted", at, quote(in)))
			case still && newType != oldIn[in]:
				breaks = append(breaks, fmt.Sprintf("%s: input %s changed type, %s → %s", at, quote(in), oldIn[in], newType))
			}
		}
		if newClosed && !oldClosed {
			breaks = append(breaks, fmt.Sprintf("%s: its input no longer accepts properties it doesn't declare (additionalProperties: false)", at))
		}

		oldOut, oldOutReq, _ := schemaParts(old["output"])
		newOut, newOutReq, _ := schemaParts(cur["output"])
		for _, out := range sortedKeys(oldOut) {
			newType, still := newOut[out]
			switch {
			case !still:
				breaks = append(breaks, fmt.Sprintf("%s: output %s was removed", at, quote(out)))
			case newType != oldOut[out]:
				breaks = append(breaks, fmt.Sprintf("%s: output %s changed type, %s → %s", at, quote(out), oldOut[out], newType))
			case oldOutReq[out] && !newOutReq[out]:
				breaks = append(breaks, fmt.Sprintf("%s: output %s is no longer always returned (not in required)", at, quote(out)))
			}
		}

		oldShare, newShare := stringList(old["shareWith"]), stringList(cur["shareWith"])
		if !contains(newShare, "*") {
			for _, team := range oldShare {
				if !contains(newShare, team) {
					breaks = append(breaks, fmt.Sprintf("%s: no longer shared with %s", at, quote(team)))
				}
			}
		}
	}
	return breaks
}

// deprecationNotes warns about template steps that use a deprecated action.
func (c *Catalog) deprecationNotes(path, team string, steps []any, index map[string]map[string]any) {
	for _, s := range steps {
		step, _ := s.(map[string]any)
		ref := text(step, "action")
		if !strings.Contains(ref, "/") {
			ref = team + "/" + ref
		}
		if action := index[ref]; action != nil && text(action, "deprecated") != "" {
			c.warnAt(path, fmt.Sprintf("step %s uses %s, which is deprecated: %s", text(step, "id"), ref, text(action, "deprecated")))
		}
	}
}
