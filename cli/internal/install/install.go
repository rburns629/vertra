// SPDX-License-Identifier: MIT

// Package install installs Vertra's two Helm releases: the charts from a
// source checkout or a release, their images built from source (and loaded
// onto kind, or pushed to a registry) or the released ones, and the values
// vertra generates from the config, with the user's own values last.
package install

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/run"
)

// Cloud is what a cloud target's OpenTofu module made, for the values.
type Cloud struct {
	Provider              string // gcp, aws
	TaskRegistry          string
	ConsoleServiceAccount string // gcp: the console's Google service account
	BackupBucket          string
	BackupRegion          string // aws: the bucket's region
	// BackupServiceAccount is the cloud identity the backups run as (gcp);
	// on aws, EKS Pod Identity binds the role by ServiceAccount name.
	BackupServiceAccount string
	// The chart's scheduler.taskPlacement: where steps run (Spot, a pool).
	StepPlacement   map[string]any
	ClusterName     string
	ClusterLocation string
	ClusterIssuer   string
	WorkloadPool    string
	// The console's public address (its global address's name and IP) and
	// hostname, when it's reached over HTTPS.
	ConsoleAddressName string
	ConsoleIP          string
	ConsoleHost        string
	// The catalog's federation: its CI's provider and identity.
	CatalogProvider       string
	CatalogServiceAccount string
	// aws: the console's certificate, its zone, and the VPC's range (where
	// the load balancer connects from).
	ConsoleCertificate string
	ConsoleZoneID      string
	ConsoleNameServers []string
	VPCCIDR            string
}

// googleFrontEnds are where Google's load balancers connect from.
var googleFrontEnds = []string{"35.191.0.0/16", "130.211.0.0/22"}

// ConsoleHostname is the console's public name: the configured one, or a
// nip.io name that resolves to its address by itself.
func ConsoleHostname(c *config.Config, ip string) string {
	if c.Console.Hostname != "" {
		return c.Console.Hostname
	}
	return "console." + strings.ReplaceAll(ip, ".", "-") + ".nip.io"
}

// certificateName is the console's Google-managed certificate.
const certificateName = "vertra-console"

// EnsureCertificate creates (or updates) the Google-managed certificate for
// the console's hostname. Google issues it once the name resolves to the
// load balancer: up to an hour.
func EnsureCertificate(ctx context.Context, r *run.Runner, c *config.Config, host string) error {
	manifest := fmt.Sprintf(`apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: %s
  namespace: %s
  labels:
    app.kubernetes.io/managed-by: vertra
spec:
  domains: [%q]
`, certificateName, c.Namespace, host)
	return r.RunInput(ctx, manifest, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-")
}

// CertificateStatus is the console certificate's status (Active,
// Provisioning, ...), or "" without one.
func CertificateStatus(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, _ := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "managedcertificate", certificateName, "--ignore-not-found", "-o", "jsonpath={.status.certificateStatus}")
	return strings.TrimSpace(out)
}

// BackupServiceAccountName is the Kubernetes ServiceAccount the database
// backups run as (the kernel chart's backup.serviceAccountName), bound to
// the module's backup identity.
const BackupServiceAccountName = "vertra-pg-backup"

// Release names: fixed, so the console finds kernel-api's Service and the
// database Secret by name.
const (
	KernelRelease  = "kernel"
	ConsoleRelease = "console"
	// ReleaseCharts is where released charts are published.
	ReleaseCharts = "oci://ghcr.io/rburns629/vertra/charts"
)

// Chart is a chart's local directory (Dir), from a source checkout or, for
// a release, pulled from Remote at Version into the environment's
// directory. Installing from a directory gives the size presets
// (<chart>/sizes/) the same way either way.
type Chart struct {
	Dir     string
	Remote  string
	Version string
}

