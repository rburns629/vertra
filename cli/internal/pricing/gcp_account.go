// SPDX-License-Identifier: MIT

package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// gcpAccountPrice is Cloud Billing's Pricing API: a SKU's price for one
// billing account, its discounts applied. Reading it needs
// billing.billingAccountPrice.get on the account (Billing Account Viewer).
const gcpAccountPrice = "https://cloudbilling.googleapis.com/v1beta/billingAccounts/%s/skus/%s/price?currencyCode=USD"

// accountRatios is what a billing account pays for each SKU, as a share of
// its list price, cached a day.
type accountRatios struct {
	Fetched time.Time
	Ratios  map[string]float64 // by SKU id
}

// ForAccount returns p at your billing account's prices: each list price
// scaled by what the account pays for its SKU over the SKU's list price
// (so units never need converting). Without the right to read them it
// returns an error, and the caller keeps the list prices.
func ForAccount(ctx context.Context, token, account string, p *GCPPrices) (*GCPPrices, error) {
	cache := cachePath("gcp-account-" + account + ".json")
	var ratios accountRatios
	if data, err := readRaw(cache); err != nil || json.Unmarshal(data, &ratios) != nil || time.Since(ratios.Fetched) >= gcpCacheLifetime {
		ratios = accountRatios{Fetched: time.Now()}
	}
	if ratios.Ratios == nil {
		ratios.Ratios = map[string]float64{}
	}
	var missing []string // SKUs the cache hasn't got
	for _, id := range p.SKUs {
		if _, ok := ratios.Ratios[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		fetched, err := fetchRatios(ctx, token, account, missing)
		if err != nil {
			return nil, err
		}
		for id, r := range fetched {
			ratios.Ratios[id] = r
		}
		if data, err := json.Marshal(ratios); err == nil {
			writeRaw(cache, data)
		}
	}
	return p.atRatios(ratios.Ratios), nil
}

// atRatios is p with each price scaled by its SKU's ratio.
func (p *GCPPrices) atRatios(ratios map[string]float64) *GCPPrices {
	scaled := *p
	into := scaled.prices()
	for name, id := range p.SKUs {
		*into[name] *= ratios[id]
	}
	scaled.Basis = "your billing account's prices"
	return &scaled
}

// fetchRatios asks for each SKU's account price, a few at a time.
func fetchRatios(ctx context.Context, token, account string, ids []string) (map[string]float64, error) {
	ratios := make([]float64, len(ids))
	calls := make([]priceCall, len(ids))
	for i, id := range ids {
		calls[i] = priceCall{into: &ratios[i], get: func() (float64, error) { return accountRatio(ctx, token, account, id) }}
	}
	if _, err := getAll(calls, 8); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for i, id := range ids {
		out[id] = ratios[i]
	}
	return out, nil
}

func accountRatio(ctx context.Context, token, account, id string) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(gcpAccountPrice, account, id), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return 0, fmt.Errorf("reading your account's prices: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return 0, fmt.Errorf("your account's prices need Billing Account Viewer on its billing account")
	default:
		return 0, fmt.Errorf("reading your account's prices: %s", resp.Status)
	}
	return ratioOf(body)
}

// ratioOf is an account price's share of its list price, from the Pricing
// API's answer: the highest tier of each, as the catalog's prices are read.
func ratioOf(body []byte) (float64, error) {
	var raw struct {
		Rate struct {
			Tiers []struct {
				ListPrice     apiMoney `json:"listPrice"`
				ContractPrice apiMoney `json:"contractPrice"`
			} `json:"tiers"`
		} `json:"rate"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return 0, err
	}
	list, contract := 0.0, 0.0
	for _, t := range raw.Rate.Tiers {
		list = max(list, t.ListPrice.value())
		contract = max(contract, t.ContractPrice.value())
	}
	if list == 0 {
		return 1, nil // free at list price: nothing to scale
	}
	return contract / list, nil
}

// apiMoney is the API's Money: whole units as a string, and nanos.
type apiMoney struct {
	Units string `json:"units"`
	Nanos int64  `json:"nanos"`
}

func (m apiMoney) value() float64 {
	units, _ := strconv.ParseFloat(m.Units, 64)
	return units + float64(m.Nanos)/1e9
}
