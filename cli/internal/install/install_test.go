// SPDX-License-Identifier: MIT

package install

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/rburns629/vertra/cli/internal/config"
)

func kindConfig() *config.Config {
	c := config.Default("kind")
	c.Source = "/src/vertra"
	c.Admin.Email = "admin@example.com"
	return c
}

func TestChartsFromSourceOrRelease(t *testing.T) {
	c := kindConfig()
	k, _ := Charts(c, "/deploy/dev")
	if k.Dir != "/src/vertra/helm/charts/execution-kernel" || k.Remote != "" {
		t.Errorf("source: %+v", k)
	}
	if SizeValues(k, "minimal") != "/src/vertra/helm/charts/execution-kernel/sizes/minimal.yaml" {
		t.Errorf("size: %s", SizeValues(k, "minimal"))
	}
	c.Vertra = "0.2.0"
	_, cons := Charts(c, "/deploy/dev")
	if cons.Dir != "/deploy/dev/charts/0.2.0/execution-console" || cons.Remote != ReleaseCharts+"/execution-console" || cons.Version != "0.2.0" {
		t.Errorf("release: %+v", cons)
	}
}

func TestImagesFor(t *testing.T) {
	now := time.Date(2026, 10, 18, 9, 30, 5, 0, time.UTC)
	img := ImagesFor(kindConfig(), now)
	if img.Kernel != "execution-kernel" || img.Tag != "src-20261018-093005" || !img.Build || img.Push {
		t.Errorf("kind: %+v", img)
	}

	c := config.Default("existing")
	c.PlatformImages.Registry = "us-docker.pkg.dev/p/platform/"
	img = ImagesFor(c, now)
	if img.Console != "us-docker.pkg.dev/p/platform/execution-console" || !img.Push {
		t.Errorf("existing: %+v", img)
	}

	c.Vertra = "0.2.0"
	if img := ImagesFor(c, now); img.Build || img.Kernel != "" {
		t.Errorf("release: %+v", img)
	}
}

func TestCopies(t *testing.T) {
	c := kindConfig()
	c.MinReplicas = 3
	if len(copies(c)) != 0 {
		t.Error("with scale-down the size decides the copies")
	}
	c.ScaleDown.Enabled = false
	if got := copies(c); got["replicaCount"] != 3 {
		t.Errorf("always on: %v", got)
	}
	c.Size = "auto"
	got := copies(c)["autoscaling"].(map[string]any)
	if got["minReplicas"] != 3 || got["maxReplicas"] != 3 {
		t.Errorf("auto: %v", got)
	}
	c.MinReplicas = 5
	if got := copies(c)["autoscaling"].(map[string]any); got["maxReplicas"] != 5 {
		t.Errorf("auto, max below min: %v", got)
	}
}

func TestScaleDownAndHeadroom(t *testing.T) {
	c := kindConfig()
	c.ScaleDown.IdleAfter = "90m"
	c.ScaleDown.Schedule = "0 20 * * 1-5"
	k := KernelValues(c, Images{}, "", nil)
	sd := k["scaleDown"].(map[string]any)
	if sd["enabled"] != true || sd["idleAfterMinutes"] != 90 || sd["schedule"] != "0 20 * * 1-5" || sd["consoleFullname"] != "console-execution-console" {
		t.Errorf("scaleDown: %v", sd)
	}
	if _, ok := k["postgres"].(map[string]any)["persistence"]; ok {
		t.Error("a new volume should take the size's figure")
	}

	c.ScaleDown.Enabled = false
	c.StepHeadroom = 2
	k = KernelValues(c, Images{}, "10Gi", nil)
	if k["scaleDown"].(map[string]any)["enabled"] != false || k["stepHeadroom"].(map[string]any)["replicas"] != 2 {
		t.Errorf("always on: %v", k)
	}
	if k["postgres"].(map[string]any)["persistence"].(map[string]any)["size"] != "10Gi" {
		t.Error("an existing volume's size should be kept")
	}
}

