// SPDX-License-Identifier: MIT

// The kind tests' fixture image: exercises the executor's own mechanics
// (the request ConfigMap, the termination-message result, cancelling), not
// any real product. What it does depends on its action and inputs:
//
//   - "crash": exits non-zero without writing result.json
//     (PRODUCT_RESULT_MISSING).
//   - "sleep": prints a line a second for inputs.seconds (default 30), then
//     succeeds: something running long enough to cancel.
//   - "secret-digest": the SHA-256 of each key of each Secret mounted under
//     /platform/secrets/<name>/, as outputs.digests["<name>/<key>"]: proof
//     it read them, never their values.
//   - inputs.shouldFail true: a failed result.json, and a non-zero exit.
//   - anything else: succeeds, echoing its action and inputs.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	requestPath = "/platform/input/request.json"
	resultPath  = "/platform/output/result.json"
)

func write(result any) {
	data, _ := json.Marshal(result)
	if err := os.WriteFile(resultPath, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

func main() {
	action := ""
	if len(os.Args) > 1 {
		action = os.Args[1]
	}
	var request struct {
		Inputs map[string]any `json:"inputs"`
	}
	data, err := os.ReadFile(requestPath)
	if err == nil {
		err = json.Unmarshal(data, &request)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	inputs := request.Inputs
	if inputs == nil {
		inputs = map[string]any{}
	}
	switch {
	case action == "crash":
		fmt.Fprintln(os.Stderr, "crashing deliberately without writing a result file")
		os.Exit(1)
	case action == "sleep":
		seconds := 30
		if s, ok := inputs["seconds"].(float64); ok {
			seconds = int(s)
		}
		for second := range seconds {
			fmt.Printf("still working: %ds\n", second)
			time.Sleep(time.Second)
		}
		write(map[string]any{"status": "succeeded", "outputs": map[string]any{}})
	case action == "secret-digest":
		digests := map[string]any{}
		// A mounted Secret's keys are links into its ..data directory.
		files, _ := filepath.Glob("/platform/secrets/*/*")
		for _, f := range files {
			if strings.HasPrefix(filepath.Base(f), "..") {
				continue
			}
			value, err := os.ReadFile(f)
			if err != nil {
				fmt.Println("unreadable:", err)
				continue
			}
			sum := sha256.Sum256(value)
			digests[filepath.Base(filepath.Dir(f))+"/"+filepath.Base(f)] = hex.EncodeToString(sum[:])
		}
		write(map[string]any{"status": "succeeded", "outputs": map[string]any{"digests": digests}})
	case inputs["shouldFail"] == true:
		write(map[string]any{"status": "failed", "error": map[string]any{
			"code": "TEST_FAILURE", "message": "deliberate test failure", "retryable": false}})
		os.Exit(1)
	default:
		inputsJSON, _ := json.Marshal(inputs)
		fmt.Printf("running action=%s\ninputs: %s\n", action, inputsJSON)
		write(map[string]any{"status": "succeeded", "outputs": map[string]any{"echoedAction": action, "receivedInputs": inputs}})
	}
}
