// SPDX-License-Identifier: MIT

package catalogctl

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
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

// Publish pushes and signs a checked product. Nothing is registered: the
// catalog's release (release.go) names it, and each console pulls that.
func (c *Catalog) Publish(p *Product, s Settings) bool {
	reference, err := c.push(p, s)
	if err == nil {
		err = c.sign(reference, s)
	}
	if err != nil {
		c.errorAt(p.Dir, "publishing failed: "+err.Error())
		return false
	}
	c.summary(fmt.Sprintf("- Published `%s` as `%s`", p.Label(), reference))
	return true
}