func TestValues(t *testing.T) {
	c := kindConfig()
	img := ImagesFor(c, time.Now())
	k := KernelValues(c, img, "", nil)
	if k["imagePolicy"].(map[string]any)["sourceRegistry"] != "localhost:5001" {
		t.Errorf("kernel: %v", k)
	}
	if k["image"].(map[string]any)["tag"] != img.Tag {
		t.Errorf("kernel image: %v", k["image"])
	}

	v := ConsoleValues(c, "dev", img, nil)
	if v["kernelApiUrl"] != "http://kernel-execution-kernel-api.vertra-system.svc.cluster.local:8000" {
		t.Errorf("kernelApiUrl: %v", v["kernelApiUrl"])
	}
	if v["environmentLabel"] != "dev" || v["existingSecret"] != "kernel-execution-kernel-console-db" {
		t.Errorf("console: %v", v)
	}
	mirrors := v["registryCheck"].(map[string]any)["mirrors"].(map[string]any)
	if mirrors["localhost:5001"] != "http://kind-registry:5000" {
		t.Errorf("mirrors: %v", mirrors)
	}
	if _, ok := v["bootstrapAdmin"].(map[string]any)["password"]; ok {
		t.Error("a password must never be written to values")
	}

	c.Vertra = "0.2.0"
	if _, ok := ConsoleValues(c, "dev", ImagesFor(c, time.Now()), nil)["image"]; ok {
		t.Error("a release should use the chart's own image")
	}
}

// On aws the console gets the cluster's issuer, which IAM trusts (the
// module registers it), for its teams' AWS SecretStores.
func TestAnAWSConsoleKnowsTheIssuerStoresSignInWith(t *testing.T) {
	c := kindConfig()
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vertra-catalog"
	cloud := &Cloud{Provider: "aws", ClusterIssuer: "https://oidc.eks.us-east-2.amazonaws.com/id/ABC"}
	got := fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["secretSources"])
	if got != "map[catalogRepo:octocat/vertra-catalog clusterIssuer:https://oidc.eks.us-east-2.amazonaws.com/id/ABC]" {
		t.Errorf("secretSources: %s", got)
	}
}

func TestConsoleReadsTheCatalogsRelease(t *testing.T) {
	c := kindConfig()
	cloud := &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vertra-products"}
	if _, ok := ConsoleValues(c, "dev", Images{}, cloud)["catalog"]; ok {
		t.Error("no catalog repository, no release to read")
	}
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vertra-catalog"
	got := ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want := map[string]any{"release": "us-central1-docker.pkg.dev/p/vertra-products/catalog-release:latest"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("catalog: %v, want %v", got, want)
	}

	// Following versions: one pinned, or the newest.
	c.CatalogVersion = "v1.4.0"
	got = ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want = map[string]any{"release": "us-central1-docker.pkg.dev/p/vertra-products/catalog-release:v1.4.0"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("pinned: %v, want %v", got, want)
	}
	c.CatalogVersion = "newest"
	got = ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want = map[string]any{"release": "us-central1-docker.pkg.dev/p/vertra-products/catalog-release:latest", "newestVersion": true}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("newest: %v, want %v", got, want)
	}
}

