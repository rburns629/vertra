// SPDX-License-Identifier: MIT

package tofu

import (
	"regexp"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/modules"
)

// A trimmed `tofu show -json` of a first gcp plan.
const planJSON = `{"resource_changes":[
 {"address":"data.google_project.this","mode":"data","type":"google_project","change":{"actions":["read"]}},
 {"address":"google_container_cluster.this","mode":"managed","type":"google_container_cluster","change":{"actions":["create"]}},
 {"address":"google_container_node_pool.steps[0]","mode":"managed","type":"google_container_node_pool","change":{"actions":["create"]}},
 {"address":"google_container_node_pool.platform[0]","mode":"managed","type":"google_container_node_pool","change":{"actions":["create"]}},
 {"address":"google_project_iam_member.nodes[\"a\"]","mode":"managed","type":"google_project_iam_member","change":{"actions":["create"]}},
 {"address":"google_storage_bucket_iam_member.backup[\"b\"]","mode":"managed","type":"google_storage_bucket_iam_member","change":{"actions":["create"]}},
 {"address":"google_compute_network.this","mode":"managed","type":"google_compute_network","change":{"actions":["no-op"]}},
 {"address":"google_storage_bucket.backups[0]","mode":"managed","type":"google_storage_bucket","change":{"actions":["update"]}},
 {"address":"google_service_account.console","mode":"managed","type":"google_service_account","change":{"actions":["delete","create"]}}
]}`

func TestSummary(t *testing.T) {
	changes, err := parsePlan([]byte(planJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 7 {
		t.Fatalf("data sources and no-ops are left out: %+v", changes)
	}
	s := Summary(changes)
	for action, want := range map[string]string{
		"create":  "cluster, 2 node pools, 2 permissions",
		"update":  "bucket",
		"replace": "service account",
	} {
		if s[action] != want {
			t.Errorf("%s: %q, want %q", action, s[action], want)
		}
	}
}

func TestTheGCPModuleIsEmbedded(t *testing.T) {
	names := map[string]bool{}
	for _, n := range modules.Names("gcp") {
		names[n] = true
	}
	for _, want := range []string{"main.tf", "variables.tf", "outputs.tf", "versions.tf", ".terraform.lock.hcl"} {
		if !names[want] {
			t.Errorf("%s isn't embedded (have %v)", want, names)
		}
	}
}

// Every resource a module makes has a name on the approval screen, never
// its OpenTofu type.
func TestEveryResourceTypeIsNamed(t *testing.T) {
	declared := regexp.MustCompile(`(?m)^resource "([a-z0-9_]+)"`)
	for _, cloud := range []string{"gcp", "aws"} {
		for _, file := range modules.Names(cloud) {
			if !strings.HasSuffix(file, ".tf") {
				continue
			}
			data, err := modules.Read(cloud, file)
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range declared.FindAllStringSubmatch(string(data), -1) {
				if _, ok := names[m[1]]; !ok {
					t.Errorf("%s/%s: %s has no name in names", cloud, file, m[1])
				}
			}
		}
	}
}
