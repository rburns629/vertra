// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
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