// An install reading another cloud's catalog: its registry is the image
// source and the release's home, read by federation, the kubelet pulling
// with the console's token; and only releases the catalog's key signed.
func TestAnExternalCatalogIsReadByFederation(t *testing.T) {
	c := kindConfig()
	c.Namespace = "vertra-system"
	c.Cluster.Name = "vertra-eks"
	cloud := &Cloud{Provider: "aws", TaskRegistry: "123456789012.dkr.ecr.us-east-1.amazonaws.com/vertra-products"}
	c.ExternalCatalog.Registry = "us-central1-docker.pkg.dev/acyclix-dev/vertra-products"
	c.CatalogSignature.PublicKey = "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----\n"

	steps := FederationSteps(c, "https://oidc.eks.us-east-1.amazonaws.com/id/ABC")
	if len(steps) != 5 || !strings.Contains(steps[1], "--issuer-uri=https://oidc.eks.us-east-1.amazonaws.com/id/ABC") ||
		!strings.Contains(steps[1], "assertion.sub=='system:serviceaccount:vertra-system:console-execution-console'") ||
		!strings.Contains(steps[2], "repositories add-iam-policy-binding vertra-products --location=us-central1 --project=acyclix-dev") {
		t.Errorf("steps: %q", steps)
	}

	c.ExternalCatalog.GCPWorkloadIdentityProvider = "projects/1/locations/global/workloadIdentityPools/vertra-installs/providers/vertra-eks"
	kernel := KernelValues(c, Images{}, "", cloud)
	if fmt.Sprint(kernel["imagePolicy"]) != "map[sourceRegistry:us-central1-docker.pkg.dev/acyclix-dev/vertra-products]" ||
		fmt.Sprint(kernel["scheduler"]) != "map[taskImagePullSecret:vertra-pull]" {
		t.Errorf("kernel: %v %v", kernel["imagePolicy"], kernel["scheduler"])
	}
	console := ConsoleValues(c, "dev", Images{}, cloud)
	want := "map[ecrToken:true gcpFederation:map[hosts:[us-central1-docker.pkg.dev] serviceAccount: " +
		"workloadIdentityProvider:projects/1/locations/global/workloadIdentityPools/vertra-installs/providers/vertra-eks]]"
	if fmt.Sprint(console["registryCheck"]) != want {
		t.Errorf("registryCheck: %v", console["registryCheck"])
	}
	catalog, _ := console["catalog"].(map[string]any)
	if catalog["release"] != "us-central1-docker.pkg.dev/acyclix-dev/vertra-products/catalog-release:latest" ||
		!strings.Contains(fmt.Sprint(catalog["signature"]), "BEGIN PUBLIC KEY") {
		t.Errorf("catalog: %v", catalog)
	}
}

// An install reading another's signed catalog enforces its signer as the
// owner does: on images (policy-controller) and releases; off a cloud, on
// releases only.
func TestAReaderTrustsTheCatalogsSigner(t *testing.T) {
	c := kindConfig()
	c.ExternalCatalog.Registry = "us-central1-docker.pkg.dev/acyclix-dev/vertra-products"
	c.CatalogSignature.Repository = "my-org/vertra-catalog"
	subject := `^https://github\.com/my-org/vertra-catalog/\.github/workflows/ci\.yml@refs/heads/main$`

	// kind: releases only.
	if c.ChecksSignatures() || KernelValues(c, Images{}, "", nil)["imageSignature"] != nil {
		t.Error("kind can't check images")
	}
	catalog, _ := ConsoleValues(c, "dev", Images{}, nil)["catalog"].(map[string]any)
	if !strings.Contains(fmt.Sprint(catalog["signature"]), subject) {
		t.Errorf("kind's console: %v", catalog)
	}

	c.Target = "gcp"
	cloud := &Cloud{Provider: "gcp", SigningVerifier: "vertra-r-verifier@p.iam.gserviceaccount.com"}
	if !c.ChecksSignatures() || c.ModuleSigning() != "verify" {
		t.Errorf("gcp: checks %v, module %q", c.ChecksSignatures(), c.ModuleSigning())
	}
	images := fmt.Sprint(KernelValues(c, Images{}, "", cloud)["imageSignature"])
	if !strings.Contains(images, "enabled:true") || !strings.Contains(images, subject) || !strings.Contains(images, GitHubActionsIssuer) {
		t.Errorf("imageSignature: %v", images)
	}
	catalog, _ = ConsoleValues(c, "dev", Images{}, cloud)["catalog"].(map[string]any)
	if !strings.Contains(fmt.Sprint(catalog["signature"]), subject) {
		t.Errorf("console: %v", catalog)
	}
	grant := VerifierGrant(c, cloud.SigningVerifier)
	if grant != "gcloud artifacts repositories add-iam-policy-binding vertra-products --location=us-central1 --project=acyclix-dev "+
		"--role=roles/artifactregistry.reader --member=serviceAccount:vertra-r-verifier@p.iam.gserviceaccount.com" {
		t.Errorf("grant: %q", grant)
	}
	// Across clouds it reads with the steps' pull Secret: nothing to grant.
	c.ExternalCatalog.GCPWorkloadIdentityProvider = "projects/1/locations/global/workloadIdentityPools/vertra-installs/providers/r"
	if g := VerifierGrant(c, cloud.SigningVerifier); g != "" {
		t.Errorf("federated: %q", g)
	}

	// A key as well: either signer passes.
	c.CatalogSignature.PublicKeyFile, c.CatalogSignature.PublicKey = "cosign.pub", "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----\n"
	images = fmt.Sprint(KernelValues(c, Images{}, "", cloud)["imageSignature"])
	if !strings.Contains(images, "BEGIN PUBLIC KEY") || !strings.Contains(images, subject) {
		t.Errorf("both: %v", images)
	}
}

