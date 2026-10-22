// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/rburns629/vertra/cli/internal/access"
	"github.com/rburns629/vertra/cli/internal/awscloud"
	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/modules"
	"github.com/rburns629/vertra/cli/internal/plan"
	"github.com/rburns629/vertra/cli/internal/pricing"
	"github.com/rburns629/vertra/cli/internal/tofu"
)

// planAWS checks the sign-in, gets the cluster's credentials if it exists,
// and plans the module.
func (a *app) planAWS(ctx context.Context, out io.Writer, dir string, c *config.Config, destroy bool) (*cloudPlan, error) {
	fmt.Fprintf(out, "Checking your AWS sign-in (%s)...\n", orDefault(c.AWS.Profile, "default profile"))
	state := awscloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return nil, fmt.Errorf("AWS isn't ready:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	check := access.CheckAWS(ctx, a.runner.Exec, c.AWS.Profile, c.AWS.Region)
	if err := sameIdentity(c.Access.Cloud, check.Identity); err != nil {
		return nil, err
	}
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	if c.Vertra == "source" {
		// Where images built from source go: known once the account is.
		c.PlatformImages.Registry = awscloud.Registry(state.Identity.Account, c) + "/" + awscloud.PlatformPrefix(c)
	}
	if state.ClusterStatus == "ACTIVE" {
		if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	p := &cloudPlan{account: state.Identity.Arn, access: check.Lines, where: "account " + state.Identity.Account, tf: tofu.In(a.runner, dir)}
	if err := modules.Write("aws", p.tf.Path); err != nil {
		return nil, err
	}

	fmt.Fprintln(out, "Planning the cloud side (OpenTofu)...")
	if err := p.tf.Init(ctx); err != nil {
		return nil, err
	}
	if err := a.writeAWSVars(ctx, c, p.tf, false); err != nil {
		return nil, err
	}
	changes, err := p.tf.Plan(ctx, destroy)
	if err != nil {
		return nil, err
	}
	p.changes = changes
	if !destroy {
		p.cost = a.awsCost(ctx, c)
	}
	return p, nil
}

// cloudFromAWS reads the module's outputs.
func cloudFromAWS(outputs map[string]json.RawMessage) (*install.Cloud, bool, error) {
	var v struct {
		Cluster struct {
			Name   string `json:"name"`
			Region string `json:"region"`
			Issuer string `json:"issuer"`
		}
		TaskRegistry string
		Backup       *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		Logs *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		Audit *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		StepPlacement map[string]any
		Spot          bool
		Catalog       *struct {
			RoleArn string `json:"role_arn"`
		}
		ConsoleAddress *struct {
			Host           string   `json:"host"`
			ZoneID         string   `json:"zone_id"`
			NameServers    []string `json:"name_servers"`
			CertificateArn string   `json:"certificate_arn"`
			VPCCIDR        string   `json:"vpc_cidr"`
		}
	}
	for name, into := range map[string]any{
		"cluster": &v.Cluster, "task_registry": &v.TaskRegistry, "backup": &v.Backup, "logs": &v.Logs, "audit": &v.Audit,
		"step_placement": &v.StepPlacement, "spot": &v.Spot, "catalog": &v.Catalog,
		"console_address": &v.ConsoleAddress,
	} {
		raw, ok := outputs[name]
		if !ok {
			// `tofu output` leaves out outputs that are null.
			if optionalOutputs[name] {
				continue
			}
			return nil, false, fmt.Errorf("the aws module has no %q output", name)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			return nil, false, fmt.Errorf("the aws module's %q output: %w", name, err)
		}
	}
	cloud := &install.Cloud{
		Provider:        "aws",
		TaskRegistry:    v.TaskRegistry,
		StepPlacement:   v.StepPlacement,
		ClusterName:     v.Cluster.Name,
		ClusterLocation: v.Cluster.Region,
		ClusterIssuer:   v.Cluster.Issuer,
	}
	if v.Backup != nil {
		cloud.BackupBucket, cloud.BackupRegion = v.Backup.Bucket, v.Backup.Region
	}
	if v.Logs != nil {
		cloud.LogsBucket, cloud.LogsRegion = v.Logs.Bucket, v.Logs.Region
	}
	if v.Audit != nil {
		cloud.AuditBucket, cloud.AuditRegion = v.Audit.Bucket, v.Audit.Region
	}
	if v.Catalog != nil {
		cloud.CatalogServiceAccount = v.Catalog.RoleArn
	}
	if a := v.ConsoleAddress; a != nil {
		cloud.ConsoleHost, cloud.ConsoleZoneID, cloud.ConsoleNameServers = a.Host, a.ZoneID, a.NameServers
		cloud.ConsoleCertificate, cloud.VPCCIDR = a.CertificateArn, a.VPCCIDR
	}
	return cloud, v.Spot, nil
}

// applyAWS carries out the approved cloud plan, then readies the cluster for
// the charts: credentials, Auto Mode's StorageClass and steps' node pool,
// and a Docker sign-in to push images built from source.
func (a *app) applyAWS(ctx context.Context, out io.Writer, c *config.Config, p *cloudPlan, img install.Images) (*install.Cloud, error) {
	fmt.Fprintln(out, "Creating the cloud side (OpenTofu; a new EKS cluster takes about fifteen minutes)...")
	if err := p.tf.Apply(ctx); err != nil {
		return nil, err
	}
	outputs, err := p.tf.Outputs(ctx)
	if err != nil {
		return nil, err
	}
	cloud, spot, err := cloudFromAWS(outputs)
	if err != nil {
		return nil, err
	}
	if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if err := a.runner.RunInput(ctx, awscloud.InCluster(c.Cluster.Mode, spot), "kubectl", "--context", cluster.Context(c), "apply", "-f", "-"); err != nil {
		return nil, err
	}
	if c.Cluster.Mode == "standard" {
		fmt.Fprintln(out, "Installing the Cluster Autoscaler...")
		if err := awscloud.InstallAutoscaler(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	if cloud.ConsoleHost != "" {
		if err := a.awsConsoleCertificate(ctx, out, c, cloud); err != nil {
			return nil, err
		}
		if err := a.runner.RunInput(ctx, awscloud.IngressClass, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-"); err != nil {
			return nil, err
		}
	}
	if img.Push {
		if err := awscloud.DockerLogin(ctx, a.runner, c, strings.SplitN(c.PlatformImages.Registry, "/", 2)[0]); err != nil {
			return nil, err
		}
	}
	return cloud, nil
}

// destroyAWS removes an aws install, keeping what the user chose to keep.
func (a *app) destroyAWS(ctx context.Context, out io.Writer, dir string, c *config.Config, deleteData, deleteRegistry bool) error {
	state := awscloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("AWS isn't reachable:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	kctx := cluster.Context(c)
	if state.ClusterStatus == "ACTIVE" {
		if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
			return err
		}
		for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
			if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
				return err
			}
		}
		// Volumes' disks outlive a deleted cluster: delete the claims while
		// it's there, so their EBS volumes go with them.
		if deleteData {
			fmt.Fprintln(out, "Deleting the database volume...")
			if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "pvc", "--all", "--wait=true", "--timeout=5m"); err != nil {
				return err
			}
			if err := waitNoVolumes(ctx, a, kctx, c.Namespace); err != nil {
				return err
			}
		} else if vols, _ := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.csi.volumeHandle}{\"\\n\"}{end}"); vols != "" {
			fmt.Fprintln(out, "Keeping the database's EBS volume:", strings.ReplaceAll(vols, "\n", ", "))
		}
		// The console's load balancer (made by Auto Mode, outside OpenTofu's
		// state) goes with its Ingress: wait, or it holds the network.
		if c.Console.Public {
			fmt.Fprintln(out, "Waiting for the console's load balancer to go...")
			if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
				lbs, err := awscloud.LoadBalancersIn(ctx, a.runner, c, "10.40.0.0/16")
				return err == nil && len(lbs) == 0, nil
			}); err != nil {
				return fmt.Errorf("the console's load balancer is still there: %w", err)
			}
		}
		// Auto Mode's steps nodes go before the cluster, so none is left
		// running (standard mode's steps group goes with OpenTofu's state).
		if c.Cluster.Mode == "auto" {
			_ = a.runner.Run(ctx, "kubectl", "--context", kctx, "delete", "nodepool", "vertra-steps", "--ignore-not-found", "--wait=true")
		}
	}

	tf := tofu.In(a.runner, dir)
	if err := modules.Write("aws", tf.Path); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	if err := a.writeAWSVars(ctx, c, tf, deleteData); err != nil {
		return err
	}
	const bucket = "aws_s3_bucket.backups[0]"
	var keep []string
	if c.Database.Backups.Enabled && !deleteData {
		keep = append(keep, bucket, "aws_s3_bucket_public_access_block.backups[0]", "aws_s3_bucket_lifecycle_configuration.backups[0]")
	}
	// The audit log's copy is the record, and Object Lock refuses deletes.
	if c.Audit.Export {
		keep = append(keep, "aws_s3_bucket.audit[0]", "aws_s3_bucket_public_access_block.audit[0]",
			"aws_s3_bucket_versioning.audit[0]", "aws_s3_bucket_object_lock_configuration.audit[0]")
	}
	const logsBucket = "aws_s3_bucket.logs[0]"
	if c.Logs.Enabled && !deleteData {
		keep = append(keep, logsBucket, "aws_s3_bucket_public_access_block.logs[0]", "aws_s3_bucket_lifecycle_configuration.logs[0]")
	}
	if tf.HasState(ctx) {
		var emptied []string
		if c.Database.Backups.Enabled && deleteData {
			emptied = append(emptied, bucket)
		}
		if c.Logs.Enabled && deleteData {
			emptied = append(emptied, logsBucket)
		}
		if len(emptied) > 0 {
			// A bucket with data in it is deleted only once the state says
			// it may be (delete_data: force_destroy).
			if err := tf.ApplyOnly(ctx, emptied...); err != nil {
				return err
			}
		}
		if err := tf.Forget(ctx, keep...); err != nil {
			return err
		}
		fmt.Fprintln(out, "Deleting the cloud side (OpenTofu; an EKS cluster takes several minutes)...")
		if _, err := tf.Plan(ctx, true); err != nil {
			return err
		}
		if err := tf.Apply(ctx); err != nil {
			return err
		}
	}
	// ECR made the products' repositories on push, outside the state.
	if deleteRegistry {
		if err := awscloud.DeleteTaskRepositories(ctx, a.runner, c); err != nil {
			return err
		}
	}
	for _, kind := range []string{"context", "cluster", "user"} {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-"+kind, kctx)
	}
	return nil
}

