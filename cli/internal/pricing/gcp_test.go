// SPDX-License-Identifier: MIT

package pricing

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/rburns629/acyclix/cli/internal/config"
	"github.com/rburns629/acyclix/cli/internal/plan"
)

// testdata/gcp-skus.json: real catalog entries (October 2026), the ones the
// estimate needs for us-central1 plus near misses (another region, another
// compute class, regional disks, the EMEA group).
func fixture(t *testing.T) (gke, compute []sku) {
	t.Helper()
	data, err := os.ReadFile("testdata/gcp-skus.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ GKE, Compute, Networking []sku }
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f.GKE, append(f.Compute, f.Networking...)
}

func TestPricesFromTheCatalog(t *testing.T) {
	gke, compute := fixture(t)
	p, err := PricesFromGCP(gke, compute, "us-central1")
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string][2]float64{
		"Autopilot vCPU":      {p.AutopilotCPU, 0.0445},
		"Autopilot GiB":       {p.AutopilotMem, 0.004922},
		"Autopilot Spot vCPU": {p.AutopilotSpotCPU, 0.0133},
		"cluster fee":         {p.ClusterFee, 0.1},
		"E2 core":             {p.E2Core, 0.021812},
		"E2 Spot core":        {p.E2SpotCore, 0.01309},
		"balanced disk":       {p.BalancedDisk, 0.1},
		"forwarding rule":     {p.ForwardingRule, 0.025},
	} {
		if math.Abs(got[0]-got[1]) > 0.0000011 {
			t.Errorf("%s: %v, want %v", name, got[0], got[1])
		}
	}
}

func TestMissingPricesFailRatherThanGuess(t *testing.T) {
	gke, compute := fixture(t)
	if _, err := PricesFromGCP(gke, compute, "asia-east1"); err == nil {
		t.Error("a region the catalog doesn't price should fail")
	}
}

func prices() *GCPPrices {
	return &GCPPrices{
		Region: "us-central1", AutopilotCPU: 0.044, AutopilotMem: 0.005, AutopilotSpotCPU: 0.013, AutopilotSpotMem: 0.0015,
		ClusterFee: 0.1, E2Core: 0.022, E2Ram: 0.003, E2SpotCore: 0.013, E2SpotRam: 0.00175, BalancedDisk: 0.1, ForwardingRule: 0.025,
	}
}

func text(lines []plan.Line) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l.Label + ": " + l.Text + "\n")
	}
	return b.String()
}

func TestAutopilotEstimate(t *testing.T) {
	c := config.Default("gcp")
	c.Console.Public = false
	out := text(GCP(prices(), c, "fetched now"))
	// minimal: 0.55 vCPU and 1.75 GiB awake = $0.03295/h, $24.05 a month.
	for _, want := range []string{"Cluster fee: $73", "Always: $1.00: disks", "While awake: ~$24.05", "$0.004 per step-hour", "(Spot)", "at the cap of 10", "about 4 hours a weekday"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Light use: disks + 88 h awake + 50 step-hours, then the fee on top.
	low := 1.0 + 0.03295*88 + (0.25*0.013+0.5*0.0015)*50
	if !strings.Contains(out, money(low)+"–"+money(low+73)) {
		t.Errorf("likely range, want %s–%s:\n%s", money(low), money(low+73), out)
	}
}

func TestStandardEstimateKeepsItsNode(t *testing.T) {
	c := config.Default("gcp")
	c.Cluster.Mode = "standard"
	c.Console.Public = false
	c.Size = "scaled" // on-demand steps
	out := text(GCP(prices(), c, "fetched now"))
	node := (2*0.022 + 8*0.003) * hoursPerMonth
	disks := (100 + 50) * 0.1
	if !strings.Contains(out, "Always: "+money(node+disks)+": the platform's node") {
		t.Errorf("want the node and disks always:\n%s", out)
	}
	if !strings.Contains(out, "(on-demand)") || strings.Contains(out, "While asleep") {
		t.Errorf("scaled is on-demand, and standard doesn't save asleep:\n%s", out)
	}
}

func TestMoney(t *testing.T) {
	for v, want := range map[float64]string{0.0042: "$0.004", 12.345: "$12.35", 1234.5: "$1234"} {
		if got := money(v); got != want {
			t.Errorf("%v: %s, want %s", v, got, want)
		}
	}
}

func TestAPublicConsoleCostsItsLoadBalancer(t *testing.T) {
	c := config.Default("gcp")
	c.Console.Public = true
	out := text(GCP(prices(), c, "fetched now"))
	if !strings.Contains(out, "Always: "+money(1.0+0.025*hoursPerMonth)+": disks, the console's load balancer") {
		t.Errorf("want the load balancer always:\n%s", out)
	}
}