// On GKE the chat agent answers with Gemini through Vertex AI in the
// install's project, as the console; its scan Jobs read as their own,
// narrower identity.
func TestTheChatOnGCP(t *testing.T) {
	c := kindConfig()
	if _, ok := ConsoleValues(c, "dev", Images{}, nil)["chat"]; ok {
		t.Error("kind: the chart's own chat values, not vertra's")
	}
	c.Target = "gcp"
	c.GCP.Project = "acme-dev"
	cloud := &Cloud{Provider: "gcp", ConsoleServiceAccount: "v-console@acme-dev.iam.gserviceaccount.com", ScannerServiceAccount: "v-scanner@acme-dev.iam.gserviceaccount.com"}
	v := ConsoleValues(c, "dev", Images{}, cloud)
	chat := fmt.Sprint(v["chat"])
	if chat != "map[model:google/gemini-3.5-flash provider:vertex vertex:map[location:global project:acme-dev]]" {
		t.Errorf("chat: %s", chat)
	}
	if scanning := fmt.Sprint(v["scanning"]); !strings.Contains(scanning, "v-scanner@") {
		t.Errorf("scanning: %s", scanning)
	}
	if sa := fmt.Sprint(v["serviceAccount"]); !strings.Contains(sa, "v-console@") {
		t.Errorf("serviceAccount: %s", sa)
	}
	c.Chat.Model = "google/gemini-3.5-pro"
	if !strings.Contains(fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["chat"]), "gemini-3.5-pro") {
		t.Error("chat.model")
	}
	c.Chat.Off = true
	if _, ok := ConsoleValues(c, "dev", Images{}, cloud)["chat"]; ok {
		t.Error("chat.off")
	}
	// A module from before the scanner had its own: the console's, as then.
	cloud.ScannerServiceAccount = ""
	if scanning := fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["scanning"]); !strings.Contains(scanning, "v-console@") {
		t.Errorf("old module: %s", scanning)
	}
}

// The gateway, when it's on: its image built from source, and on GKE the
// cluster's Workload Identity pool for minting Google ID tokens.
func TestTheGatewaysValues(t *testing.T) {
	c := kindConfig()
	c.Namespace = "vertra-system"
	c.GCP.Project = "acme-dev"
	cloud := &Cloud{Provider: "gcp", ClusterName: "vertra", ClusterLocation: "us-central1"}
	img := Images{Gateway: "us-docker.pkg.dev/acme-dev/platform/execution-gateway", Tag: "src-1"}
	if _, ok := ConsoleValues(c, "dev", img, cloud)["gateway"]; ok {
		t.Error("off unless it's enabled")
	}
	c.Gateway = config.Gateway{Enabled: true, BackendHosts: []string{"*.a.run.app"}}
	gw, _ := ConsoleValues(c, "dev", img, cloud)["gateway"].(map[string]any)
	gcp, _ := gw["gcp"].(map[string]any)
	if gw["enabled"] != true || fmt.Sprint(gw["backendHosts"]) != "[*.a.run.app]" ||
		gw["url"] != "http://console-execution-console-gateway.vertra-system.svc.cluster.local:8080" ||
		fmt.Sprint(gw["image"]) != "map[repository:us-docker.pkg.dev/acme-dev/platform/execution-gateway tag:src-1]" ||
		gcp["tokenAudience"] != "acme-dev.svc.id.goog" ||
		gcp["stsAudience"] != "identitynamespace:acme-dev.svc.id.goog:https://container.googleapis.com/v1/projects/acme-dev/locations/us-central1/clusters/vertra" {
		t.Errorf("gateway = %v", gw)
	}
}

func TestWriteValues(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteValues(dir, "kernel", map[string]any{"api": map[string]any{"replicaCount": 2}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), "# Written by vertra") || !strings.Contains(string(data), "replicaCount: 2") {
		t.Errorf("got:\n%s", data)
	}
}