// Charts returns the kernel and console charts for a config; dir is the
// environment's directory.
func Charts(c *config.Config, dir string) (kernel, console Chart) {
	if c.Vertra == "source" {
		return Chart{Dir: filepath.Join(c.Source, "helm", "charts", "execution-kernel")},
			Chart{Dir: filepath.Join(c.Source, "helm", "charts", "execution-console")}
	}
	pulled := filepath.Join(dir, "charts", c.Vertra)
	return Chart{Dir: filepath.Join(pulled, "execution-kernel"), Remote: ReleaseCharts + "/execution-kernel", Version: c.Vertra},
		Chart{Dir: filepath.Join(pulled, "execution-console"), Remote: ReleaseCharts + "/execution-console", Version: c.Vertra}
}

// Pull fetches a released chart into its Dir, once per version.
func Pull(ctx context.Context, r *run.Runner, chart Chart) error {
	if chart.Remote == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Join(chart.Dir, "Chart.yaml")); err == nil {
		return nil
	}
	return r.Run(ctx, "helm", "pull", chart.Remote, "--version", chart.Version, "--untar", "--untardir", filepath.Dir(chart.Dir))
}

// SizeValues is the chart's preset for the config's size.
func SizeValues(chart Chart, size string) string {
	return filepath.Join(chart.Dir, "sizes", size+".yaml")
}

// Images says which platform images the releases run. Empty Repository
// means the chart's default (the release's own images).
type Images struct {
	Kernel, Console string // repositories
	Tag             string
	// Build: built from Source by this apply.
	Build bool
	// Push: pushed to a registry (an existing cluster) rather than loaded
	// onto kind's node.
	Push bool
}

// ImagesFor decides the platform images; a source build gets a fresh tag,
// so each apply rolls the Pods onto what it just built.
func ImagesFor(c *config.Config, now time.Time) Images {
	if c.Vertra != "source" {
		return Images{}
	}
	tag := "src-" + now.UTC().Format("20060102-150405")
	if c.Target == "kind" {
		return Images{Kernel: "execution-kernel", Console: "execution-console", Tag: tag, Build: true}
	}
	prefix := strings.TrimSuffix(c.PlatformImages.Registry, "/")
	if c.Target == "gcp" {
		prefix = gcp.PlatformRegistry(c)
	}
	return Images{Kernel: prefix + "/execution-kernel", Console: prefix + "/execution-console", Tag: tag, Build: true, Push: true}
}

// BuildImages builds both images from source, then loads them onto kind's
// node or pushes them.
func BuildImages(ctx context.Context, r *run.Runner, c *config.Config, img Images) error {
	for _, part := range []struct{ repo, dir string }{
		{img.Kernel, "kernel"}, {img.Console, "console"},
	} {
		ref := part.repo + ":" + img.Tag
		args := []string{"build", "-t", ref}
		if img.Push {
			// A cloud's nodes are x86, whatever this machine is.
			args = append(args, "--platform", "linux/amd64")
		}
		if err := r.Run(ctx, "docker", append(args, filepath.Join(c.Source, part.dir))...); err != nil {
			return err
		}
		if img.Push {
			if err := r.Run(ctx, "docker", "push", ref); err != nil {
				return err
			}
		} else if err := r.Run(ctx, "kind", "load", "docker-image", ref, "--name", c.Cluster.Name); err != nil {
			return err
		}
	}
	return nil
}

// AlwaysOn is how many copies of the console and kernel-api the config
// keeps running when it doesn't scale down, or 0 to leave it to the size.
func AlwaysOn(c *config.Config) int {
	if c.ScaleDown.Enabled {
		return 0
	}
	return c.MinReplicas
}

// copies is the console's or kernel-api's count over the size preset: the
// always-on copies, as replicas or (auto) as the autoscaler's minimum.
func copies(c *config.Config) map[string]any {
	n := AlwaysOn(c)
	switch {
	case n == 0:
		return map[string]any{}
	case c.Size == "auto":
		return map[string]any{"autoscaling": map[string]any{"minReplicas": n, "maxReplicas": max(n, 3)}}
	default:
		return map[string]any{"replicaCount": n}
	}
}

