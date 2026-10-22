// SPDX-License-Identifier: MIT

package credentials

import (
	"context"
	"testing"
	"time"
)

func TestServiceAccountTokensAreMintedAndKeptMostOfTheirLife(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	var asked []string
	m := &Minter{Now: func() time.Time { return now }, TokenRequest: func(_ context.Context, ns, sa, aud string) (string, time.Time, error) {
		asked = append(asked, ns+"/"+sa+"/"+aud)
		return "token-" + aud, now.Add(TokenLifetime), nil
	}}
	auth := map[string]map[string]string{"serviceAccountToken": {"audience": "orders"}}
	name, value, err := m.Header(context.Background(), "payments", "orders-api", auth)
	if err != nil || name != "Authorization" || value != "Bearer token-orders" {
		t.Fatalf("%s %s %v", name, value, err)
	}
	now = now.Add(7 * time.Minute)
	_, _, _ = m.Header(context.Background(), "payments", "orders-api", auth)
	now = now.Add(2 * time.Minute)
	_, _, _ = m.Header(context.Background(), "payments", "orders-api", auth)
	if len(asked) != 2 || asked[0] != "payments/orders-api/orders" {
		t.Errorf("asked %v: once, then again past four fifths of its life", asked)
	}
	if name, _, err := m.Header(context.Background(), "payments", "orders-api", nil); err != nil || name != "" {
		t.Errorf("no backend.auth: %q %v", name, err)
	}
	if _, _, err := m.Header(context.Background(), "payments", "orders-api", map[string]map[string]string{"googleIdToken": {}}); err != ErrUnsupported {
		t.Errorf("not yet: %v", err)
	}
}