// awsCost prices the install from AWS's price list; when that fails the
// screen says so and shows no figure.
func (a *app) awsCost(ctx context.Context, c *config.Config) []plan.Line {
	prices, err := pricing.FetchAWS(ctx, a.runner, c.AWS.Profile, c.AWS.Region)
	if err != nil {
		return []plan.Line{{Label: "Estimated cost", Text: "unavailable (" + err.Error() + "): the resources above are what it would be for"}}
	}
	fetched := "fetched now"
	if time.Since(prices.Fetched) > time.Minute {
		fetched = "fetched " + prices.Fetched.Local().Format("Jan 2 15:04")
	}
	return pricing.AWS(prices, c, fetched)
}

// awsConsoleCertificate shows the zone's name servers to delegate it with,
// and waits for ACM to issue the console's certificate (it can once the
// delegation is in place).
func (a *app) awsConsoleCertificate(ctx context.Context, out io.Writer, c *config.Config, cloud *install.Cloud) error {
	status := awscloud.CertificateStatus(ctx, a.runner, c, cloud.ConsoleCertificate)
	if status == "ISSUED" {
		return nil
	}
	zone := c.Console.Zone
	fmt.Fprintf(out, "\nThe console's address, %s, is in a Route 53 zone (%s) the parent domain must delegate to.\n", cloud.ConsoleHost, zone)
	fmt.Fprintf(out, "Where %s's DNS is managed, add these NS records for %s (once; leave the rest of the domain as it is):\n", parentDomain(zone), zone)
	for _, ns := range cloud.ConsoleNameServers {
		fmt.Fprintf(out, "  %s  NS  %s\n", zone, ns)
	}
	fmt.Fprintln(out, "Waiting for the certificate (ACM issues it minutes after the records resolve)...")
	return waitFor(ctx, 90*time.Minute, 30*time.Second, func() (bool, error) {
		status = awscloud.CertificateStatus(ctx, a.runner, c, cloud.ConsoleCertificate)
		if status == "FAILED" || status == "VALIDATION_TIMED_OUT" {
			return false, fmt.Errorf("ACM couldn't issue the certificate (%s): check the NS records, then `vertra apply` again", status)
		}
		return status == "ISSUED", nil
	})
}

