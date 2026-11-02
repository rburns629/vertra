// SPDX-License-Identifier: MIT

package gateway

import (
	"bytes"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/pb33f/libopenapi"
	validator "github.com/pb33f/libopenapi-validator"
)

// An unfit request is told each field and the rule it broke, and never
// what it sent.
func TestDescribeNamesTheFieldAndTheRuleNeverTheValue(t *testing.T) {
	doc, err := libopenapi.NewDocument([]byte(`{"openapi": "3.1.0", "info": {"title": "t", "version": "1"}, "paths": {
  "/orders/{orderId}": {"get": {"parameters": [
    {"name": "orderId", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^ord_[a-z0-9]{8}$"}},
    {"name": "limit", "in": "query", "schema": {"type": "integer", "maximum": 50}}], "responses": {"200": {"description": "ok"}}}},
  "/orders": {"post": {"requestBody": {"required": true, "content": {"application/json": {"schema": {
    "type": "object", "required": ["amount", "sku"], "additionalProperties": false, "properties": {
      "amount": {"type": "integer", "minimum": 1}, "sku": {"type": "string", "maxLength": 4},
      "lines": {"type": "array", "items": {"type": "object", "properties": {"qty": {"type": "integer", "minimum": 1}}}}}}}}},
    "responses": {"200": {"description": "ok"}}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	v, errs := validator.NewValidator(doc)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	for _, tc := range []struct {
		method, url, body string
		want              []string
	}{
		{"GET", "/orders/s3cret?limit=901", "", []string{"orderId: must match ^ord_[a-z0-9]{8}$", "limit: maximum 50"}},
		{"POST", "/orders", `{"amount": -901, "sku": "s3cret", "extra": "s3cret", "lines": [{"qty": -901}]}`,
			[]string{"amount: minimum 1", "sku: maxLength 4", "lines[0].qty: minimum 1", "extra: not in its schema"}},
		{"POST", "/orders", `{"amount": "s3cret"}`, []string{"sku: required", "amount: must be integer"}},
	} {
		r, _ := http.NewRequest(tc.method, "http://backend"+tc.url, bytes.NewReader([]byte(tc.body)))
		r.Header.Set("Content-Type", "application/json")
		valid, problems := v.ValidateHttpRequest(r)
		if valid {
			t.Fatalf("%s %s: valid", tc.method, tc.url)
		}
		got := describe(problems)
		for _, want := range tc.want {
			if !slices.Contains(got, want) {
				t.Errorf("%s %s: no %q in %q", tc.method, tc.url, want, got)
			}
		}
		if all := strings.Join(got, "\n"); strings.Contains(all, "s3cret") || strings.Contains(all, "901") {
			t.Errorf("%s %s: the values sent are in %q", tc.method, tc.url, got)
		}
	}
}
