// SPDX-License-Identifier: MIT

package pricing

import (
	"fmt"

	"github.com/rburns629/acyclix/cli/internal/config"
	"github.com/rburns629/acyclix/cli/internal/plan"
)

// awsPlatformInstance is the instance Auto Mode would likely give the
// platform's Pods, per size: the cheapest that fits them (keep in step with
// aws.go's awsInstances). Auto Mode picks the real one.
var awsPlatformInstance = map[string]string{
	"minimal": "c6a.large", "resilient": "c6a.large", "auto": "c6a.large", "scaled": "m6a.large",
}

// awsNodeDiskGiB is Auto Mode's default ephemeral storage per node (gp3).
const awsNodeDiskGiB = 80

// AWS is the cost section of the approval screen for an aws install.
func AWS(p *AWSPrices, c *config.Config, fetched string) []plan.Line {
	f := plan.Floors[c.Size]
	platform := p.Instances[awsPlatformInstance[c.Size]]
	nodeHour := func(i InstancePrice, price float64) float64 {
		return price + i.Fee + p.PublicIP + awsNodeDiskGiB*p.GP3/hoursPerMonth
	}
	awake := nodeHour(platform, platform.OnDemand)

	// A step's share of a steps node: by whichever of CPU or memory it
	// fills more.
	steps := p.Instances["c6a.large"]
	price, capacity := steps.Spot, "Spot"
	switch {
	case !f.Spot:
		price, capacity = steps.OnDemand, "on-demand"
	case p.SpotUnavailable || steps.Spot == 0:
		price, capacity = steps.OnDemand, "Spot, priced on-demand: Spot prices couldn't be read here"
	}
	share := max(f.StepCPU/steps.VCPU, f.StepMemGiB/steps.MemGiB)
	stepHour := share * nodeHour(steps, price)

	fee := p.ClusterFee * hoursPerMonth
	always := fee + f.VolumeGiB*p.GP3
	if c.Console.Public {
		always += p.LoadBalancer*hoursPerMonth + p.HostedZone
	}
	if c.StepHeadroom > 0 {
		always += float64(c.StepHeadroom) * stepHour * hoursPerMonth
	}
	if c.Cluster.Mode == "standard" {
		return awsStandard(p, c, f, fetched, fee, always)
	}
	awakeHours := float64(hoursPerMonth)
	if c.ScaleDown.Enabled {
		awakeHours = lightAwakeHours
	}
	likely := always + awake*awakeHours + stepHour*lightStepHours

	return []plan.Line{
		{Label: "Estimated cost", Text: fmt.Sprintf("a month, list prices in USD, %s, %s", p.Region, fetched)},
		{Label: "  Always", Text: fmt.Sprintf("%s: the EKS cluster fee (%s; EKS has no free tier), the database's volume%s%s",
			money(always), money(fee), awsConsoleNote(c), headroomNote(c))},
		{Label: "  While awake", Text: fmt.Sprintf("%s a month if never asleep: about one %s (Auto Mode picks the instance), with its Auto Mode fee, public address and disk",
			money(awake*hoursPerMonth), awsPlatformInstance[c.Size])},
		{Label: "  While asleep", Text: "nothing more: Auto Mode removes nodes nothing runs on"},
		{Label: "  Steps", Text: fmt.Sprintf("%s per step-hour at the default size (%s); %s a month at the cap of %d if always busy",
			money(stepHour), capacity, money(stepHour*float64(f.StepCap)*hoursPerMonth), f.StepCap)},
		{Label: "  Likely", Text: fmt.Sprintf("%s for light use (%s, %d step-hours)", money(likely), awakeWords(c), lightStepHours)},
		{Label: "  Not included", Text: "discounts, credits, taxes, data transfer, backups and images in storage (cents a GB), your products' own AWS usage"},
	}
}

// awsStandardDiskGiB is each node group node's disk (the module's disk_size).
const awsStandardDiskGiB = 20

// awsStandard is standard mode's estimate: node groups, no Auto Mode fee,
// and the platform's node runs whether the platform sleeps or not.
func awsStandard(p *AWSPrices, c *config.Config, f plan.Floor, fetched string, fee, always float64) []plan.Line {
	nodeHour := func(price float64) float64 {
		return price + p.PublicIP + awsStandardDiskGiB*p.GP3/hoursPerMonth
	}
	platform := p.Instances[awsPlatformInstance[c.Size]]
	always += nodeHour(platform.OnDemand) * hoursPerMonth
	steps := p.Instances["c6a.large"]
	price, capacity := steps.Spot, "Spot"
	switch {
	case !f.Spot:
		price, capacity = steps.OnDemand, "on-demand"
	case p.SpotUnavailable || steps.Spot == 0:
		price, capacity = steps.OnDemand, "Spot, priced on-demand: Spot prices couldn't be read here"
	}
	stepHour := max(f.StepCPU/steps.VCPU, f.StepMemGiB/steps.MemGiB) * nodeHour(price)
	if c.StepHeadroom > 0 {
		// The steps group keeps a whole node for it.
		always += nodeHour(price) * hoursPerMonth
	}
	likely := always + stepHour*lightStepHours
	return []plan.Line{
		{Label: "Estimated cost", Text: fmt.Sprintf("a month, list prices in USD, %s, %s", p.Region, fetched)},
		{Label: "  Always", Text: fmt.Sprintf("%s: the EKS cluster fee (%s; EKS has no free tier), the platform's %s node and the volumes, awake or asleep",
			money(always), money(fee), awsPlatformInstance[c.Size])},
		{Label: "  Steps", Text: fmt.Sprintf("%s per step-hour at the default size (%s); %s a month at the cap of %d if always busy",
			money(stepHour), capacity, money(stepHour*float64(f.StepCap)*hoursPerMonth), f.StepCap)},
		{Label: "  Likely", Text: fmt.Sprintf("%s for light use (%d step-hours); sleeping saves nothing here, since the platform's node stays. While images are being scanned, a second platform node runs for the scanner (about %s an hour), gone about 20 minutes after the last scan",
			money(likely), lightStepHours, money(nodeHour(platform.OnDemand)))},
		{Label: "  Not included", Text: "discounts, credits, taxes, data transfer, backups and images in storage (cents a GB), your products' own AWS usage"},
	}
}

func awsConsoleNote(c *config.Config) string {
	if c.Console.Public {
		return ", the console's load balancer and DNS zone (plus a little per use)"
	}
	return ""
}
