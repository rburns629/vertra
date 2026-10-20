// SPDX-License-Identifier: MIT

package catalogctl

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Settings say where products go: vertra.yaml, each overridable by an
// environment variable (CI sets them from the repository's variables).
type Settings struct {
	Registry    string
	SigningMode string
	SigningKey  string
}

// FormerSettingsFile is vertra.yaml's name until the platform was renamed
// Vertra (2026-10-20).
const FormerSettingsFile = "acyclix.yaml"

// Settings reads vertra.yaml (if any) and the environment.
func (c *Catalog) Settings() (Settings, error) {
	var file struct {
		Registry string `yaml:"registry"`
		Signing  struct {
			Mode string `yaml:"mode"`
			Key  string `yaml:"key"`
		} `yaml:"signing"`
	}
	data, err := os.ReadFile(c.path("vertra.yaml"))
	if err == nil {
		if err := yaml.Unmarshal(data, &file); err != nil {
			return Settings{}, fmt.Errorf("vertra.yaml: not valid YAML: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return Settings{}, err
	} else if _, err := os.Stat(c.path(FormerSettingsFile)); err == nil {
		// Never read past silently: its registry would be lost.
		return Settings{}, fmt.Errorf("%s: renamed vertra.yaml on 2026-10-20: ./catalogctl migrate renames it", FormerSettingsFile)
	}
	or := func(env, fallback string) string {
		if v := c.Getenv(env); v != "" {
			return v
		}
		return fallback
	}
	mode := file.Signing.Mode
	if mode == "" {
		mode = "none"
	}
	return Settings{
		Registry:    or("VERTRA_REGISTRY", file.Registry),
		SigningMode: or("VERTRA_SIGNING_MODE", mode),
		SigningKey:  or("VERTRA_SIGNING_KEY", file.Signing.Key),
	}, nil
}

// Problems are what stops publishing with these settings.
func (s Settings) Problems() []string {
	var found []string
	switch {
	case s.Registry == "":
		found = append(found, "no registry: set registry in vertra.yaml or VERTRA_REGISTRY")
	case strings.Contains(s.Registry, "://") || strings.HasSuffix(s.Registry, "/"):
		found = append(found, fmt.Sprintf("registry %s: a path like host[:port]/path, no scheme or trailing /", quote(s.Registry)))
	}
	if s.SigningMode != "none" && s.SigningMode != "key" && s.SigningMode != "keyless" {
		found = append(found, fmt.Sprintf("signing mode %s: one of none, key, keyless", quote(s.SigningMode)))
	}
	if s.SigningMode == "key" && s.SigningKey == "" {
		found = append(found, "signing mode key needs a key: signing.key or VERTRA_SIGNING_KEY")
	}
	return found
}
