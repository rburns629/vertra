// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/rburns629/acyclix/cli/internal/access"
	"github.com/rburns629/acyclix/cli/internal/cluster"
	"github.com/rburns629/acyclix/cli/internal/config"
	"github.com/rburns629/acyclix/cli/internal/gcp"
	"github.com/rburns629/acyclix/cli/internal/install"
	"github.com/rburns629/acyclix/cli/internal/modules"
	"github.com/rburns629/acyclix/cli/internal/plan"
	"github.com/rburns629/acyclix/cli/internal/pricing"
	"github.com/rburns629/acyclix/cli/internal/tofu"
)

// cloudPlan is a cloud target's side of the approval screen: what OpenTofu
// will change, and what it costs.
type cloudPlan struct {
	account string
	// access is the approval screen's Access block (who, where, what it allows).
	access []plan.Line
	// where the cloud changes happen, e.g. "project acyclix-dev".
	where   string
	tf      tofu.Dir
	changes []tofu.Change
	cost    []plan.Line
}

// planGCP checks the project, gets the cluster's credentials if it exists
// (so what's installed can be read), and plans the module.
func (a *app) planGCP(ctx context.Context, out io.Writer, dir string, c *config.Config, destroy bool) (*cloudPlan, error) {
	fmt.Fprintf(out, "Checking project %s...\n", c.GCP.Project)
	state := gcp.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return nil, fmt.Errorf("the project isn't ready:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	check := access.CheckGCP(ctx, a.runner.Exec, access.GoogleTokenEmail, c.GCP.Project, c.GCP.Region)
	if err := sameIdentity(c.Access.Cloud, check.Identity); err != nil {
		return nil, err
	}
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	if state.ClusterStatus == "RUNNING" {
		if err := gcp.Credentials(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	p := &cloudPlan{account: state.Account, access: check.Lines, where: "project " + c.GCP.Project, tf: tofu.In(a.runner, dir)}
	if err := modules.Write("gcp", p.tf.Path); err != nil {
		return nil, err
	}
	if err := p.tf.WriteVars(gcp.Vars(c, false)); err != nil {
		return nil, err
	}
	fmt.Fprintln(out, "Planning the cloud side (OpenTofu)...")
	if err := p.tf.Init(ctx); err != nil {
		return nil, err
	}
	changes, err := p.tf.Plan(ctx, destroy)
	if err != nil {
		return nil, err
	}
	p.changes = changes
	if !destroy {
		p.cost = a.gcpCost(ctx, c)
	}
	return p, nil
}

// gcpCost prices the install from Google's catalog; when that fails the
// screen says so and shows no figure.
func (a *app) gcpCost(ctx context.Context, c *config.Config) []plan.Line {
	unavailable := func(err error) []plan.Line {
		return []plan.Line{{Label: "Estimated cost", Text: "unavailable (" + err.Error() + "): the resources above are what it would be for"}}
	}
	token, err := gcp.AccessToken(ctx, a.runner)
	if err != nil {
		return unavailable(err)
	}
	prices, err := pricing.FetchGCP(ctx, token, c.GCP.Region)
	if err != nil {
		return unavailable(err)
	}
	fetched := "fetched now"
	if time.Since(prices.Fetched) > time.Minute {
		fetched = "fetched " + prices.Fetched.Local().Format("Jan 2 15:04")
	}
	return pricing.GCP(prices, c, fetched)
}

// changeLines are the approval screen's lines for what OpenTofu changes,
// in where (e.g. "project acyclix-dev").
func (p *cloudPlan) changeLines(where string) []plan.Line {
	summary := tofu.Summary(p.changes)
	var lines []plan.Line
	for _, a := range []struct{ action, label string }{
		{"create", "Will create"}, {"update", "Will change"}, {"replace", "Will replace"}, {"delete", "Will delete"},
	} {
		if s := summary[a.action]; s != "" {
			lines = append(lines, plan.Line{Label: a.label, Text: "in " + where + ": " + s})
		}
	}
	return lines
}

// sameIdentity stops a run signed in as someone other than who set the
// environment up (another account, profile or project's owner).
func sameIdentity(recorded, now string) error {
	if recorded == "" || now == "" || recorded == now {
		return nil
	}
	return fmt.Errorf("this environment was set up as %s, but you're signed in as %s: sign in as the first again, or, if the change is meant, `acyclixctl config set access.cloud %s`",
		strings.SplitN(recorded, ":", 2)[1], strings.SplitN(now, ":", 2)[1], now)
}

// optionalOutputs are the modules' outputs that are null when not used
// (no backups, no catalog, no public console), which `tofu output` omits.
var optionalOutputs = map[string]bool{"backup": true, "catalog": true, "console_address": true}

// cloudFromGCP reads the module's outputs.
func cloudFromGCP(outputs map[string]json.RawMessage) (*install.Cloud, error) {
	var v struct {
		Cluster struct {
			Name, Location, Issuer string
		}
		WorkloadPool   string
		TaskRegistry   string
		ConsoleAccount string
		Backup         *struct {
			Bucket         string `json:"bucket"`
			ServiceAccount string `json:"service_account"`
		}
		StepPlacement  map[string]any
		ConsoleAddress *struct {
			Name string `json:"name"`
			IP   string `json:"ip"`
		}
		Catalog *struct {
			Provider       string `json:"workload_identity_provider"`
			ServiceAccount string `json:"service_account"`
		}
	}
	for name, into := range map[string]any{
		"cluster": &v.Cluster, "workload_identity_pool": &v.WorkloadPool, "task_registry": &v.TaskRegistry,
		"console_service_account": &v.ConsoleAccount, "backup": &v.Backup, "step_placement": &v.StepPlacement,
		"console_address": &v.ConsoleAddress, "catalog": &v.Catalog,
	} {
		raw, ok := outputs[name]
		if !ok {
			// `tofu output` leaves out outputs that are null.
			if optionalOutputs[name] {
				continue
			}
			return nil, fmt.Errorf("the gcp module has no %q output", name)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			return nil, fmt.Errorf("the gcp module's %q output: %w", name, err)
		}
	}
	cloud := &install.Cloud{
		Provider:              "gcp",
		TaskRegistry:          v.TaskRegistry,
		ConsoleServiceAccount: v.ConsoleAccount,
		StepPlacement:         v.StepPlacement,
		ClusterName:           v.Cluster.Name,
		ClusterLocation:       v.Cluster.Location,
		ClusterIssuer:         v.Cluster.Issuer,
		WorkloadPool:          v.WorkloadPool,
	}
	if v.Backup != nil {
		cloud.BackupBucket, cloud.BackupServiceAccount = v.Backup.Bucket, v.Backup.ServiceAccount
	}
	if v.ConsoleAddress != nil {
		cloud.ConsoleAddressName, cloud.ConsoleIP = v.ConsoleAddress.Name, v.ConsoleAddress.IP
	}
	if v.Catalog != nil {
		cloud.CatalogProvider, cloud.CatalogServiceAccount = v.Catalog.Provider, v.Catalog.ServiceAccount
	}
	return cloud, nil
}

// applyGCP carries out the approved cloud plan, then readies the cluster for
// the charts: credentials, the namespace, the backups' ServiceAccount, and
// a Docker sign-in to push images built from source.
func (a *app) applyGCP(ctx context.Context, out io.Writer, c *config.Config, p *cloudPlan, img install.Images) (*install.Cloud, error) {
	fmt.Fprintln(out, "Creating the cloud side (OpenTofu; a new cluster takes about ten minutes)...")
	if err := p.tf.Apply(ctx); err != nil {
		return nil, err
	}
	outputs, err := p.tf.Outputs(ctx)
	if err != nil {
		return nil, err
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.ConsoleIP != "" {
		cloud.ConsoleHost = install.ConsoleHostname(c, cloud.ConsoleIP)
	}
	if err := gcp.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if img.Push {
		if err := gcp.DockerLogin(ctx, a.runner, strings.SplitN(gcp.PlatformRegistry(c), "/", 2)[0]); err != nil {
			return nil, err
		}
	}
	return cloud, nil
}

// destroyGCP removes a gcp install, keeping what the user chose to keep.
func (a *app) destroyGCP(ctx context.Context, out io.Writer, dir string, c *config.Config, deleteData, deleteRegistry bool) error {
	state := gcp.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("the project isn't reachable:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	kctx := cluster.Context(c)
	if state.ClusterStatus == "RUNNING" {
		if err := gcp.Credentials(ctx, a.runner, c); err != nil {
			return err
		}
		for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
			if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
				return err
			}
		}
		// GKE made the console's load balancer (and its certificate) outside
		// OpenTofu: let its controller remove them while it's still there,
		// or they hold the address and the network.
		if c.Console.Public {
			_ = a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "managedcertificate", "--all", "--ignore-not-found", "--wait=true")
			fmt.Fprintln(out, "Waiting for the console's load balancer to go...")
			if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
				rules, err := a.runner.Output(ctx, "gcloud", "compute", "forwarding-rules", "list", "--global",
					"--project", c.GCP.Project, "--filter=name~^k8s2-.*"+c.Namespace, "--format=value(name)")
				return err == nil && strings.TrimSpace(rules) == "", nil
			}); err != nil {
				return fmt.Errorf("the console's load balancer is still there: %w", err)
			}
		}
		// A cluster's deletion leaves its volumes' disks behind: delete the
		// claims while it's there, so the disks go with them.
		if deleteData {
			fmt.Fprintln(out, "Deleting the database volume...")
			if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "pvc", "--all", "--wait=true", "--timeout=5m"); err != nil {
				return err
			}
			if err := waitNoVolumes(ctx, a, kctx, c.Namespace); err != nil {
				return err
			}
		} else if disks, _ := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.csi.volumeHandle}{\"\\n\"}{end}"); disks != "" {
			fmt.Fprintln(out, "Keeping the database's disk:", strings.ReplaceAll(disks, "\n", ", "))
		}
	}

	tf := tofu.In(a.runner, dir)
	if err := modules.Write("gcp", tf.Path); err != nil {
		return err
	}
	if err := tf.WriteVars(gcp.Vars(c, deleteData)); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	var keep []string
	const bucket = "google_storage_bucket.backups[0]"
	if c.Database.Backups.Enabled && !deleteData {
		keep = append(keep, bucket)
	}
	if c.TaskImages.Create && !deleteRegistry {
		keep = append(keep, "google_artifact_registry_repository.tasks[0]")
	}
	if tf.HasState(ctx) {
		if c.Database.Backups.Enabled && deleteData {
			// A bucket with backups in it is deleted only once the state
			// says it may be (delete_data: force_destroy).
			if err := tf.ApplyOnly(ctx, bucket); err != nil {
				return err
			}
		}
		if err := tf.Forget(ctx, keep...); err != nil {
			return err
		}
		fmt.Fprintln(out, "Deleting the cloud side (OpenTofu; a cluster takes several minutes)...")
		if _, err := tf.Plan(ctx, true); err != nil {
			return err
		}
		if err := tf.Apply(ctx); err != nil {
			return err
		}
	}
	for _, kind := range []string{"context", "cluster", "user"} {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-"+kind, kctx)
	}
	return nil
}

// waitNoVolumes waits until the namespace's volumes (and their disks) are gone.
func waitNoVolumes(ctx context.Context, a *app, kctx, namespace string) error {
	for i := 0; i < 60; i++ {
		out, err := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}")
		if err != nil {
			return err
		}
		if !strings.Contains(out+"\n", namespace+"\n") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("the database volume is still being deleted after 5 minutes; check `kubectl --context %s get pv`", kctx)
}
