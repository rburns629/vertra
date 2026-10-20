// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The gcp module's outputs as `tofu output -json` gives them (values only).
const gcpOutputs = `{
 "cluster": {"name":"vertra","location":"us-central1","issuer":"https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/vertra"},
 "workload_identity_pool": "p.svc.id.goog",
 "task_registry": "us-central1-docker.pkg.dev/p/vertra-products",
 "platform_registry": "",
 "console_service_account": "vertra-console@p.iam.gserviceaccount.com",
 "backup": {"bucket":"p-vertra-backups","service_account":"vertra-backup@p.iam.gserviceaccount.com"},
 "step_placement": {"nodeSelector":{"cloud.google.com/gke-spot":"true"},"tolerations":[]},
 "console_address": {"name":"vertra-console","ip":"34.1.2.3"},
 "catalog": null
}`

func TestCloudFromGCPOutputs(t *testing.T) {
	var outputs map[string]json.RawMessage
	if err := json.Unmarshal([]byte(gcpOutputs), &outputs); err != nil {
		t.Fatal(err)
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		t.Fatal(err)
	}
	if cloud.ClusterLocation != "us-central1" || cloud.BackupBucket != "p-vertra-backups" ||
		cloud.BackupServiceAccount != "vertra-backup@p.iam.gserviceaccount.com" ||
		cloud.StepPlacement["nodeSelector"].(map[string]any)["cloud.google.com/gke-spot"] != "true" {
		t.Errorf("got %+v", cloud)
	}
	if cloud.ConsoleIP != "34.1.2.3" || cloud.CatalogProvider != "" {
		t.Errorf("address and catalog: %+v", cloud)
	}
	// tofu leaves null outputs out: optional ones may be absent.
	delete(outputs, "backup")
	delete(outputs, "catalog")
	delete(outputs, "console_address")
	if cloud, err := cloudFromGCP(outputs); err != nil || cloud.BackupBucket != "" {
		t.Errorf("optional outputs may be absent: %+v, %v", cloud, err)
	}
	delete(outputs, "task_registry")
	if _, err := cloudFromGCP(outputs); err == nil {
		t.Error("a missing required output should fail")
	}
}

func TestCloudFromAWSOutputsWithoutTheOptionalOnes(t *testing.T) {
	var outputs map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{
 "cluster": {"name":"vertra","region":"us-east-2","issuer":"https://oidc.eks.us-east-2.amazonaws.com/id/X"},
 "account": "123456789012",
 "task_registry": "123456789012.dkr.ecr.us-east-2.amazonaws.com/vertra-products",
 "platform_registry": "",
 "backup": {"bucket":"vertra-backups-123456789012-us-east-2","region":"us-east-2"},
 "step_placement": {"nodeSelector":{"vertra.dev/pool":"steps"},"tolerations":[]},
 "spot": true
}`), &outputs); err != nil {
		t.Fatal(err)
	}
	cloud, spot, err := cloudFromAWS(outputs)
	if err != nil {
		t.Fatal(err)
	}
	if !spot || cloud.Provider != "aws" || cloud.BackupRegion != "us-east-2" || cloud.CatalogServiceAccount != "" {
		t.Errorf("got %+v, spot %v", cloud, spot)
	}
}

func TestSameIdentity(t *testing.T) {
	if sameIdentity("", "aws:arn:x") != nil || sameIdentity("aws:arn:x", "aws:arn:x") != nil {
		t.Error("nothing recorded, or the same, is fine")
	}
	err := sameIdentity("aws:arn:aws:iam::1:user/a", "aws:arn:aws:iam::2:user/b")
	if err == nil || !strings.Contains(err.Error(), "set up as arn:aws:iam::1:user/a, but you're signed in as arn:aws:iam::2:user/b") {
		t.Errorf("got %v", err)
	}
}
