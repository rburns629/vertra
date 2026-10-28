// noop's "run" action: does nothing for sleepMs, then succeeds or fails as
// asked, saying when its container started and finished. For benchmarking
// the platform (perf/README.md in its repository): nothing is called and
// nothing is made.
//
// The binary is the image's entrypoint: the platform passes the action as
// its first argument. It reads /platform/input/request.json and writes
// /platform/output/result.json.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	inputPath  = "/platform/input/request.json"
	outputPath = "/platform/output/result.json"
)

type failure struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type result struct {
	Status  string         `json:"status"`
	Outputs map[string]any `json:"outputs,omitempty"`
	Error   *failure       `json:"error,omitempty"`
}

func writeResult(r result) {
	data, _ := json.Marshal(r)
	if err := os.WriteFile(outputPath, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "can't write result.json:", err)
	}
}

func fail(code, message string, retryable bool) int {
	writeResult(result{Status: "failed", Error: &failure{Code: code, Message: message, Retryable: retryable}})
	return 1
}

// whole is a JSON number as a whole number in [0, max], or ok=false.
func whole(v any, max int64) (int64, bool) {
	if v == nil {
		return 0, true
	}
	n, isNumber := v.(float64)
	if !isNumber || n != float64(int64(n)) || n < 0 || int64(n) > max {
		return 0, false
	}
	return int64(n), true
}

func run(args []string, started time.Time) int {
	if len(args) < 1 || args[0] != "run" {
		return fail("UNSUPPORTED_ACTION", fmt.Sprintf("no action %v: this product has run", args), false)
	}
	data, err := os.ReadFile(inputPath)
	if err != nil {
		return fail("MISSING_INPUT", "can't read request.json: "+err.Error(), false)
	}
	var request struct {
		Attempt int64          `json:"attempt"`
		Inputs  map[string]any `json:"inputs"`
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return fail("INVALID_INPUT", "request.json isn't valid JSON: "+err.Error(), false)
	}
	sleepMs, ok := whole(request.Inputs["sleepMs"], 600000)
	if !ok {
		return fail("INVALID_INPUT", "sleepMs is a whole number of milliseconds, 0 to 600000.", false)
	}
	outputBytes, ok := whole(request.Inputs["outputBytes"], 2048)
	if !ok {
		return fail("INVALID_INPUT", "outputBytes is a whole number, 0 to 2048.", false)
	}
	mode, _ := request.Inputs["fail"].(string)
	label, _ := request.Inputs["label"].(string)

	time.Sleep(time.Duration(sleepMs) * time.Millisecond)

	switch mode {
	case "", "never":
	case "always":
		return fail("PERF_FAILED", "Asked to fail.", false)
	case "first-attempt":
		if request.Attempt <= 1 {
			return fail("PERF_FAILED", "Asked to fail its first attempt.", true)
		}
	default:
		return fail("INVALID_INPUT", "fail is never, always or first-attempt.", false)
	}
	outputs := map[string]any{
		"attempt":      request.Attempt,
		"startedAtMs":  started.UnixMilli(),
		"finishedAtMs": time.Now().UnixMilli(),
	}
	if label != "" {
		outputs["label"] = label
	}
	if outputBytes > 0 {
		outputs["padding"] = strings.Repeat("x", int(outputBytes))
	}
	writeResult(result{Status: "succeeded", Outputs: outputs})
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], time.Now()))
}
