// SPDX-License-Identifier: MIT

// Package pricing estimates what an install costs, from each cloud's live
// prices: fetched when planning (cached a day), never built into the CLI.
// If prices can't be fetched, the approval screen says so instead of
// guessing.
package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Google Cloud's billing catalog: public list prices, read with your gcloud
// sign-in (no API key, no role needed).
const (
	gcpCatalog       = "https://cloudbilling.googleapis.com/v1/services/%s/skus"
	gcpKubernetes    = "CCD8-9BF1-090E"
	gcpCompute       = "6F81-5844-456A"
	gcpNetworking    = "E505-1604-58F8"
	gcpCloudSQL      = "9662-B51E-5089"
	gcpCacheLifetime = 24 * time.Hour
)

// GCPPrices are the list prices an estimate needs, in USD.
type GCPPrices struct {
	Region  string
	Fetched time.Time

	// GKE Autopilot, per vCPU-hour and GiB-hour of Pod requests.
	AutopilotCPU, AutopilotMem         float64
	AutopilotSpotCPU, AutopilotSpotMem float64
	// The cluster management fee, per hour (Autopilot, or a zonal cluster).
	ClusterFee float64
	// Standard mode's E2 nodes, per vCPU-hour and GiB-hour.
	E2Core, E2Ram         float64
	E2SpotCore, E2SpotRam float64
	// Balanced persistent disk, per GiB-month.
	BalancedDisk float64
	// A global load balancer's forwarding rule (the public console), per hour.
	ForwardingRule float64
	// Cloud SQL for PostgreSQL (Enterprise), when a managed database is
	// priced: [0] a zonal instance, [1] a regional (highly available) one.
	// The shared-core small instance, per hour; vCPU and RAM (GiB), per
	// hour; SSD storage, per GiB-month.
	SQLSmall, SQLCPU, SQLRam, SQLStorage [2]float64
}

// HasSQL says the Cloud SQL prices are there.
func (p *GCPPrices) HasSQL() bool { return p.SQLSmall[0] > 0 }

// sku is one catalog entry, as much of it as matching needs.
type sku struct {
	Description    string   `json:"description"`
	ServiceRegions []string `json:"serviceRegions"`
	Category       struct {
		UsageType string `json:"usageType"`
	} `json:"category"`
	PricingInfo []struct {
		PricingExpression struct {
			UsageUnit   string `json:"usageUnit"`
			TieredRates []struct {
				UnitPrice struct {
					Units string `json:"units"`
					Nanos int64  `json:"nanos"`
				} `json:"unitPrice"`
			} `json:"tieredRates"`
		} `json:"pricingExpression"`
	} `json:"pricingInfo"`
}

// price is a SKU's highest tier, in USD per its usage unit.
func (s sku) price() float64 {
	best := 0.0
	for _, info := range s.PricingInfo {
		for _, t := range info.PricingExpression.TieredRates {
			var units float64
			_, _ = fmt.Sscan(t.UnitPrice.Units, &units)
			best = max(best, units+float64(t.UnitPrice.Nanos)/1e9)
		}
	}
	return best
}

// match finds the SKU whose description is exactly desc (in region, or
// global), or one whose description starts with prefix and covers region.
func match(skus []sku, region, desc string) (float64, bool) {
	for _, s := range skus {
		if s.Description == desc && (slices.Contains(s.ServiceRegions, region) || slices.Contains(s.ServiceRegions, "global")) {
			return s.price(), true
		}
	}
	return 0, false
}

// FetchGCP returns the region's list prices: from the cache when it's less
// than a day old, otherwise from the catalog with token (your gcloud
// sign-in's).
// With withSQL, Cloud SQL's too (its catalog is large, so only when a
// managed database is priced).
func FetchGCP(ctx context.Context, token, region string, withSQL bool) (*GCPPrices, error) {
	cache := cachePath("gcp-" + region + ".json")
	if p := readCache(cache); p != nil && time.Since(p.Fetched) < gcpCacheLifetime && (!withSQL || p.HasSQL()) {
		return p, nil
	}
	gke, err := listSKUs(ctx, token, gcpKubernetes)
	if err != nil {
		return nil, err
	}
	compute, err := listSKUs(ctx, token, gcpCompute)
	if err != nil {
		return nil, err
	}
	networking, err := listSKUs(ctx, token, gcpNetworking)
	if err != nil {
		return nil, err
	}
	p, err := PricesFromGCP(gke, append(compute, networking...), region)
	if err != nil {
		return nil, err
	}
	if withSQL {
		sql, err := listSKUs(ctx, token, gcpCloudSQL)
		if err != nil {
			return nil, err
		}
		if err := p.addSQL(sql); err != nil {
			return nil, err
		}
	}
	p.Fetched = time.Now()
	writeCache(cache, p)
	return p, nil
}

