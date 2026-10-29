// SPDX-License-Identifier: MIT

package catalogtool

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// maxResultBytes is all of result.json the platform reads: Kubernetes keeps
// at most this much of a container's termination message.
const maxResultBytes = 4096

// resultProblem reads a result.json exactly as the kernel does
// (kernel/internal/domain/result.go, kept in step: the two share no code):
// status "succeeded" (outputs optional) or "failed" with an error of a
// non-empty code and message, nothing else, and nothing after it. "" when
// it's one the platform takes.
func resultProblem(data []byte) string {
	if len(data) > maxResultBytes {
		return fmt.Sprintf("result.json is %d bytes; the platform reads at most %d, so this would fail as PRODUCT_RESULT_INVALID: output references, not data", len(data), maxResultBytes)
	}
	var raw struct {
		Status  *string         `json:"status"`
		Outputs map[string]any  `json:"outputs"`
		Error   json.RawMessage `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	invalid := func(why string) string {
		return "result.json would fail on the platform as PRODUCT_RESULT_INVALID: " + why
	}
	if err := decoder.Decode(&raw); err != nil {
		return invalid(err.Error())
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return invalid("content after the JSON object")
	}
	if raw.Status == nil || (*raw.Status != "succeeded" && *raw.Status != "failed") {
		return invalid(`status must be "succeeded" or "failed"`)
	}
	hasError := len(raw.Error) > 0 && string(raw.Error) != "null"
	if hasError {
		var e struct {
			Code      *string `json:"code"`
			Message   *string `json:"message"`
			Retryable *bool   `json:"retryable"`
		}
		errDecoder := json.NewDecoder(bytes.NewReader(raw.Error))
		errDecoder.DisallowUnknownFields()
		if err := errDecoder.Decode(&e); err != nil {
			return invalid("error: " + err.Error())
		}
		if e.Code == nil || *e.Code == "" || e.Message == nil || *e.Message == "" {
			return invalid("error: code and message are required, and not empty")
		}
	}
	if *raw.Status == "failed" && !hasError {
		return invalid("a failed result must include an error")
	}
	if *raw.Status == "succeeded" && hasError {
		return invalid("a succeeded result must not include an error")
	}
	return ""
}
