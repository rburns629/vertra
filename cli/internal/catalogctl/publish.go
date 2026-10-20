// SPDX-License-Identifier: MIT

package catalogctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/rburns629/acyclix/cli/internal/consoleapi"
	consolev1 "github.com/rburns629/acyclix/cli/internal/gen/acyclix/console/v1"
)

// versionTag is what CI tags with (the commit) or a laptop (the time; no
// commit need exist). Either way the registration pins the digest.
func (c *Catalog) versionTag() string {
	if sha := c.Getenv("GITHUB_SHA"); sha != "" {
		return sha
	}
	return time.Now().UTC().Format("local-20060102T150405Z")
}

// push pushes the checked image, tagged with its version and latest (so a
// DAG can name <registry>/<team>/<product>:latest; the console pins
// whatever that names to its digest at submission), and returns the digest
// reference, which is what's registered.
func (c *Catalog) push(p *Product, s Settings) (string, error) {
	repository := p.Repository(s)
	tagged := repository + ":" + c.versionTag()
	for _, args := range [][]string{
		{"tag", p.LocalImage(), tagged}, {"push", tagged},
		{"tag", p.LocalImage(), repository + ":latest"}, {"push", repository + ":latest"},
	} {
		if _, err := c.docker(false, args...); err != nil {
			return "", err
		}
	}
	result, err := c.docker(true, "inspect", "--format", "{{json .RepoDigests}}", tagged)
	if err != nil {
		return "", err
	}
	var digests []string
	_ = json.Unmarshal([]byte(result.stdout), &digests)
	for _, reference := range digests {
		if strings.HasPrefix(reference, repository+"@sha256:") {
			c.info("  pushed %s -> %s", tagged, reference)
			return reference, nil
		}
	}
	return "", fmt.Errorf("pushed %s but found no digest for it", tagged)
}

// sign signs by digest: a tag can move, a digest is the bytes that passed.
func (c *Catalog) sign(reference string, s Settings) error {
	if s.SigningMode == "none" {
		return nil
	}
	cosign, err := exec.LookPath("cosign")
	if err != nil {
		return errors.New("signing needs cosign installed (.github/scripts/install-scanners.sh cosign)")
	}
	var args []string
	if s.SigningMode == "key" {
		// No public transparency log: verification uses the public key. The
		// legacy signature format, which policy-controller reads.
		args = []string{"--key", s.SigningKey, "--use-signing-config=false", "--tlog-upload=false", "--new-bundle-format=false"}
	} else {
		args = []string{"--new-bundle-format=false"} // keyless: CI's OIDC identity, logged publicly
	}
	result, err := c.run(0, false, cosign, append(append([]string{"sign", "--yes"}, args...), reference)...)
	if err == nil && result.code != 0 {
		err = fmt.Errorf("cosign sign failed (exit %d)", result.code)
	}
	if err != nil {
		return err
	}
	c.info("  signed %s", reference)
	return nil
}

func text(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Registrations are a product's registrations, one per action, named
// <team>-<product>-<action>, carrying everything in product.yaml the
// console uses.
func (p *Product) Registrations(reference string) ([]*consolev1.RegisterProductRequest, error) {
	var out []*consolev1.RegisterProductRequest
	for _, action := range p.Actions() {
		name := text(action, "name")
		input, err := consoleapi.StructOf(action["input"])
		if err != nil {
			return nil, fmt.Errorf("action %s's input schema: %w", name, err)
		}
		output, err := consoleapi.StructOf(action["output"])
		if err != nil {
			return nil, fmt.Errorf("action %s's output schema: %w", name, err)
		}
		displayName, description := text(action, "displayName"), text(action, "description")
		if displayName == "" {
			displayName = text(p.Spec, "displayName")
		}
		if description == "" {
			description = text(p.Spec, "description")
		}
		team := p.Team()
		req := &consolev1.RegisterProductRequest{
			Name:           fmt.Sprintf("%s-%s-%s", p.Team(), p.Name(), name),
			Image:          reference,
			Action:         name,
			Team:           &team,
			InputSchema:    input,
			OutputSchema:   output,
			DisplayName:    optional(displayName),
			Description:    optional(description),
			ServiceAccount: optional(text(p.Spec, "serviceAccount")),
		}
		secrets, _ := action["requiredSecrets"].([]any)
		for _, s := range secrets {
			if m, ok := s.(map[string]any); ok {
				req.RequiredSecrets = append(req.RequiredSecrets, text(m, "name"))
			}
		}
		if r, ok := p.Spec["resources"].(map[string]any); ok && len(r) > 0 {
			req.Resources = &consolev1.TaskResources{
				Cpu: optional(text(r, "cpu")), Memory: optional(text(r, "memory")), MemoryLimit: optional(text(r, "memoryLimit")),
			}
		}
		out = append(out, req)
	}
	return out, nil
}

// Publish pushes, signs and registers a checked product.
func (c *Catalog) Publish(ctx context.Context, p *Product, s Settings, console *consoleapi.Client) bool {
	reference, err := c.push(p, s)
	if err == nil {
		err = c.sign(reference, s)
	}
	var registrations []*consolev1.RegisterProductRequest
	if err == nil {
		registrations, err = p.Registrations(reference)
	}
	for _, r := range registrations {
		if err != nil {
			break
		}
		if err = console.RegisterProduct(ctx, r); err == nil {
			c.info("  registered %s", r.GetName())
		}
	}
	if err != nil {
		c.errorAt(p.Dir, "publishing failed: "+err.Error())
		return false
	}
	c.summary(fmt.Sprintf("- Published `%s` as `%s`", p.Label(), reference))
	return true
}