// PricesFromGCP picks the prices out of Kubernetes Engine's SKUs and the
// rest (Compute Engine's and Networking's).
func PricesFromGCP(gke, compute []sku, region string) (*GCPPrices, error) {
	p := &GCPPrices{Region: region}
	var missing []string
	need := func(skus []sku, desc string, scale float64, into *float64) {
		v, ok := match(skus, region, desc)
		if !ok {
			missing = append(missing, desc)
			return
		}
		*into = v * scale
	}
	// Autopilot prices CPU per mCPU-hour: ×1000 for a vCPU.
	need(gke, fmt.Sprintf("Autopilot Pod mCPU Requests (%s)", region), 1000, &p.AutopilotCPU)
	need(gke, fmt.Sprintf("Autopilot Pod Memory Requests (%s)", region), 1, &p.AutopilotMem)
	need(gke, fmt.Sprintf("Autopilot Spot Pod mCPU Requests (%s)", region), 1000, &p.AutopilotSpotCPU)
	need(gke, fmt.Sprintf("Autopilot Spot Pod Memory Requests (%s)", region), 1, &p.AutopilotSpotMem)
	need(gke, "Autopilot Kubernetes Clusters", 1, &p.ClusterFee)
	// E2's are named by region group ("running in Americas"), listing the
	// regions they cover.
	need(compute, regionGroup(compute, region, "E2 Instance Core running in "), 1, &p.E2Core)
	need(compute, regionGroup(compute, region, "E2 Instance Ram running in "), 1, &p.E2Ram)
	need(compute, regionGroup(compute, region, "Spot Preemptible E2 Instance Core running in "), 1, &p.E2SpotCore)
	need(compute, regionGroup(compute, region, "Spot Preemptible E2 Instance Ram running in "), 1, &p.E2SpotRam)
	need(compute, "Balanced PD Capacity", 1, &p.BalancedDisk)
	need(compute, "Cloud Load Balancer Forwarding Rule Minimum Global", 1, &p.ForwardingRule)
	if len(missing) > 0 {
		return nil, fmt.Errorf("the price catalog has no %q for %s", missing, region)
	}
	return p, nil
}

// addSQL picks Cloud SQL for PostgreSQL's prices out of its SKUs, named by
// region group ("Cloud SQL for PostgreSQL: Zonal - vCPU in Americas").
func (p *GCPPrices) addSQL(skus []sku) error {
	var missing []string
	for i, kind := range []string{"Zonal", "Regional"} {
		for _, want := range []struct {
			what string
			into *float64
		}{{"Small instance", &p.SQLSmall[i]}, {"vCPU", &p.SQLCPU[i]}, {"RAM", &p.SQLRam[i]}, {"Standard storage", &p.SQLStorage[i]}} {
			desc := regionGroup(skus, p.Region, fmt.Sprintf("Cloud SQL for PostgreSQL: %s - %s in ", kind, want.what))
			v, ok := match(skus, p.Region, desc)
			if !ok {
				missing = append(missing, desc)
				continue
			}
			*want.into = v
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("the price catalog has no %q for %s", missing, p.Region)
	}
	return nil
}

// regionGroup is the full description of the SKU starting with prefix that
// covers region (or prefix itself, which then won't match).
func regionGroup(skus []sku, region, prefix string) string {
	for _, s := range skus {
		if len(s.Description) > len(prefix) && s.Description[:len(prefix)] == prefix && slices.Contains(s.ServiceRegions, region) {
			return s.Description
		}
	}
	return prefix
}

func listSKUs(ctx context.Context, token, service string) ([]sku, error) {
	var all []sku
	page := ""
	for {
		u := fmt.Sprintf(gcpCatalog, service) + "?pageSize=5000"
		if page != "" {
			u += "&pageToken=" + url.QueryEscape(page)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: time.Minute}).Do(req)
		if err != nil {
			return nil, fmt.Errorf("reading Google's prices: %w", err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("reading Google's prices: %s", resp.Status)
		}
		var out struct {
			Skus          []sku  `json:"skus"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, err
		}
		all = append(all, out.Skus...)
		if out.NextPageToken == "" {
			return all, nil
		}
		page = out.NextPageToken
	}
}

func cachePath(name string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".vertra", "cache", "prices", name)
}

func readCache(path string) *GCPPrices {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var p GCPPrices
	if json.Unmarshal(data, &p) != nil {
		return nil
	}
	return &p
}

func writeCache(path string, p *GCPPrices) {
	if data, err := json.Marshal(p); err == nil {
		writeRaw(path, data)
	}
}

func writeRaw(path string, data []byte) {
	if path != "" && os.MkdirAll(filepath.Dir(path), 0o755) == nil {
		_ = os.WriteFile(path, data, 0o644)
	}
}

func readRaw(path string) ([]byte, error) {
	return os.ReadFile(path)
}

// ErrNoPrices is what the screen reports when prices can't be had.
var ErrNoPrices = errors.New("prices unavailable")