// A web client's JSON is read; anything else, refused.
func TestReadGoogleClient(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	web := write("web.json", `{"web":{"client_id":"id.apps.googleusercontent.com","client_secret":"s","redirect_uris":["http://localhost:18080/api/auth/oidc/callback"]}}`)
	client, err := ReadGoogleClient(web)
	if err != nil || client.ID != "id.apps.googleusercontent.com" || client.Secret != "s" || len(client.RedirectURIs) != 1 {
		t.Fatalf("a web client: %+v, %v", client, err)
	}
	if _, err := ReadGoogleClient(write("desktop.json", `{"installed":{"client_id":"x","client_secret":"y"}}`)); err == nil {
		t.Error("a desktop client was accepted")
	}
	if _, err := ReadGoogleClient(write("junk.json", `not json`)); err == nil {
		t.Error("junk was accepted")
	}
}

// Signing in with Google reaches the console chart as its sso, the secret
// by reference only.
func TestSSOValues(t *testing.T) {
	c := config.Default("kind")
	c.SSO = config.SSO{Provider: "google", ClientID: "id", ClientFile: "/x.json", AllowedDomains: []string{"example.com"}, RedirectURL: "http://localhost:18080/api/auth/oidc/callback"}
	sso, ok := ConsoleValues(c, "dev", Images{}, nil)["sso"].(map[string]any)
	if !ok {
		t.Fatal("no sso values")
	}
	if sso["issuer"] != "https://accounts.google.com" || sso["clientId"] != "id" || sso["redirectUrl"] != c.SSO.RedirectURL {
		t.Errorf("sso values: %v", sso)
	}
	if secret := sso["clientSecret"].(map[string]any); secret["name"] != SSOSecretName {
		t.Errorf("the secret's reference: %v", secret)
	}
}

// A signed catalog: both charts trust the same signer, the kernel's
// imageSignature on (policy-controller enforces it), the console's
// catalog.signature set; nothing while signing is off.
func TestASignedCatalogIsRequiredByBothCharts(t *testing.T) {
	c := kindConfig()
	c.Target = "gcp"
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vertra-catalog"
	cloud := &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vertra-products", SigningPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n"}
	if _, on := KernelValues(c, Images{}, "", cloud)["imageSignature"]; on {
		t.Error("signing off: no imageSignature")
	}

	c.Signing = "kms"
	kernel := KernelValues(c, Images{}, "", cloud)["imageSignature"].(map[string]any)
	if kernel["enabled"] != true || fmt.Sprint(kernel["publicKeys"]) != fmt.Sprint([]string{cloud.SigningPublicKey}) {
		t.Errorf("kms, kernel: %v", kernel)
	}
	console := ConsoleValues(c, "dev", Images{}, cloud)["catalog"].(map[string]any)["signature"].(map[string]any)
	if fmt.Sprint(console["publicKeys"]) != fmt.Sprint([]string{cloud.SigningPublicKey}) {
		t.Errorf("kms, console: %v", console)
	}

	c.Signing = "keyless"
	keyless := KernelValues(c, Images{}, "", cloud)["imageSignature"].(map[string]any)["keyless"].(map[string]any)
	if keyless["issuer"] != GitHubActionsIssuer {
		t.Errorf("keyless issuer: %v", keyless)
	}
	subject := regexp.MustCompile(keyless["subjectRegExp"].(string))
	for name, want := range map[string]bool{
		"https://github.com/octocat/vertra-catalog/.github/workflows/ci.yml@refs/heads/main":       true,
		"https://github.com/octocat/vertra-catalog/.github/workflows/ci.yml@refs/heads/feature":    false,
		"https://github.com/octocat/vertra-catalog/.github/workflows/other.yml@refs/heads/main":    false,
		"https://github.com/octocat/vertra-catalogs/.github/workflows/ci.yml@refs/heads/main":      false,
		"https://github.com/someone/vertra-catalog/.github/workflows/ci.yml@refs/heads/main":       false,
		"https://github.com/octocat/vertra-catalog/.github/workflows/ci.yml@refs/heads/main/extra": false,
	} {
		if subject.MatchString(name) != want {
			t.Errorf("keyless subject %q: match %v", name, !want)
		}
	}
}