// IdleMinutes is scale-down's idle period in whole minutes (at least one).
func IdleMinutes(c *config.Config) int {
	d, err := time.ParseDuration(c.ScaleDown.IdleAfter)
	if err != nil {
		return 120
	}
	return max(1, int(d.Minutes()))
}

// KernelValues are the values vertra generates for the kernel chart.
// volume, when set, is the database volume's current size: kept, since a
// volume can't shrink and kind's can't grow.
func KernelValues(c *config.Config, img Images, volume string, cloud *Cloud) map[string]any {
	postgres := map[string]any{
		// One Postgres for both databases, each with its own role.
		"consoleDatabase": map[string]any{"enabled": true},
	}
	if volume != "" {
		postgres["persistence"] = map[string]any{"size": volume}
	}
	scaleDown := map[string]any{"enabled": c.ScaleDown.Enabled}
	if c.ScaleDown.Enabled {
		scaleDown["idleAfterMinutes"] = IdleMinutes(c)
		scaleDown["schedule"] = c.ScaleDown.Schedule
		scaleDown["consoleFullname"] = ConsoleRelease + "-execution-console"
	}
	v := map[string]any{
		"api":            copies(c),
		"postgres":       postgres,
		"backup":         map[string]any{"enabled": false},
		"imagePolicy":    map[string]any{"sourceRegistry": c.TaskImages.Registry},
		"dispatchPolicy": map[string]any{"allowReleaseNamespace": false},
		"scaleDown":      scaleDown,
		"stepHeadroom":   map[string]any{"replicas": c.StepHeadroom},
	}
	if img.Kernel != "" {
		v["image"] = map[string]any{"repository": img.Kernel, "tag": img.Tag}
	}
	if cloud != nil {
		v["imagePolicy"] = map[string]any{"sourceRegistry": cloud.TaskRegistry}
		if cloud.StepPlacement != nil {
			v["scheduler"] = map[string]any{"taskPlacement": cloud.StepPlacement}
		}
		switch {
		case cloud.BackupBucket != "" && cloud.Provider == "aws":
			v["backup"] = map[string]any{
				"enabled": true, "destination": "s3", "serviceAccountName": BackupServiceAccountName,
				"s3": map[string]any{"bucket": cloud.BackupBucket, "region": cloud.BackupRegion},
			}
		case cloud.BackupBucket != "":
			v["backup"] = map[string]any{
				"enabled": true, "destination": "gcs", "serviceAccountName": BackupServiceAccountName,
				"gcs": map[string]any{"bucket": cloud.BackupBucket},
			}
		}
	}
	return v
}

