// SPDX-License-Identifier: MIT

package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/rburns629/vertra/cli/internal/run"
)

// AWS's prices: the Price List Query API (only served from us-east-1,
// whatever region is priced) and EC2's Spot price history, both read with
// your AWS sign-in (`aws pricing`, `aws ec2`). Cached a day per region.

// AWSPrices are the prices an estimate needs, in USD.
type AWSPrices struct {
	Region  string
	Fetched time.Time
	// The EKS cluster fee, per hour.
	ClusterFee float64
	// Per instance type: on-demand, Spot (averaged across zones now), and
	// Auto Mode's management fee, per hour.
	Instances map[string]InstancePrice
	// gp3 storage, per GiB-month; a public IPv4 address, per hour.
	GP3      float64
	PublicIP float64
	// SpotUnavailable: Spot prices couldn't be read.
	SpotUnavailable bool
	// The public console: an Application Load Balancer, per hour, and its
	// Route 53 zone, per month.
	LoadBalancer, HostedZone float64
}

// InstancePrice is one instance type's hourly prices.
type InstancePrice struct {
	VCPU, MemGiB        float64
	OnDemand, Spot, Fee float64
}

// awsInstances are the instance types the estimate prices: what Auto Mode
// would likely pick for the platform and for steps (keep in step with
// estimate_aws.go).
var awsInstances = map[string][2]float64{"c6a.large": {2, 4}, "m6a.large": {2, 8}}

func awsArgs(profile string, a ...string) []string {
	if profile != "" {
		a = append(a, "--profile", profile)
	}
	return a
}

// FetchAWS returns the region's prices, from the cache when it's less than a
// day old.
func FetchAWS(ctx context.Context, r *run.Runner, profile, region string) (*AWSPrices, error) {
	cache := cachePath("aws-" + region + ".json")
	if p := readAWSCache(cache); p != nil && time.Since(p.Fetched) < 24*time.Hour {
		return p, nil
	}
	p := &AWSPrices{Region: region, Instances: map[string]InstancePrice{}}
	var err error
	if p.ClusterFee, err = awsPrice(ctx, r, profile, "AmazonEKS", region,
		"Type=TERM_MATCH,Field=operation,Value=CreateOperation",
		"Type=TERM_MATCH,Field=locationType,Value=AWS Region",
		"Type=CONTAINS,Field=usagetype,Value=AmazonEKS-Hours:perCluster"); err != nil {
		return nil, err
	}
	if p.GP3, err = awsPrice(ctx, r, profile, "AmazonEC2", region,
		"Type=TERM_MATCH,Field=productFamily,Value=Storage",
		"Type=TERM_MATCH,Field=volumeApiName,Value=gp3"); err != nil {
		return nil, err
	}
	if p.PublicIP, err = awsPrice(ctx, r, profile, "AmazonVPC", region,
		"Type=CONTAINS,Field=usagetype,Value=PublicIPv4:InUseAddress"); err != nil {
		return nil, err
	}
	if p.LoadBalancer, err = awsPrice(ctx, r, profile, "AWSELB", region,
		"Type=TERM_MATCH,Field=productFamily,Value=Load Balancer-Application",
		"Type=TERM_MATCH,Field=locationType,Value=AWS Region",
		"Type=CONTAINS,Field=usagetype,Value=LoadBalancerUsage"); err != nil {
		return nil, err
	}
	// Route 53 is priced globally: no region filter.
	if p.HostedZone, err = awsGlobalPrice(ctx, r, profile, "AmazonRoute53", "Type=TERM_MATCH,Field=usagetype,Value=HostedZone"); err != nil {
		return nil, err
	}
	for name, size := range awsInstances {
		ip := InstancePrice{VCPU: size[0], MemGiB: size[1]}
		if ip.OnDemand, err = awsPrice(ctx, r, profile, "AmazonEC2", region,
			"Type=TERM_MATCH,Field=instanceType,Value="+name,
			"Type=TERM_MATCH,Field=operatingSystem,Value=Linux",
			"Type=TERM_MATCH,Field=tenancy,Value=Shared",
			"Type=TERM_MATCH,Field=preInstalledSw,Value=NA",
			"Type=TERM_MATCH,Field=capacitystatus,Value=Used"); err != nil {
			return nil, err
		}
		if ip.Fee, err = awsPrice(ctx, r, profile, "AmazonEKS", region,
			"Type=TERM_MATCH,Field=operation,Value=EKSAutoUsage",
			"Type=CONTAINS,Field=usagetype,Value=EKS-Auto:"+name+"-management-hours"); err != nil {
			return nil, err
		}
		// Spot prices can be off limits (an organization's policy may deny
		// reading them): then steps are priced on-demand, and the screen says so.
		if ip.Spot, err = spotPrice(ctx, r, profile, region, name); err != nil {
			ip.Spot = 0
			p.SpotUnavailable = true
		}
		p.Instances[name] = ip
	}
	p.Fetched = time.Now()
	if data, err := json.Marshal(p); err == nil {
		writeRaw(cache, data)
	}
	return p, nil
}