// awsConsoleAddress points the console's hostname at its load balancer once
// Auto Mode has made it.
func (a *app) awsConsoleAddress(ctx context.Context, out io.Writer, c *config.Config, cloud *install.Cloud) error {
	var lb string
	fmt.Fprintln(out, "Waiting for the console's load balancer...")
	if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
		lb, _ = a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
			"get", "ingress", install.ConsoleRelease+"-execution-console", "-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}")
		return strings.TrimSpace(lb) != "", nil
	}); err != nil {
		return err
	}
	lb = strings.TrimSpace(lb)
	lbZone, err := awscloud.LoadBalancerZone(ctx, a.runner, c, lb)
	if err != nil {
		return err
	}
	return awscloud.PointAt(ctx, a.runner, c, cloud.ConsoleZoneID, cloud.ConsoleHost, lb, lbZone)
}

func parentDomain(zone string) string {
	if i := strings.Index(zone, "."); i > 0 {
		return zone[i+1:]
	}
	return zone
}

// writeAWSVars writes the module's variables, after Init (it reads the
// state): a GitHub OIDC provider this install made stays its own, and one
// the account already had is only used.
func (a *app) writeAWSVars(ctx context.Context, c *config.Config, tf tofu.Dir, deleteData bool) error {
	github := ""
	if c.Catalog.Repo() != "" {
		var err error
		own := tf.Has(ctx, "aws_iam_openid_connect_provider.github[0]")
		if github, err = awscloud.GitHubProvider(ctx, a.runner, c, own); err != nil {
			return err
		}
	}
	return tf.WriteVars(awscloud.Vars(c, deleteData, github))
}
