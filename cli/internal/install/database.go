// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/run"
)

// ManagedDatabase is a managed database the module made (database.type
// managed): Cloud SQL for PostgreSQL on gcp, reached at its private IP and
// signed in to by each service as its own Google identity (IAM database
// authentication), so nothing here is a secret.
type ManagedDatabase struct {
	Instance string
	Host     string
	// CACert is the server's CA (PEM): clients check they reached it.
	CACert string
	// The database user each service signs in as, and the administrator
	// database-setup runs as.
	KernelUser, ConsoleUser, GatewayUser, AdminUser string
	// The Google service accounts the kernel's, the gateway's and
	// database-setup's Kubernetes ServiceAccounts are bound to (the
	// console's is ConsoleServiceAccount).
	KernelServiceAccount, GatewayServiceAccount, AdminServiceAccount string
}

const (
	// DatabaseCASecret holds the managed server's CA (ca.crt), mounted at
	// /etc/vertra/tls-db by the charts (database.caSecret).
	DatabaseCASecret = "vertra-db-ca"
	// The console's and the gateway's database URLs (no password in them).
	ConsoleDatabaseSecret = "vertra-console-db"
	GatewayDatabaseSecret = "vertra-gateway-db"
	// DatabaseAdminAccount is the ServiceAccount database-setup runs as,
	// bound to the module's administrator identity.
	DatabaseAdminAccount = "vertra-db-admin"
	databaseSetupJob     = "vertra-database-setup"
	// ReleaseImages is where released platform images are published.
	ReleaseImages = "ghcr.io/rburns629/vertra"
)

// databaseURL is a service's URL for the managed server: its user, no
// password (its token is the password), TLS checked against the server's
// CA. The server's certificate names the instance, not its address, so the
// hostname isn't checked (libpq's verify-ca); node-postgres needs telling
// to use libpq's meaning, which pgx would refuse as an unknown parameter.
func databaseURL(user, host, database string, node bool) string {
	u := url.URL{Scheme: "postgresql", User: url.User(user), Host: host + ":5432", Path: "/" + database}
	q := "sslmode=verify-ca&sslrootcert=/etc/vertra/tls-db/ca.crt"
	if node {
		q = "uselibpqcompat=true&" + q
	}
	u.RawQuery = q
	return u.String()
}

// googleIdentity is the annotation that binds a ServiceAccount to a
// Google service account (GKE Workload Identity).
func googleIdentity(account string) map[string]any {
	return map[string]any{"iam.gke.io/gcp-service-account": account}
}

// managedKernelValues are the kernel chart's values for a managed database.
func managedKernelValues(v map[string]any, db *ManagedDatabase) {
	v["postgres"] = map[string]any{"enabled": false}
	v["externalDatabaseUrl"] = databaseURL(db.KernelUser, db.Host, "execution_kernel", false)
	v["database"] = map[string]any{"iamAuth": "gcp", "caSecret": DatabaseCASecret}
	v["serviceAccount"] = map[string]any{"annotations": googleIdentity(db.KernelServiceAccount)}
	// The server backs itself up (daily, with point-in-time recovery).
	v["backup"] = map[string]any{"enabled": false}
}

// managedConsoleValues are the console chart's values for a managed database.
func managedConsoleValues(v map[string]any, db *ManagedDatabase) {
	v["existingSecret"] = ConsoleDatabaseSecret
	v["existingSecretKey"] = "database-url"
	v["database"] = map[string]any{"iamAuth": "gcp", "caSecret": DatabaseCASecret}
}

// managedGatewayValues are the gateway's: its own user, which the console's
// migration grants what it reads.
func managedGatewayValues(gateway map[string]any, db *ManagedDatabase) {
	gateway["database"] = map[string]any{"existingSecret": GatewayDatabaseSecret, "role": db.GatewayUser}
	gateway["serviceAccountAnnotations"] = googleIdentity(db.GatewayServiceAccount)
}

