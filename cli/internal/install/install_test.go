// SPDX-License-Identifier: MIT

package install

import (
	"fmt"
	"os"
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
