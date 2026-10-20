// SPDX-License-Identifier: MIT

package catalogctl

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Settings say where products go: acyclix.yaml, each overridable by an
// environment variable (CI sets them from the repository's variables).
type Settings struct {
	Registry    string
	Console     string
	SigningMode string
	SigningKey  string
}

// Settings reads acyclix.yaml (if any) and the environment.
func (c *Catalog) Settings() (Settings, error) {
	var file struct {
		Registry string `yaml:"registry"`
		Console  string `yaml:"console"`
		Signing  struct {
			Mode string `yaml:"mode"`
			Key  string `yaml:"key"`
		} `yaml:"signing"`
	}
	data, err := os.ReadFile(c.path("acyclix.yaml"))
	if err == nil {
		if err := yaml.Unmarshal(data, &file); err != nil {
			return Settings{}, fmt.Errorf("acyclix.yaml: not valid YAML: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return Settings{}, err
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
		Registry:    or("ACYCLIX_REGISTRY", file.Registry),
		Console:     or("ACYCLIX_CONSOLE_URL", file.Console),
		SigningMode: or("ACYCLIX_SIGNING_MODE", mode),
		SigningKey:  or("ACYCLIX_SIGNING_KEY", file.Signing.Key),
	}, nil
}

// Problems are what stops publishing with these settings.
func (s Settings) Problems() []string {
	var found []string
	switch {
	case s.Registry == "":
		found = append(found, "no registry: set registry in acyclix.yaml or ACYCLIX_REGISTRY")
	case strings.Contains(s.Registry, "://") || strings.HasSuffix(s.Registry, "/"):
		found = append(found, fmt.Sprintf("registry %s: a path like host[:port]/path, no scheme or trailing /", quote(s.Registry)))
	}
	if s.Console == "" {
		found = append(found, "no console: set console in acyclix.yaml or ACYCLIX_CONSOLE_URL")
	}
	if s.SigningMode != "none" && s.SigningMode != "key" && s.SigningMode != "keyless" {
		found = append(found, fmt.Sprintf("signing mode %s: one of none, key, keyless", quote(s.SigningMode)))
	}
	if s.SigningMode == "key" && s.SigningKey == "" {
		found = append(found, "signing mode key needs a key: signing.key or ACYCLIX_SIGNING_KEY")
	}
	return found
}
