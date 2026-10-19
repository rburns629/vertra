// SPDX-License-Identifier: MIT

// Package gcp is what a gcp install needs from gcloud, run as you: the
// project's checks, the cluster's credentials for kubectl, and a short-lived
// sign-in for pushing images to Artifact Registry.
package gcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/rburns629/acyclix/cli/internal/cluster"
	"github.com/rburns629/acyclix/cli/internal/config"
	"github.com/rburns629/acyclix/cli/internal/run"
)

// State is what gcloud says about the project and the cluster.
type State struct {
	// Account is who gcloud is signed in as.
	Account string
	// ClusterStatus is the cluster's status (RUNNING, PROVISIONING, ...), or
	// "" if it doesn't exist yet.
	ClusterStatus string
	Problems      []string
}

// Inspect checks the project can take an install: it exists, you can see
// it, and billing is on.
func Inspect(ctx context.Context, r *run.Runner, c *config.Config) State {
	var s State
	s.Account, _ = r.Output(ctx, "gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
	project := c.GCP.Project
	if _, err := r.Output(ctx, "gcloud", "projects", "describe", project, "--format=value(projectId)"); err != nil {
		s.Problems = append(s.Problems, fmt.Sprintf("can't see project %s as %s: check the id, or ask for access (`gcloud auth login` to switch accounts)", project, orUnknown(s.Account)))
		return s
	}
	billing, err := r.Output(ctx, "gcloud", "billing", "projects", "describe", project, "--format=value(billingEnabled)")
	switch {
	case err != nil:
		s.Problems = append(s.Problems, fmt.Sprintf("can't read project %s's billing (you need billing.resourceAssociations.list, e.g. Project Billing Manager or Viewer): %v", project, err))
	case !strings.EqualFold(billing, "true"):
		s.Problems = append(s.Problems, fmt.Sprintf("project %s has no billing account: link one (`gcloud billing projects link %s --billing-account=...`)", project, project))
	}
	s.ClusterStatus, _ = r.Output(ctx, "gcloud", "container", "clusters", "list", "--project", project,
		"--filter=name="+c.Cluster.Name+" AND location="+cluster.GKELocation(c), "--format=value(status)")
	return s
}

// BillingAccount is the project's billing account id, for account prices.
func BillingAccount(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "gcloud", "billing", "projects", "describe", c.GCP.Project, "--format=value(billingAccountName)")
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(out, "billingAccounts/")
}

// Credentials adds the cluster to your kubeconfig (as cluster.Context), and
// puts your current context back: gcloud switches it.
func Credentials(ctx context.Context, r *run.Runner, c *config.Config) error {
	previous, _ := r.Output(ctx, "kubectl", "config", "current-context")
	if err := r.Run(ctx, "gcloud", "container", "clusters", "get-credentials", c.Cluster.Name,
		"--location", cluster.GKELocation(c), "--project", c.GCP.Project); err != nil {
		return err
	}
	if previous = strings.TrimSpace(previous); previous != "" && previous != cluster.Context(c) {
		return r.Run(ctx, "kubectl", "config", "use-context", previous)
	}
	return nil
}

// AccessToken is a short-lived token for your gcloud sign-in (prices,
// Docker). Never written anywhere.
func AccessToken(ctx context.Context, r *run.Runner) (string, error) {
	return r.Output(ctx, "gcloud", "auth", "print-access-token")
}

// DockerLogin signs Docker in to an Artifact Registry host with a
// short-lived token (an hour), passed on stdin.
func DockerLogin(ctx context.Context, r *run.Runner, host string) error {
	token, err := AccessToken(ctx, r)
	if err != nil {
		return err
	}
	return r.RunInput(ctx, token, "docker", "login", "--username", "oauth2accesstoken", "--password-stdin", "https://"+host)
}

func orUnknown(s string) string {
	if s == "" {
		return "(nobody: `gcloud auth login`)"
	}
	return s
}

// TaskRegistry is the Artifact Registry path steps' images come from.
func TaskRegistry(c *config.Config) string {
	if !c.TaskImages.Create && c.TaskImages.Registry != "" {
		return c.TaskImages.Registry
	}
	return fmt.Sprintf("%s-docker.pkg.dev/%s/%s", c.GCP.Region, c.GCP.Project, c.TaskImages.Name)
}

// PlatformRepository is the repository the module creates for platform
// images built from source ("" when installing a release).
func PlatformRepository(c *config.Config) string {
	if c.Acyclix != "source" {
		return ""
	}
	return c.Cluster.Name + "-platform"
}

// PlatformRegistry is that repository's path.
func PlatformRegistry(c *config.Config) string {
	if c.Acyclix != "source" {
		return ""
	}
	return fmt.Sprintf("%s-docker.pkg.dev/%s/%s", c.GCP.Region, c.GCP.Project, PlatformRepository(c))
}

// Vars are the module's inputs, from the config.
func Vars(c *config.Config, deleteData bool) map[string]any {
	return map[string]any{
		"project":               c.GCP.Project,
		"region":                c.GCP.Region,
		"name":                  c.Cluster.Name,
		"mode":                  c.Cluster.Mode,
		"size":                  c.Size,
		"namespace":             c.Namespace,
		"step_headroom":         c.StepHeadroom,
		"task_registry":         c.TaskImages.Name,
		"create_task_registry":  c.TaskImages.Create,
		"platform_registry":     PlatformRepository(c),
		"backups":               c.Database.Backups.Enabled,
		"backup_retention_days": c.Database.Backups.RetentionDays,
		"delete_data":           deleteData,
		"console_public":        c.Console.Public,
		"catalog_repository":    c.Catalog.Repo(),
	}
}
