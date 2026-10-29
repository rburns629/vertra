// SPDX-License-Identifier: MIT

package pricing

import (
	"math"
	"os"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/config"
)

// testdata/aws-eks-auto-fee.json: a real `aws pricing get-products`
// response (October 2026) for Auto Mode's fee on a c6a.large in us-east-1.
func TestOnDemandPricesFromThePriceList(t *testing.T) {
	data, err := os.ReadFile("testdata/aws-eks-auto-fee.json")
	if err != nil {
		t.Fatal(err)
	}
	prices, err := onDemandPrices(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(prices) != 1 || prices[0] <= 0 || prices[0] > 0.05 {
		t.Errorf("an Auto Mode fee is cents an hour: %v", prices)
	}
}

func TestAverageSpot(t *testing.T) {
	v, err := averageSpot([]byte(`{"SpotPriceHistory":[{"SpotPrice":"0.030000"},{"SpotPrice":"0.040000"}]}`))
	if err != nil || v < 0.0349 || v > 0.0351 {
		t.Errorf("got %v, %v", v, err)
	}
	if _, err := averageSpot([]byte(`{"SpotPriceHistory":[]}`)); err == nil {
		t.Error("no prices should fail")
	}
}

func awsPrices() *AWSPrices {
	return &AWSPrices{
		Region: "us-east-1", ClusterFee: 0.1, GP3: 0.08, PublicIP: 0.005, LoadBalancer: 0.0225, HostedZone: 0.5,
		Instances: map[string]InstancePrice{
			"c6a.large": {VCPU: 2, MemGiB: 4, OnDemand: 0.0765, Spot: 0.03, Fee: 0.0092},
			"m6a.large": {VCPU: 2, MemGiB: 8, OnDemand: 0.0864, Spot: 0.035, Fee: 0.0104},
		},
	}
}

func TestAWSEstimate(t *testing.T) {
	c := config.Default("aws")
	out := text(AWS(awsPrices(), c, "fetched now"))
	node := 0.0765 + 0.0092 + 0.005 + 80*0.08/hoursPerMonth
	for _, want := range []string{
		"Always: " + money(73+10*0.08) + ": the EKS cluster fee ($73.00; EKS has no free tier), the database's volume\n",
		"While awake: " + money(node*hoursPerMonth) + " a month if never asleep: about one c6a.large",
		"(Spot)", "at the cap of 10",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestAWSEstimateWithoutSpotPrices(t *testing.T) {
	p := awsPrices()
	p.SpotUnavailable = true
	out := text(AWS(p, config.Default("aws"), "fetched now"))
	if !strings.Contains(out, "priced on-demand: Spot prices couldn't be read here") {
		t.Errorf("should say steps are priced on-demand:\n%s", out)
	}
}

func TestAWSStandardEstimateKeepsThePlatformNode(t *testing.T) {
	c := config.Default("aws")
	c.Cluster.Mode = "standard"
	out := text(AWS(awsPrices(), c, "fetched now"))
	node := (0.0765 + 0.005 + 20*0.08/hoursPerMonth) * hoursPerMonth
	if !strings.Contains(out, "Always: "+money(73+10*0.08+node)+": the EKS cluster fee") || strings.Contains(out, "While asleep") {
		t.Errorf("want the platform node always, no asleep saving:\n%s", out)
	}
}

func TestAWSPublicConsoleCostsItsLoadBalancerAndZone(t *testing.T) {
	c := config.Default("aws")
	c.Console.Public = true
	out := text(AWS(awsPrices(), c, "fetched now"))
	if !strings.Contains(out, "Always: "+money(73+10*0.08+0.0225*hoursPerMonth+0.5)+": the EKS cluster fee") ||
		!strings.Contains(out, "the console's load balancer and DNS zone") {
		t.Errorf("want the load balancer and zone always:\n%s", out)
	}
}

// RDS's real us-east-2 prices (October 2026): db.t4g.small, Single-AZ and
// Multi-AZ, and gp3 storage.
func TestAManagedDatabaseOnAWSIsPricedAndItsVolumeIsNot(t *testing.T) {
	p := awsPrices()
	p.RDS = map[string][2]float64{"db.t4g.small": {0.032, 0.065}}
	p.RDSStorage = [2]float64{0.115, 0.23}
	c := config.Default("aws")
	c.Database.Type = "managed"
	if got := RDSMonth(p, c); math.Abs(got-(0.032*730+20*0.115)) > 0.001 {
		t.Errorf("minimal, Single-AZ: %v", got)
	}
	c.Database.HighAvailability = true
	if got := RDSMonth(p, c); math.Abs(got-(0.065*730+20*0.23)) > 0.001 {
		t.Errorf("minimal, Multi-AZ: %v", got)
	}
	c.Database.HighAvailability = false
	out := text(AWS(p, c, "fetched now"))
	if !strings.Contains(out, "  Database: $25.66: RDS (db.t4g.small)") || !strings.Contains(out, "the database (RDS)") {
		t.Errorf("the database's line, and no volume beside it:\n%s", out)
	}
	c.Cluster.Mode = "standard"
	if out := text(AWS(p, c, "fetched now")); !strings.Contains(out, "  Database: $25.66") {
		t.Errorf("standard mode too:\n%s", out)
	}
}