// ManagedDatabaseTier is the Cloud SQL machine for a size, as the gcp
// module picks it, for people.
func ManagedDatabaseTier(size string) string {
	return map[string]string{
		"minimal":   "db-g1-small: shared vCPU, 1.7 GB",
		"resilient": "db-custom-1-3840: 1 vCPU, 3.75 GB",
		"auto":      "db-custom-1-3840: 1 vCPU, 3.75 GB",
		"scaled":    "db-custom-2-7680: 2 vCPU, 7.5 GB",
	}[size]
}

// KernelImage is the kernel image an apply runs.
func KernelImage(c *config.Config, img Images) string {
	if img.Kernel != "" {
		return img.Kernel + ":" + img.Tag
	}
	return ReleaseImages + "/execution-kernel:" + c.Vertra
}

// EnsureManagedDatabase readies the cluster for a managed database before
// the charts: the server's CA and the console's and gateway's URLs as
// Secrets, database-setup's ServiceAccount, and database-setup itself,
// which opens each database to its service alone (kernel/internal/dbsetup).
// Run every apply: it changes nothing once done.
func EnsureManagedDatabase(ctx context.Context, r *run.Runner, c *config.Config, db *ManagedDatabase, kernelImage string) error {
	k := func(args ...string) []string {
		return append([]string{"--context", cluster.Context(c), "--namespace", c.Namespace}, args...)
	}
	indent := func(s string) string { return "    " + strings.ReplaceAll(strings.TrimSpace(s), "\n", "\n    ") }
	secrets := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
stringData:
  ca.crt: |
%s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
stringData:
  database-url: %q
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
stringData:
  database-url: %q
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
  annotations:
    iam.gke.io/gcp-service-account: %s
`, DatabaseCASecret, indent(db.CACert),
		ConsoleDatabaseSecret, databaseURL(db.ConsoleUser, db.Host, "execution_console", true),
		GatewayDatabaseSecret, databaseURL(db.GatewayUser, db.Host, "execution_console", false),
		DatabaseAdminAccount, db.AdminServiceAccount)
	if err := r.RunInput(ctx, secrets, "kubectl", k("apply", "-f", "-")...); err != nil {
		return err
	}
	if err := r.Run(ctx, "kubectl", k("delete", "job", databaseSetupJob, "--ignore-not-found", "--wait")...); err != nil {
		return err
	}
	if err := r.RunInput(ctx, databaseSetupManifest(db, kernelImage), "kubectl", k("apply", "-f", "-")...); err != nil {
		return err
	}
	// A new node may have to start first.
	if err := r.Run(ctx, "kubectl", k("wait", "job/"+databaseSetupJob, "--for=condition=complete", fmt.Sprintf("--timeout=%ds", int((10*time.Minute).Seconds())))...); err != nil {
		logs, _ := r.Output(ctx, "kubectl", k("logs", "job/"+databaseSetupJob, "--tail=20")...)
		return fmt.Errorf("opening the managed database to its services (job/%s): %w\n%s", databaseSetupJob, err, strings.TrimSpace(logs))
	}
	return nil
}

// databaseSetupManifest is `kernel database-setup` as a Job, as the
// administrator identity, connecting to the server's maintenance database.
func databaseSetupManifest(db *ManagedDatabase, image string) string {
	grants := fmt.Sprintf(`[{"database":"execution_kernel","role":%q},{"database":"execution_console","role":%q,"regrant":true}]`,
		db.KernelUser, db.ConsoleUser)
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      serviceAccountName: %s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: setup
          image: %s
          command: ["/usr/local/bin/kernel", "database-setup"]
          env:
            - {name: DATABASE_URL, value: %q}
            - {name: DATABASE_IAM_AUTH, value: gcp}
            - {name: DATABASE_SETUP, value: %q}
          volumeMounts:
            - {name: db-ca, mountPath: /etc/vertra/tls-db, readOnly: true}
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 128Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
      volumes:
        - name: db-ca
          secret: {secretName: %s}
`, databaseSetupJob, DatabaseAdminAccount, image,
		databaseURL(db.AdminUser, db.Host, "postgres", false), grants, DatabaseCASecret)
}
