// SPDX-License-Identifier: MIT

package catalogctl

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/rburns629/acyclix/cli/internal/consoleapi"
)

// Console signs in to the console the settings name: with ACYCLIX_TOKEN (a
// bot or automation token), or in local mode as a person
// (ACYCLIX_EMAIL and ACYCLIX_PASSWORD) instead of minting a token.
func (c *Catalog) Console(ctx context.Context, s Settings) (*consoleapi.Client, error) {
	if s.Console == "" {
		return nil, errors.New("no console: set console in acyclix.yaml or ACYCLIX_CONSOLE_URL")
	}
	console := consoleapi.New(s.Console)
	if token := c.Getenv("ACYCLIX_TOKEN"); token != "" {
		console.UseToken(token)
		return console, nil
	}
	email, password := c.Getenv("ACYCLIX_EMAIL"), c.Getenv("ACYCLIX_PASSWORD")
	if email != "" && password != "" {
		if err := console.SignIn(ctx, email, password); err != nil {
			return nil, err
		}
		return console, nil
	}
	return nil, errors.New("no console credentials: set ACYCLIX_TOKEN (a bot token with products:register), " +
		"or ACYCLIX_EMAIL and ACYCLIX_PASSWORD")
}

// layoutOK checks what every product command checks first: the teams and
// CODEOWNERS (both, so one failure never hides the other).
func (c *Catalog) layoutOK() bool {
	teams := c.ValidateTeams()
	owners := c.ValidateCodeowners()
	return teams && owners
}

// Check validates, builds, tests and scans, and returns the products that
// passed all of it. Every product is tried, so one failure never hides
// another's result.
func (c *Catalog) Check(products []*Product) []*Product {
	layout := c.layoutOK()
	var passed []*Product
	for _, p := range products {
		end := c.group(p.Label())
		if c.ValidateProduct(p) && c.Build(p) && c.Test(p) && c.Scan(p) {
			c.info("PASS %s", p.Label())
			passed = append(passed, p)
		} else {
			c.info("FAIL %s", p.Label())
		}
		end()
	}
	if !layout {
		return nil
	}
	return passed
}

// Products runs validate, check or publish on the products named (or
// changed since a ref, or all), and says whether every one passed.
func (c *Catalog) Products(ctx context.Context, command string, names []string, changedSince *string) (bool, error) {
	products, err := c.SelectProducts(names, changedSince)
	if err != nil {
		return false, err
	}
	if len(products) == 0 {
		c.info("No products to check.")
		return c.layoutOK(), nil
	}
	if command == "validate" {
		ok := c.layoutOK()
		for _, p := range products {
			ok = c.ValidateProduct(p) && ok
		}
		return ok, nil
	}

	var settings Settings
	var console *consoleapi.Client
	if command == "publish" {
		if settings, err = c.Settings(); err != nil {
			return false, err
		}
		if problems := settings.Problems(); len(problems) > 0 {
			for _, p := range problems {
				c.errorAt(c.path("acyclix.yaml"), p)
			}
			return false, nil
		}
		var templates []string
		var publishable []*Product
		for _, p := range products {
			if p.IsTemplate() {
				templates = append(templates, p.Label())
			} else {
				publishable = append(publishable, p)
			}
		}
		if len(templates) > 0 && len(names) > 0 {
			return false, fmt.Errorf("templates are checked, never published: %s", strings.Join(templates, ", "))
		}
		products = publishable
		if console, err = c.Console(ctx, settings); err != nil {
			return false, err
		}
	}

	passed := c.Check(products)
	if command != "publish" {
		c.info("\n%d of %d product(s) passed.", len(passed), len(products))
		return len(passed) == len(products), nil
	}
	published := 0
	for _, p := range passed {
		if c.Publish(ctx, p, settings, console) {
			published++
		}
	}
	c.info("\nPublished %d of %d product(s).", published, len(products))
	return published == len(products), nil
}

// TeamsConsole is the console for the team and SecretStore commands, which
// only call it: it creates, retires and purges namespaces and applies
// SecretStores, so neither CI nor a laptop needs cluster credentials.
func (c *Catalog) TeamsConsole(ctx context.Context) (*consoleapi.Client, error) {
	settings, err := c.Settings()
	if err != nil {
		return nil, err
	}
	return c.Console(ctx, settings)
}
