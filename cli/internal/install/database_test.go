// SPDX-License-Identifier: MIT

package install

import (
	"fmt"
	"strings"
	"testing"
)

func managedCloud() *Cloud {
	return &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vertra-products", Database: &ManagedDatabase{
		Instance: "vertra-ab12", Host: "10.40.0.3", CACert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
		KernelUser: "vertra-kernel@p.iam", ConsoleUser: "vertra-console@p.iam", GatewayUser: "vertra-gateway@p.iam", AdminUser: "vertra-db-admin@p.iam",
		KernelServiceAccount: "vertra-kernel@p.iam.gserviceaccount.com", GatewayServiceAccount: "vertra-gateway@p.iam.gserviceaccount.com",
		AdminServiceAccount: "vertra-db-admin@p.iam.gserviceaccount.com",
	}}
}

// Each service's URL names its own user and no password, and checks the
// server against its CA; only node-postgres is told libpq's meaning.
func TestManagedDatabaseURLs(t *testing.T) {
	for _, c := range []struct {
		node bool
		want string
	}{
		{false, "postgresql://vertra-kernel%40p.iam@10.40.0.3:5432/execution_kernel?sslmode=verify-ca&sslrootcert=/etc/vertra/tls-db/ca.crt"},
		{true, "postgresql://vertra-kernel%40p.iam@10.40.0.3:5432/execution_kernel?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=/etc/vertra/tls-db/ca.crt"},
	} {
		if got := databaseURL("vertra-kernel@p.iam", "10.40.0.3", "execution_kernel", c.node); got != c.want {
			t.Errorf("node=%v: %s, want %s", c.node, got, c.want)
		}
	}
}

func TestAManagedDatabaseReplacesTheInClusterOne(t *testing.T) {
	c := kindConfig()
	c.Gateway.Enabled = true
	cloud := managedCloud()

	kernel := KernelValues(c, Images{}, "", cloud)
	for key, want := range map[string]string{
		"postgres":            "map[enabled:false]",
		"backup":              "map[enabled:false]",
		"database":            "map[caSecret:vertra-db-ca iamAuth:gcp]",
		"serviceAccount":      "map[annotations:map[iam.gke.io/gcp-service-account:vertra-kernel@p.iam.gserviceaccount.com]]",
		"externalDatabaseUrl": "postgresql://vertra-kernel%40p.iam@10.40.0.3:5432/execution_kernel?sslmode=verify-ca&sslrootcert=/etc/vertra/tls-db/ca.crt",
	} {
		if got := fmt.Sprint(kernel[key]); got != want {
			t.Errorf("kernel %s: %s, want %s", key, got, want)
		}
	}

	console := ConsoleValues(c, "dev", Images{}, cloud)
	if console["existingSecret"] != ConsoleDatabaseSecret || fmt.Sprint(console["database"]) != "map[caSecret:vertra-db-ca iamAuth:gcp]" {
		t.Errorf("console: %v, %v", console["existingSecret"], console["database"])
	}
	gateway := console["gateway"].(map[string]any)
	if fmt.Sprint(gateway["database"]) != "map[existingSecret:vertra-gateway-db role:vertra-gateway@p.iam]" ||
		fmt.Sprint(gateway["serviceAccountAnnotations"]) != "map[iam.gke.io/gcp-service-account:vertra-gateway@p.iam.gserviceaccount.com]" {
		t.Errorf("gateway: %v, %v", gateway["database"], gateway["serviceAccountAnnotations"])
	}
}

func TestDatabaseSetupRunsAsTheAdministratorAndOpensEachDatabaseToItsService(t *testing.T) {
	m := databaseSetupManifest(managedCloud().Database, "ghcr.io/rburns629/vertra/execution-kernel:0.6.0")
	for _, want := range []string{
		"serviceAccountName: vertra-db-admin",
		`command: ["/usr/local/bin/kernel", "database-setup"]`,
		`"postgresql://vertra-db-admin%40p.iam@10.40.0.3:5432/postgres?sslmode=verify-ca&sslrootcert=/etc/vertra/tls-db/ca.crt"`,
		`{\"database\":\"execution_kernel\",\"role\":\"vertra-kernel@p.iam\"}`,
		`{\"database\":\"execution_console\",\"role\":\"vertra-console@p.iam\",\"regrant\":true}`,
		"runAsNonRoot: true",
	} {
		if !strings.Contains(m, want) {
			t.Errorf("missing %s in:\n%s", want, m)
		}
	}
}
