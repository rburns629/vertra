// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/config"
)

// The catalog repository's CI is told catalog-template's modes: key (with
// the install's KMS key), keyless, or none.
func TestSigningVariables(t *testing.T) {
	c := &config.Config{}
	for signing, want := range map[string][][2]string{
		"":        {{"VERTRA_SIGNING_MODE", "none"}},
		"kms":     {{"VERTRA_SIGNING_MODE", "key"}, {"VERTRA_SIGNING_KEY", "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k"}},
		"keyless": {{"VERTRA_SIGNING_MODE", "keyless"}},
	} {
		c.Signing = signing
		if got := signingVariables(c, "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k"); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%q: %v, want %v", signing, got, want)
		}
	}
}

// A repository has one owner: one publishing to another install's registry
// is refused unless taken over on purpose; a new or this install's isn't.
func TestOwnedElsewhere(t *testing.T) {
	ours := "us-central1-docker.pkg.dev/p/vertra-test-products"
	for _, current := range []string{"", ours} {
		if err := ownedElsewhere("my-org/catalog", current, ours, false); err != nil {
			t.Errorf("%q: %v", current, err)
		}
	}
	prod := "us-central1-docker.pkg.dev/p/vertra-prod-products"
	err := ownedElsewhere("my-org/catalog", prod, ours, false)
	if err == nil || !strings.Contains(err.Error(), "externalCatalog.registry "+prod) || !strings.Contains(err.Error(), "--take-over") {
		t.Errorf("another's: %v", err)
	}
	if err := ownedElsewhere("my-org/catalog", prod, ours, true); err != nil {
		t.Errorf("taken over: %v", err)
	}
}
