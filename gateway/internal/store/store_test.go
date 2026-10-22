// SPDX-License-Identifier: MIT

package store

import (
	"net/url"
	"testing"
)

func TestARequestIsNamedByTheOperationItMatched(t *testing.T) {
	a := &API{Endpoints: endpoints([]byte(`{"paths": {
		"/orders/{orderId}": {"get": {}, "parameters": []},
		"/orders": {"post": {}},
		"/a.b/{x}/refunds": {"put": {}}}}`))}
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/orders/ord_1", "GET /orders/{orderId}"},
		{"GET", "/orders/ord_1/", "GET /orders/{orderId}"},
		{"POST", "/orders", "POST /orders"},
		{"PUT", "/a.b/7/refunds", "PUT /a.b/{x}/refunds"},
		{"PUT", "/aXb/7/refunds", ""},
		{"DELETE", "/orders/1", ""},
		{"GET", "/orders/1/2", ""},
	} {
		if got := a.Match(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s: %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestBackendHosts(t *testing.T) {
	u, _ := url.Parse("https://orders-7xk2.a.run.app/v1")
	for hosts, want := range map[string]bool{"*.a.run.app": true, "orders-7xk2.a.run.app": true, "*.run.app.evil": false, "a.run.app": false} {
		if got := BackendAllowed(u, []string{hosts}); got != want {
			t.Errorf("%s: %v", hosts, got)
		}
	}
}