// awsPrice is the one on-demand price matching filters in region.
func awsPrice(ctx context.Context, r *run.Runner, profile, service, region string, filters ...string) (float64, error) {
	args := []string{"pricing", "get-products", "--region", "us-east-1", "--service-code", service, "--output", "json",
		"--max-results", "10", "--filters", "Type=TERM_MATCH,Field=regionCode,Value=" + region}
	args = append(args, filters...)
	out, err := r.Output(ctx, "aws", awsArgs(profile, args...)...)
	if err != nil {
		return 0, fmt.Errorf("reading AWS's prices: %w", err)
	}
	prices, err := onDemandPrices([]byte(out))
	if err != nil {
		return 0, err
	}
	if len(prices) == 0 {
		return 0, fmt.Errorf("AWS's price list has no %s price for %v in %s", service, filters, region)
	}
	// Several entries can match (a free first tier, say): the highest is
	// what's paid past it.
	best := 0.0
	for _, v := range prices {
		best = max(best, v)
	}
	return best, nil
}

// awsGlobalPrice is awsPrice for a service priced the same everywhere.
func awsGlobalPrice(ctx context.Context, r *run.Runner, profile, service string, filters ...string) (float64, error) {
	args := append([]string{"pricing", "get-products", "--region", "us-east-1", "--service-code", service, "--output", "json",
		"--max-results", "10", "--filters"}, filters...)
	out, err := r.Output(ctx, "aws", awsArgs(profile, args...)...)
	if err != nil {
		return 0, fmt.Errorf("reading AWS's prices: %w", err)
	}
	prices, err := onDemandPrices([]byte(out))
	if err != nil || len(prices) == 0 {
		return 0, fmt.Errorf("AWS's price list has no %s price for %v", service, filters)
	}
	best := 0.0
	for _, v := range prices {
		best = max(best, v)
	}
	return best, nil
}

// onDemandPrices reads `aws pricing get-products` output: each product's
// OnDemand price dimensions, in USD.
func onDemandPrices(data []byte) ([]float64, error) {
	var out struct {
		PriceList []string `json:"PriceList"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	var prices []float64
	for _, raw := range out.PriceList {
		var item struct {
			Terms struct {
				OnDemand map[string]struct {
					PriceDimensions map[string]struct {
						PricePerUnit map[string]string `json:"pricePerUnit"`
					} `json:"priceDimensions"`
				} `json:"OnDemand"`
			} `json:"terms"`
		}
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		for _, term := range item.Terms.OnDemand {
			for _, d := range term.PriceDimensions {
				if v, err := strconv.ParseFloat(d.PricePerUnit["USD"], 64); err == nil {
					prices = append(prices, v)
				}
			}
		}
	}
	return prices, nil
}

// spotPrice is an instance type's current Spot price, averaged across the
// region's zones.
func spotPrice(ctx context.Context, r *run.Runner, profile, region, instance string) (float64, error) {
	out, err := r.Output(ctx, "aws", awsArgs(profile, "ec2", "describe-spot-price-history", "--region", region, "--output", "json",
		"--instance-types", instance, "--product-descriptions", "Linux/UNIX",
		"--start-time", time.Now().UTC().Format(time.RFC3339))...)
	if err != nil {
		return 0, fmt.Errorf("reading Spot prices: %w", err)
	}
	return averageSpot([]byte(out))
}

func averageSpot(data []byte) (float64, error) {
	var out struct {
		SpotPriceHistory []struct {
			SpotPrice string `json:"SpotPrice"`
		} `json:"SpotPriceHistory"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return 0, err
	}
	total, n := 0.0, 0
	for _, s := range out.SpotPriceHistory {
		if v, err := strconv.ParseFloat(s.SpotPrice, 64); err == nil {
			total += v
			n++
		}
	}
	if n == 0 {
		return 0, fmt.Errorf("no Spot price")
	}
	return total / float64(n), nil
}

func readAWSCache(path string) *AWSPrices {
	data, err := readRaw(path)
	if err != nil {
		return nil
	}
	var p AWSPrices
	if json.Unmarshal(data, &p) != nil || p.Instances == nil {
		return nil
	}
	return &p
}
