// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/plan"
	"github.com/rburns629/vertra/cli/internal/platform"
	"github.com/rburns629/vertra/cli/internal/tools"
)

func (a *app) applyCmd() *cobra.Command {
	var yes, planOnly bool
	cmd := &cobra.Command{
		Use:   "apply [env]",
		Short: "Show what will change, then create, install or upgrade on approval",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			return a.apply(cmd.Context(), cmd, dir, c, yes, planOnly)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "approve without asking")
	cmd.Flags().BoolVar(&planOnly, "plan-only", false, "show the approval screen and stop")
	return cmd
}

func (a *app) apply(ctx context.Context, cmd *cobra.Command, dir string, c *config.Config, yes, planOnly bool) error {
	out := cmd.OutOrStdout()
	if err := a.requireTools(ctx, out, c.Target, c.Vertra == "source"); err != nil {
		return err
	}
	var cloud *cloudPlan
	switch c.Target {
	case "gcp":
		var err error
		if cloud, err = a.planGCP(ctx, out, dir, c, false); err != nil {
			return err
		}
	case "aws":
		var err error
		if cloud, err = a.planAWS(ctx, out, dir, c, false); err != nil {
			return err
		}
	}
	state := cluster.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("the cluster isn't ready for Vertra:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	images := install.ImagesFor(c, time.Now())
	installed := map[string]string{}
	var now current
	if state.Reachable {
		for _, r := range []string{install.KernelRelease, install.ConsoleRelease} {
			installed[r] = install.Installed(ctx, a.runner, c, r)
		}
		now.volume = install.DatabaseVolume(ctx, a.runner, c)
		if deps, err := platform.Deployments(ctx, a.runner, c); err == nil {
			now.asleep = platform.Asleep(deps)
		}
	}

	p := buildPlan(ctx, c, envName(dir), state, images, installed, now, cloud)
	var screen bytes.Buffer
	p.Render(&screen)
	fmt.Fprint(out, screen.String())
	if planOnly {
		return nil
	}
	if !yes {
		ok, err := a.ask.Confirm("Apply?", false)
		if err != nil {
			return err
		}
		if !ok || !a.ask.Interactive {
			if !a.ask.Interactive {
				return fmt.Errorf("not approved: pass --yes to apply without a prompt")
			}
			return errStopped
		}
	}
	stamp := fmt.Sprintf("Approved %s\n\n", time.Now().UTC().Format(time.RFC3339))
	if err := os.WriteFile(filepath.Join(dir, "last-plan.txt"), []byte(stamp+screen.String()), 0o644); err != nil {
		return err
	}

	var made *install.Cloud
	switch c.Target {
	case "kind":
		fmt.Fprintln(out, "Preparing the local registry and the kind cluster...")
		if err := cluster.EnsureKind(ctx, a.runner, c, state); err != nil {
			return err
		}
	case "gcp":
		var err error
		if made, err = a.applyGCP(ctx, out, c, cloud, images); err != nil {
			return err
		}
	case "aws":
		var err error
		if made, err = a.applyAWS(ctx, out, c, cloud, images); err != nil {
			return err
		}
	}
	if err := cluster.EnsureNamespace(ctx, a.runner, c); err != nil {
		return err
	}
	if made != nil && made.BackupBucket != "" {
		if err := install.EnsureBackupServiceAccount(ctx, a.runner, c, made); err != nil {
			return err
		}
	}
	if made != nil && made.ConsoleHost != "" && made.Provider != "aws" {
		if err := install.EnsureCertificate(ctx, a.runner, c, made.ConsoleHost); err != nil {
			return err
		}
	}
	if images.Build {
		fmt.Fprintln(out, "Building the platform images from", c.Source, "...")
		if err := install.BuildImages(ctx, a.runner, c, images); err != nil {
			return err
		}
	}
	kernelChart, consoleChart := install.Charts(c, dir)
	for _, chart := range []install.Chart{kernelChart, consoleChart} {
		if err := install.Pull(ctx, a.runner, chart); err != nil {
			return err
		}
	}
	if c.Target == "kind" && c.Size == "auto" {
		fmt.Fprintln(out, "Installing metrics-server (the auto size's autoscalers need it)...")
		if err := install.MetricsServer(ctx, a.runner, c); err != nil {
			return err
		}
	}
	kernelValues, err := install.WriteValues(dir, "kernel", install.KernelValues(c, images, now.volume, made))
	if err != nil {
		return err
	}
	consoleValues, err := install.WriteValues(dir, "console", install.ConsoleValues(c, envName(dir), images, made))
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Installing execution-kernel...")
	if err := install.Upgrade(ctx, a.runner, c, dir, install.KernelRelease, kernelChart, kernelValues); err != nil {
		return err
	}
	fmt.Fprintln(out, "Installing execution-console...")
	if err := install.Upgrade(ctx, a.runner, c, dir, install.ConsoleRelease, consoleChart, consoleValues); err != nil {
		return err
	}

	if made != nil && made.Provider == "aws" && made.ConsoleHost != "" {
		if err := a.awsConsoleAddress(ctx, out, c, made); err != nil {
			return err
		}
	}

	// Awake now (an apply wakes it): the sleeper looks again.
	if err := platform.SuspendSleeper(ctx, a.runner, c, false); err != nil {
		return err
	}

	fmt.Fprintln(out, "\nVertra is running.")
	fmt.Fprintln(out, "  Console:", platform.ConsoleAccess(c, envName(dir)))
	if made != nil && made.ConsoleHost != "" {
		if made.Provider == "aws" {
			fmt.Fprintf(out, "  Public:  https://%s\n", made.ConsoleHost)
		} else {
			fmt.Fprintf(out, "  Public:  https://%s (certificate %s; Google issues it within the hour)\n",
				made.ConsoleHost, orDefault(install.CertificateStatus(ctx, a.runner, c), "requested"))
		}
	}
	if made != nil && made.Provider == "aws" && c.ExternalCatalog.Registry != "" && c.ExternalCatalog.GCPWorkloadIdentityProvider == "" {
		if steps := install.FederationSteps(c, made.ClusterIssuer); steps != nil {
			fmt.Fprintln(out, "\nThis install reads the catalog in", c.ExternalCatalog.Registry, "but can't sign in to it yet.")
			fmt.Fprintln(out, "Its owner lets it, in that Google Cloud project (no key is stored anywhere):")
			for _, step := range steps {
				fmt.Fprintln(out, "  "+step)
			}
		}
	}
	if installed[install.ConsoleRelease] == "" {
		if pw := install.Password(ctx, a.runner, c); pw != "" {
			fmt.Fprintf(out, "  Sign in as %s with %s\n", c.Admin.Email, pw)
			fmt.Fprintln(out, "  That password is shown only this once: change it after signing in.")
		}
	}
	return nil
}

// current is what apply finds installed, beyond the releases.
type current struct {
	volume string // the database volume's size, if it exists
	asleep bool
}

// buildPlan assembles the approval screen.
func buildPlan(ctx context.Context, c *config.Config, env string, s cluster.State, img install.Images, installed map[string]string, now current, cloud *cloudPlan) *plan.Plan {
	p := &plan.Plan{}
	what := "release " + c.Vertra
	if c.Vertra == "source" {
		what = "source (" + c.Source + ")"
	}
	where := "kind (local), cluster " + c.Cluster.Name
	switch c.Target {
	case "existing":
		where = "existing cluster, context " + c.Cluster.Context
		if s.ServerVersion != "" {
			where += " (Kubernetes " + s.ServerVersion + ")"
		}
	case "gcp":
		mode := map[string]string{"auto": "GKE Autopilot", "standard": "GKE Standard"}[c.Cluster.Mode]
		where = fmt.Sprintf("gcp / %s / %s, cluster %s (%s)", c.GCP.Project, c.GCP.Region, c.Cluster.Name, mode)
	case "aws":
		mode := map[string]string{"auto": "EKS Auto Mode", "standard": "EKS with node groups"}[c.Cluster.Mode]
		where = fmt.Sprintf("aws / %s, cluster %s (%s)", c.AWS.Region, c.Cluster.Name, mode)
	}
	p.Title = fmt.Sprintf("Vertra %s → %s [%s]", what, where, env)

	floor := plan.Floors[c.Size]
	scale := fmt.Sprintf("yes: sleeps after %s with nothing running and nobody using the console", c.ScaleDown.IdleAfter)
	if c.ScaleDown.Schedule != "" {
		scale += fmt.Sprintf(", and at %q once nothing runs", c.ScaleDown.Schedule)
	}
	scale += "; `vertra wake` brings it back"
	if !c.ScaleDown.Enabled {
		scale = fmt.Sprintf("no: always on, at least %d copies of the console and API", install.AlwaysOn(c))
		if c.StepHeadroom > 0 {
			slots := "steps"
			if c.StepHeadroom == 1 {
				slots = "step"
			}
			scale += fmt.Sprintf("; room kept for %d %s to start at once (reserved around the clock)", c.StepHeadroom, slots)
		}
	}
	admin := c.Admin.Email + " (password generated, shown once after the first install)"
	if installed[install.ConsoleRelease] != "" {
		admin = c.Admin.Email + " (set up at the first install)"
	}
	volume := floor.Volume
	if now.volume != "" {
		volume = now.volume
	}
	taskImages := "from " + c.TaskImages.Registry
	database := fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume; no backups yet", volume)
	if c.Target == "gcp" {
		taskImages = "from " + gcp.TaskRegistry(c)
		if c.TaskImages.Create {
			taskImages += " (created)"
		}
		database = fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume", volume)
		if c.Database.Backups.Enabled {
			database += fmt.Sprintf("; backed up daily to a bucket, kept %d days", c.Database.Backups.RetentionDays)
		}
	}
	if c.Target == "aws" {
		taskImages = fmt.Sprintf("from ECR under %s/ (each product's repository made on its first push)", c.TaskImages.Name)
		database = fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume", volume)
		if c.Database.Backups.Enabled {
			database += fmt.Sprintf("; backed up daily to an S3 bucket, kept %d days", c.Database.Backups.RetentionDays)
		}
	}
	p.Settings = []plan.Line{
		{Label: "Tools", Text: tools.Summary(tools.CheckAll(ctx, tools.For(c.Target, c.Vertra == "source")))},
		{Label: "Size", Text: fmt.Sprintf("%s: %s; platform %s, %s awake", c.Size, floor.Copies, floor.CPU, floor.Memory)},
		{Label: "Steps", Text: floor.Steps},
		{Label: "Scale down", Text: scale},
		{Label: "Task images", Text: taskImages},
		{Label: "Database", Text: database},
		{Label: "Logs", Text: logsLine(c)},
		{Label: "Admin", Text: admin},
	}
	if cloud != nil {
		p.Access = cloud.access
		p.Changes = append(p.Changes, cloud.changeLines(cloud.where)...)
	}

	var create []string
	if c.Target == "kind" {
		switch {
		case !s.RegistryExists:
			create = append(create, fmt.Sprintf("local registry %s on localhost:%d", c.Kind.RegistryName, c.Kind.RegistryPort))
		case !s.RegistryRunning:
			create = append(create, "start the local registry "+c.Kind.RegistryName)
		}
		switch {
		case !s.ClusterExists:
			create = append(create, "kind cluster "+c.Cluster.Name)
		case !s.ClusterRunning:
			create = append(create, "start the kind cluster "+c.Cluster.Name)
		}
	}
	if !s.NamespaceExists {
		ns := "namespace " + c.Namespace
		if cloud != nil {
			ns = "in the cluster: namespace " + c.Namespace
		}
		create = append(create, ns)
	}
	if len(create) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will create", Text: strings.Join(create, "; ")})
	}
	if img.Build {
		dest := "loaded onto the kind node"
		if img.Push {
			dest = "pushed to " + c.PlatformImages.Registry
			if c.Target == "gcp" {
				dest = "pushed to " + gcp.PlatformRegistry(c)
			}
			if c.Target == "aws" {
				dest = "for amd64, pushed to " + c.PlatformImages.Registry
			}
		}
		p.Changes = append(p.Changes, plan.Line{Label: "Will build", Text: fmt.Sprintf("%s from source, tagged %s, %s", img.Names(), img.Tag, dest)})
	}
	var installs, upgrades []string
	for _, r := range []struct{ release, chart string }{
		{install.KernelRelease, "execution-kernel"}, {install.ConsoleRelease, "execution-console"},
	} {
		target := r.chart + " " + c.Vertra
		if c.Vertra == "source" {
			target = r.chart + " from source"
		}
		if prev := installed[r.release]; prev != "" {
			upgrades = append(upgrades, fmt.Sprintf("%s (now %s) to %s", r.release, prev, target))
		} else {
			installs = append(installs, target)
		}
	}
	if len(installs) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will install", Text: strings.Join(installs, " and ") + " into " + c.Namespace})
	}
	if len(upgrades) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will upgrade", Text: strings.Join(upgrades, "; ")})
	}

	switch c.Target {
	case "kind":
		p.Cost = []plan.Line{{Label: "Estimated cost", Text: "$0: it runs on this machine (give Docker about 4 GB of memory)"}}
	case "gcp", "aws":
		p.Cost = cloud.cost
	case "existing":
		p.Cost = []plan.Line{{Label: "Estimated cost", Text: fmt.Sprintf(
			"part of your cluster's own bill: Vertra requests %s and %s awake, plus up to its step cap while steps run", floor.CPU, floor.Memory)}}
	}

	if c.Target == "kind" && c.Size == "auto" {
		p.Changes = append(p.Changes, plan.Line{Label: "Will install", Text: "metrics-server " + install.MetricsServerChart + " into kube-system, for the auto size's autoscalers"})
	}

	if now.volume != "" && now.volume != floor.Volume {
		p.Notes = append(p.Notes, fmt.Sprintf("The database volume stays at %s (the %s size's is %s): volumes can't shrink, and growing one is up to its storage class.", now.volume, c.Size, floor.Volume))
	}
	if now.asleep {
		p.Notes = append(p.Notes, "It's asleep: applying wakes it.")
	}
	if c.ScaleDown.Enabled {
		p.Notes = append(p.Notes, "While asleep, the console and API don't answer: catalog CI and automation fail until `vertra wake`.")
	}
	return p
}

// logsLine says what log search keeps, and where, for the approval screen.
func logsLine(c *config.Config) string {
	if !c.Logs.Enabled {
		return "not kept beyond each run's own (logs.enabled for Observe's search)"
	}
	switch c.Target {
	case "gcp", "aws":
		return fmt.Sprintf("searchable %d days, then archived in a bucket; deleted after %d days", c.Logs.SearchDays, c.Logs.KeepDays)
	}
	return fmt.Sprintf("searchable on a volume, deleted after %d days (no archive without a bucket)", c.Logs.KeepDays)
}
