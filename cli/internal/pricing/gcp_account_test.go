// SPDX-License-Identifier: MIT

package pricing

import (
	"math"
	"testing"
)

func TestAccountRatioFromThePricingAPI(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		want float64
	}{
		// What the API answered for an Autopilot SKU (October 2026).
		"no discount": {`{"currencyCode":"USD","priceReason":{"type":"default-price"},"rate":{"tiers":[{"startAmount":{"value":"0"},
			"listPrice":{"currencyCode":"USD","nanos":44500000},"contractPrice":{"currencyCode":"USD","nanos":44500000}}],
			"unitInfo":{"unit":"h","unitQuantity":{"value":"1000"}}}}`, 1},
		"a fifth off, units and nanos": {`{"rate":{"tiers":[{"listPrice":{"units":"2","nanos":500000000},
			"contractPrice":{"units":"2"}}]}}`, 0.8},
		"a free first tier": {`{"rate":{"tiers":[{"listPrice":{},"contractPrice":{}},
			{"listPrice":{"nanos":100000000},"contractPrice":{"nanos":90000000}}]}}`, 0.9},
		"free": {`{"rate":{"tiers":[{"listPrice":{},"contractPrice":{}}]}}`, 1},
	} {
		got, err := ratioOf([]byte(tc.body))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

func TestAccountPricesScaleEachPriceByItsSKU(t *testing.T) {
	p := &GCPPrices{AutopilotCPU: 0.0445, E2Core: 0.02, SQLCPU: [2]float64{0.04, 0.08},
		SKUs: map[string]string{"AutopilotCPU": "A", "E2Core": "B", "SQLCPURegional": "C"}}
	got := p.atRatios(map[string]float64{"A": 0.5, "B": 1, "C": 0.75})
	if got.AutopilotCPU != 0.02225 || got.E2Core != 0.02 || got.SQLCPU != [2]float64{0.04, 0.06} {
		t.Errorf("scaled to %v, %v, %v", got.AutopilotCPU, got.E2Core, got.SQLCPU)
	}
	if p.AutopilotCPU != 0.0445 {
		t.Error("the list prices changed too")
	}
	if got.Basis != "your billing account's prices" {
		t.Errorf("basis %q", got.Basis)
	}
}