// ConsoleValues are the values vertra generates for the console chart.
func ConsoleValues(c *config.Config, env string, img Images, cloud *Cloud) map[string]any {
	v := map[string]any{
		"kernelApiUrl":     fmt.Sprintf("http://%s-execution-kernel-api.%s.svc.cluster.local:8000", KernelRelease, c.Namespace),
		"environmentLabel": env,
		// Its database lives on the kernel's Postgres, whose chart makes this Secret.
		"postgres":          map[string]any{"enabled": false},
		"existingSecret":    KernelRelease + "-execution-kernel-console-db",
		"existingSecretKey": "database-url",
		// No password: one is generated and shown once (Password).
		"bootstrapAdmin": map[string]any{"email": c.Admin.Email},
	}
	if c.Target == "kind" {
		// Pinning images asks the local registry by its in-cluster name.
		v["registryCheck"] = map[string]any{"mirrors": map[string]any{
			c.TaskImages.Registry: fmt.Sprintf("http://%s:5000", c.Kind.RegistryName),
		}}
	}
	for k, val := range copies(c) {
		v[k] = val
	}
	if cloud != nil && cloud.Provider == "aws" {
		// Reading ECR with the console's own role (EKS Pod Identity, bound
		// to its ServiceAccounts by name: no annotations).
		v["registryCheck"] = map[string]any{"ecrToken": true}
		if cloud.ConsoleHost != "" {
			// HTTPS only, on an Application Load Balancer with ACM's
			// certificate; the load balancer connects from inside the VPC.
			v["ingress"] = map[string]any{
				"enabled":   true,
				"host":      cloud.ConsoleHost,
				"className": "vertra-alb",
				"annotations": map[string]any{
					"alb.ingress.kubernetes.io/certificate-arn":  cloud.ConsoleCertificate,
					"alb.ingress.kubernetes.io/listen-ports":     `[{"HTTPS":443}]`,
					"alb.ingress.kubernetes.io/target-type":      "ip",
					"alb.ingress.kubernetes.io/healthcheck-path": "/health/ready",
					"alb.ingress.kubernetes.io/ssl-policy":       "ELBSecurityPolicy-TLS13-1-2-2021-06",
				},
			}
			v["trustProxy"] = []string{cloud.VPCCIDR}
		}
	}
	if cloud != nil && cloud.Provider != "aws" {
		// Reading the task registry (pinning digests, scanning) as the
		// module's console identity, through GKE's Workload Identity.
		identity := map[string]any{"iam.gke.io/gcp-service-account": cloud.ConsoleServiceAccount}
		v["serviceAccount"] = map[string]any{"annotations": identity}
		v["scanning"] = map[string]any{"serviceAccountAnnotations": identity}
		v["registryCheck"] = map[string]any{"gcpMetadataToken": true}
		v["secretSources"] = map[string]any{
			"clusterIssuer":           cloud.ClusterIssuer,
			"gcpWorkloadIdentityPool": cloud.WorkloadPool,
			"gkeClusterName":          cloud.ClusterName,
			"gkeClusterLocation":      cloud.ClusterLocation,
			"catalogRepo":             c.Catalog.Repo(),
		}
		if cloud.ConsoleHost != "" {
			// HTTPS only, on the reserved address, with Google's certificate.
			v["ingress"] = map[string]any{
				"enabled": true,
				"host":    cloud.ConsoleHost,
				"annotations": map[string]any{
					"kubernetes.io/ingress.class":                 "gce",
					"kubernetes.io/ingress.global-static-ip-name": cloud.ConsoleAddressName,
					"networking.gke.io/managed-certificates":      certificateName,
					"kubernetes.io/ingress.allow-http":            "false",
				},
			}
			v["trustProxy"] = append(append([]string{}, googleFrontEnds...), cloud.ConsoleIP)
		}
	}
	if cloud != nil && c.Catalog.Repo() != "" {
		// The catalog's release, which its CI pushes beside the images and
		// the console reads (unsigned: vertra's catalogs sign nothing yet).
		v["catalog"] = map[string]any{"release": cloud.TaskRegistry + "/catalog-release:latest"}
	}
	if img.Console != "" {
		v["image"] = map[string]any{"repository": img.Console, "tag": img.Tag}
	}
	return v
}

