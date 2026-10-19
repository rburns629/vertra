// SPDX-License-Identifier: MIT

package install

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rburns629/acyclix/cli/internal/config"
)

func kindConfig() *config.Config {
	c := config.Default("kind")
	c.Source = "/src/acyclix"
	c.Admin.Email = "admin@example.com"
	return c
}

func TestChartsFromSourceOrRelease(t *testing.T) {
	c := kindConfig()
	k, _ := Charts(c, "/deploy/dev")
	if k.Dir != "/src/acyclix/helm/charts/execution-kernel" || k.Remote != "" {
		t.Errorf("source: %+v", k)
	}
	if SizeValues(k, "minimal") != "/src/acyclix/helm/charts/execution-kernel/sizes/minimal.yaml" {
		t.Errorf("size: %s", SizeValues(k, "minimal"))
	}
	c.Acyclix = "0.2.0"
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

	c.Acyclix = "0.2.0"
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
	if v["kernelApiUrl"] != "http://kernel-execution-kernel-api.acyclix-system.svc.cluster.local:8000" {
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

	c.Acyclix = "0.2.0"
	if _, ok := ConsoleValues(c, "dev", ImagesFor(c, time.Now()), nil)["image"]; ok {
		t.Error("a release should use the chart's own image")
	}
}

func TestWriteValues(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteValues(dir, "kernel", map[string]any{"api": map[string]any{"replicaCount": 2}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), "# Written by acyclixctl") || !strings.Contains(string(data), "replicaCount: 2") {
		t.Errorf("got:\n%s", data)
	}
}
