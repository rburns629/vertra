// SPDX-License-Identifier: MIT

package awscloud

import (
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// What `aws kms get-public-key --query PublicKey --output json` prints for
// an ECC P-256 key.
const kmsOutput = `"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEV0MlshO74h+iZFgGKy09pndK76GSsojjUMe+Vyrww4ZvnE8clQx/DnPd8mTfhY0cNuV/ZqF6uXWKdheFoeJbWg=="
`

func TestPublicKeyPEM(t *testing.T) {
	got, err := publicKeyPEM(kmsOutput)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(got))
	if block == nil || block.Type != "PUBLIC KEY" {
		t.Fatalf("not a PEM public key: %q", got)
	}
	if _, err := x509.ParsePKIXPublicKey(block.Bytes); err != nil {
		t.Errorf("not a parseable key: %v", err)
	}
	if _, err := publicKeyPEM(`"not base64!"`); err == nil {
		t.Error("garbage accepted")
	}
}