// EnsureBackupServiceAccount creates (or updates) the Kubernetes
// ServiceAccount the backups run as: on gcp annotated with its Google
// service account; on aws, EKS Pod Identity binds it by name.
func EnsureBackupServiceAccount(ctx context.Context, r *run.Runner, c *config.Config, cloud *Cloud) error {
	annotations := ""
	if cloud.Provider != "aws" {
		annotations = fmt.Sprintf("  annotations:\n    iam.gke.io/gcp-service-account: %s\n", cloud.BackupServiceAccount)
	}
	manifest := fmt.Sprintf(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: %s
  namespace: %s
  labels:
    app.kubernetes.io/managed-by: vertra
%sautomountServiceAccountToken: false
`, BackupServiceAccountName, c.Namespace, annotations)
	return r.RunInput(ctx, manifest, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-")
}

// DatabaseVolume is the kernel database volume's current size, or "" if it
// doesn't exist yet.
func DatabaseVolume(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "pvc", KernelRelease+"-execution-kernel-postgres", "--ignore-not-found",
		"-o", "jsonpath={.spec.resources.requests.storage}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// MetricsServer installs the cluster's metrics API on kind (the auto size's
// autoscalers need it; the clouds have their own). Pinned.
func MetricsServer(ctx context.Context, r *run.Runner, c *config.Config) error {
	return r.Run(ctx, "helm", "upgrade", "--install", "metrics-server", "metrics-server",
		"--repo", "https://kubernetes-sigs.github.io/metrics-server/", "--version", MetricsServerChart,
		"--kube-context", cluster.Context(c), "--namespace", "kube-system",
		// kind's kubelets serve self-signed certificates.
		"--set", "args={--kubelet-insecure-tls}", "--wait", "--timeout", "5m")
}

// MetricsServerChart is the metrics-server chart version installed on kind.
const MetricsServerChart = "3.14.0"

// WriteValues writes generated values next to the config, for the record
// and for helm -f.
func WriteValues(dir, name string, values map[string]any) (string, error) {
	data, err := yaml.Marshal(values)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "generated", name+".yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	header := "# Written by vertra apply from vertra.yaml; changes here are overwritten.\n"
	return path, os.WriteFile(path, append([]byte(header), data...), 0o644)
}

// Upgrade installs or upgrades one release.
//
// A first install runs without --wait: both charts migrate in a
// post-install hook, which Helm runs only after --wait has seen every Pod
// ready, and the console isn't ready until its tables exist. Helm still
// waits for the hook Job; the rollout is waited for after it. Upgrades
// migrate in a pre-upgrade hook, so --wait is safe there.
func Upgrade(ctx context.Context, r *run.Runner, c *config.Config, dir, release string, chart Chart, generated string) error {
	fresh := Installed(ctx, r, c, release) == ""
	args := []string{
		"upgrade", "--install", release, chart.Dir,
		"--kube-context", cluster.Context(c), "--namespace", c.Namespace,
		"--reset-values", "--timeout", "10m",
		// Lowest first: the size preset, what vertra generates, yours.
		"-f", SizeValues(chart, c.Size),
		"-f", generated,
		// Others own fields Helm sets under server-side apply: the console
		// edits the kernel's image and identity policies, and sleep, wake and
		// the scanner's idling set replica counts. vertra's values win.
		"--force-conflicts",
	}
	if !fresh {
		args = append(args, "--wait")
	}
	if c.Values != "" {
		args = append(args, "-f", filepath.Join(dir, c.Values))
	}
	if err := r.Run(ctx, "helm", args...); err != nil || !fresh {
		return err
	}
	return r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"rollout", "status", "deployment", "--selector", "app.kubernetes.io/instance="+release, "--timeout", "10m")
}

// Installed returns a release's chart (name-version), or "" if it isn't
// installed.
func Installed(ctx context.Context, r *run.Runner, c *config.Config, release string) string {
	out, err := r.Output(ctx, "helm", "list", "--kube-context", cluster.Context(c), "--namespace", c.Namespace,
		"--filter", "^"+release+"$", "--output", "json")
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`"chart":"([^"]+)"`).FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	return m[1]
}

// Password returns the first admin's generated password, from the console's
// migration Job's log, if this install created it.
func Password(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"logs", "job/"+ConsoleRelease+"-execution-console-migrate")
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`one was generated: (\S+)`).FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	return m[1]
}

// Uninstall removes a release. The database volume stays: the charts mark
// it to be kept (postgres.persistence.keepOnUninstall).
func Uninstall(ctx context.Context, r *run.Runner, c *config.Config, release string) error {
	if Installed(ctx, r, c, release) == "" {
		return nil
	}
	return r.Run(ctx, "helm", "uninstall", release, "--kube-context", cluster.Context(c), "--namespace", c.Namespace, "--wait")
}
