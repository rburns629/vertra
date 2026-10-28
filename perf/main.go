// SPDX-License-Identifier: MIT

// perf runs one benchmark scenario against a Vertra install on the
// dedicated vertra-perf kind cluster (README.md): it submits DAGs of the
// perf sample's no-op product through the console's API, as a pipeline
// would, waits for each to finish, and writes what it measured, and
// whether every run ended as it should, to results/ as JSON and Markdown.
//
// It refuses any cluster but the one it's told, and any console not on
// this machine, and every workload is capped (workload.go).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type submitted struct {
	Index       int           `json:"index"`
	ExecutionID string        `json:"executionId"`
	SubmittedAt time.Time     `json:"submittedAt"`
	Latency     time.Duration `json:"latency"`
	Error       string        `json:"error,omitempty"`
	// When this driver first saw it finished, and how it ended.
	SeenDoneAt time.Time  `json:"seenDoneAt"`
	Final      *execution `json:"final,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "perf:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		scenario    = flag.String("scenario", "baseline", "baseline, burst, dependency, sustained or higher (README.md); or custom")
		shapeFlag   = flag.String("shape", "", "custom: single, chain, wide or fanout")
		dags        = flag.Int("dags", 0, "custom: how many DAGs")
		steps       = flag.Int("steps", 0, "custom: steps in each")
		sleepMs     = flag.Int("sleep-ms", 0, "how long each step does nothing")
		failMode    = flag.String("fail", "never", "never, always or first-attempt")
		concurrency = flag.Int("concurrency", 8, "submitters at once")
		rate        = flag.Float64("rate", 0, "submissions a second across all submitters; 0: as fast as they go")
		allowLarge  = flag.Bool("allow-large", false, "allow more than 1,000 steps in all")
		cluster     = flag.String("cluster", "vertra-perf", "the kind cluster it may use (its context is kind-<cluster>)")
		consoleURL  = flag.String("console", "http://localhost:18080", "the console's address: this machine only")
		team        = flag.String("team", "perf", "the team the steps run for")
		image       = flag.String("image", "localhost:5001/perf-catalog/perf/noop:latest", "the no-op product's image")
		timeout     = flag.Duration("timeout", 30*time.Minute, "give up waiting after this long")
		out         = flag.String("out", "results", "where results go")
	)
	flag.Parse()

	w, ok := scenarios[*scenario]
	if *scenario == "custom" {
		w, ok = workload{Shape: shape(*shapeFlag), DAGs: *dags, Steps: *steps}, true
	}
	if !ok {
		return fmt.Errorf("no scenario %q", *scenario)
	}
	w.Scenario, w.SleepMs, w.Fail, w.Concurrency, w.Rate = *scenario, *sleepMs, *failMode, *concurrency, *rate
	if err := w.check(*allowLarge); err != nil {
		return err
	}
	if err := safe(*cluster, *consoleURL); err != nil {
		return err
	}
	token := os.Getenv("VERTRA_TOKEN")
	if token == "" {
		return errors.New("VERTRA_TOKEN: a token for the console (README.md says how to get one)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	c := &console{url: strings.TrimRight(*consoleURL, "/"), token: token, http: &http.Client{Timeout: 30 * time.Second}}

	env := environment(*cluster)
	runID := time.Now().UTC().Format("20060102T150405Z")
	log.Info("starting", "run", runID, "scenario", w.Scenario, "dags", w.DAGs, "steps", w.Steps, "shape", w.Shape)

	sampler := startSampler(ctx, *cluster+"-control-plane")
	started := time.Now()
	runs := submitAll(ctx, c, w, runID, *image, *team, log)
	waitAll(ctx, c, runs, log)
	finished := time.Now()
	samples := sampler()

	r := analyze(w, runID, runs, started, finished, samples)
	r.Environment = env
	if ctx.Err() != nil {
		r.Problems = append(r.Problems, "stopped before every run finished: "+ctx.Err().Error())
	}
	return write(*out, r, runs, log)
}

// safe refuses anything but the named kind cluster's context, existing and
// running Vertra, and a console on this machine.
func safe(cluster, consoleURL string) error {
	if !strings.HasPrefix(cluster, "vertra-perf") {
		return fmt.Errorf("cluster %q: benchmarks run only on a vertra-perf* cluster (README.md)", cluster)
	}
	u, err := url.Parse(consoleURL)
	if err != nil || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1") {
		return fmt.Errorf("console %q: only a console on this machine (a port-forward to the perf cluster)", consoleURL)
	}
	context := "kind-" + cluster
	if err := exec.Command("kubectl", "--context", context, "-n", "vertra-system", "get", "deployment", "kernel-execution-kernel-scheduler").Run(); err != nil {
		return fmt.Errorf("context %s has no Vertra in vertra-system: make quickstart KIND_CLUSTER=%s (README.md)", context, cluster)
	}
	// The port-forward must reach this cluster's console, not another's.
	forward, _ := exec.Command("pgrep", "-fl", "port-forward svc/console-execution-console").Output()
	if !strings.Contains(string(forward), "--context "+context) {
		return fmt.Errorf("no port-forward to %s's console: make up KIND_CLUSTER=%s (and make down for any other)", context, cluster)
	}
	return nil
}

// submitAll submits every DAG, `concurrency` at a time, at most `rate` a second.
func submitAll(ctx context.Context, c *console, w workload, runID, image, team string, log *slog.Logger) []*submitted {
	runs := make([]*submitted, w.DAGs)
	next := make(chan int)
	var wg sync.WaitGroup
	for range w.Concurrency {
		wg.Go(func() {
			for i := range next {
				d := w.build(runID, i, image, team)
				at := time.Now()
				id, err := c.submit(ctx, d)
				s := &submitted{Index: i, ExecutionID: id, SubmittedAt: at, Latency: time.Since(at)}
				if err != nil {
					s.Error = err.Error()
					log.Warn("submit failed", "dag", i, "error", err)
				}
				runs[i] = s
			}
		})
	}
	var tick <-chan time.Time
	if w.Rate > 0 {
		ticker := time.NewTicker(time.Duration(float64(time.Second) / w.Rate))
		defer ticker.Stop()
		tick = ticker.C
	}
	for i := range w.DAGs {
		if tick != nil {
			select {
			case <-tick:
			case <-ctx.Done():
			}
		}
		if ctx.Err() != nil {
			break
		}
		next <- i
	}
	close(next)
	wg.Wait()
	return runs
}

// waitAll reads each unfinished run until it's finished, eight reads at a
// time, a sweep a second: what the driver adds to the console's load.
func waitAll(ctx context.Context, c *console, runs []*submitted, log *slog.Logger) {
	for ctx.Err() == nil {
		var pending []*submitted
		for _, s := range runs {
			if s != nil && s.Error == "" && s.Final == nil {
				pending = append(pending, s)
			}
		}
		if len(pending) == 0 {
			return
		}
		sem := make(chan struct{}, 8)
		var wg sync.WaitGroup
		for _, s := range pending {
			sem <- struct{}{}
			wg.Go(func() {
				defer func() { <-sem }()
				e, err := c.get(ctx, s.ExecutionID)
				if err != nil {
					log.Warn("read failed", "execution", s.ExecutionID, "error", err)
					return
				}
				if terminal(e.State) {
					s.SeenDoneAt, s.Final = time.Now(), e
				}
			})
		}
		wg.Wait()
		log.Info("waiting", "unfinished", len(pending))
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
		}
	}
}

// sample is the kind node container's use of the Docker VM at one moment.
type sample struct {
	At       time.Time `json:"at"`
	CPU      float64   `json:"cpuPercent"`
	MemBytes float64   `json:"memBytes"`
}

// startSampler reads the node's CPU and memory every two seconds until the
// returned function is called, which returns what it read.
func startSampler(ctx context.Context, node string) func() []sample {
	ctx, cancel := context.WithCancel(ctx)
	var mu sync.Mutex
	var samples []sample
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ctx.Err() == nil {
			outBytes, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--format", "{{json .}}", node).Output()
			if err == nil {
				var s struct{ CPUPerc, MemUsage string }
				if json.Unmarshal(outBytes, &s) == nil {
					mu.Lock()
					samples = append(samples, sample{At: time.Now(), CPU: percent(s.CPUPerc), MemBytes: bytesOf(strings.TrimSpace(strings.Split(s.MemUsage, "/")[0]))})
					mu.Unlock()
				}
			}
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
			}
		}
	}()
	return func() []sample {
		cancel()
		<-done
		mu.Lock()
		defer mu.Unlock()
		return samples
	}
}

func write(dir string, r report, runs []*submitted, log *slog.Logger) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	base := filepath.Join(dir, r.RunID+"-"+r.Workload.Scenario)
	data, err := json.MarshalIndent(struct {
		Report report       `json:"report"`
		Runs   []*submitted `json:"runs"`
	}{r, runs}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(base+".json", data, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(base+".md", []byte(markdown(r)), 0o644); err != nil {
		return err
	}
	log.Info("written", "json", base+".json", "markdown", base+".md")
	fmt.Print(markdown(r))
	if len(r.Problems) > 0 {
		return fmt.Errorf("%d correctness problem(s): see the report", len(r.Problems))
	}
	return nil
}
