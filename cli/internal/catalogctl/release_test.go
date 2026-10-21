// SPDX-License-Identifier: MIT

package catalogctl

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	catalogv1 "github.com/rburns629/vertra/cli/internal/gen/vertra/catalog/v1"
)

// A release pushed as an artifact reads back as itself, under its commit's
// tag and latest, with the media types a console looks for.
func TestAReleaseIsPushedAsAnArtifactAConsoleCanRead(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products"}
	release := &catalogv1.Release{Commit: "abc123", Repository: "github.com/my-org/vertra-catalog",
		Teams:    []*catalogv1.Team{{Name: "platform"}},
		Products: []*catalogv1.ProductAction{{Name: "platform-hello-greet", Image: host + "/catalog-products/platform/hello@sha256:" + strings.Repeat("a", 64), Action: "greet", Team: "platform"}}}

	reference, err := pushRelease(context.Background(), s, release, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(reference, host+"/catalog-products/catalog-release@sha256:") {
		t.Errorf("reference = %s", reference)
	}
	for _, tag := range []string{"abc123", "latest"} {
		ref, _ := name.ParseReference(s.ReleaseRepository()+":"+tag, name.Insecure)
		artifact, err := remote.Image(ref)
		if err != nil {
			t.Fatal(err)
		}
		manifest, _ := artifact.Manifest()
		if manifest.Config.MediaType != ReleaseConfigMediaType || len(manifest.Layers) != 1 ||
			manifest.Layers[0].MediaType != ReleaseMediaType || manifest.Annotations["org.opencontainers.image.revision"] != "abc123" {
			t.Fatalf("%s: manifest = %+v", tag, manifest)
		}
		layers, _ := artifact.Layers()
		blob, _ := layers[0].Uncompressed()
		data, _ := io.ReadAll(blob)
		var got catalogv1.Release
		if err := protojson.Unmarshal(data, &got); err != nil || !proto.Equal(&got, release) {
			t.Errorf("%s: read back %v (%v)", tag, &got, err)
		}
	}
}

// product is a valid product of team a: its product.yaml, Dockerfile and a test.
func product(name, shareWith string) map[string]string {
	dir := "teams/a/products/" + name + "/"
	return map[string]string{
		dir + "product.yaml":                    productFile(name, "a", shareWith),
		dir + "Dockerfile":                      "FROM scratch\n",
		dir + "tests/run/says-hi/request.json":  `{"inputs": {"text": "hi"}}`,
		dir + "tests/run/says-hi/expected.json": `{"status": "succeeded"}`,
	}
}

// A release names every product action at the digest its :latest has now,
// with its schemas read from product.yaml, and refuses to leave out a
// product that was never published.
func TestBuildReleasePinsEachPublishedProduct(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products"}
	image, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := name.NewTag(s.Registry + "/a/mine:latest")
	if err := remote.Write(ref, image); err != nil {
		t.Fatal(err)
	}
	digest, _ := image.Digest()

	files := product("mine", "[b]")
	files["teams/a/products/mine/product.yaml"] = strings.Replace(files["teams/a/products/mine/product.yaml"],
		"owner: x\n", "owner: x\ntokenAudiences: [sts.amazonaws.com]\n", 1)
	files["teams/a/dags/hello.yaml"] = `apiVersion: vertra.dev/v2
kind: Template
name: hello
displayName: Hello
description: One step.
shareWith: ["*"]
parameters:
  type: object
  required: [text]
  properties:
    text: {type: string}
steps:
  - id: one
    action: mine.run
    timeoutSeconds: 60
    inputs:
      text: {$param: text}
`
	c := catalogWith(t, files)
	var out strings.Builder
	c.Stdout, c.Stderr = &out, &out
	release, err := c.BuildRelease(context.Background(), s, "c1", "github.com/my-org/vertra-catalog")
	if err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if len(release.GetTeams()) != 1 || release.GetTeams()[0].GetName() != "a" || len(release.GetProducts()) != 1 {
		t.Fatalf("release = %v", release)
	}
	got := release.GetProducts()[0]
	if got.GetName() != "a-mine-run" || got.GetImage() != s.Registry+"/a/mine@"+digest.String() || got.GetTeam() != "a" ||
		got.GetAction() != "run" || len(got.GetShareWith()) != 1 || got.GetInputSchema().GetFields()["required"] == nil ||
		strings.Join(got.GetTokenAudiences(), ",") != "sts.amazonaws.com" {
		t.Errorf("action = %v", got)
	}
	if len(release.GetTemplates()) != 1 {
		t.Fatalf("templates = %v", release.GetTemplates())
	}
	tpl := release.GetTemplates()[0]
	step := tpl.GetSteps()[0]
	if tpl.GetTeam() != "a" || tpl.GetName() != "hello" || strings.Join(tpl.GetShareWith(), ",") != "*" ||
		tpl.GetParameters().GetFields()["required"] == nil || step.GetAction() != "a/mine.run" || step.GetTimeoutSeconds() != 60 ||
		step.GetInputs().GetFields()["text"].GetStructValue().GetFields()["$param"].GetStringValue() != "text" {
		t.Errorf("template = %v", tpl)
	}

	files = product("mine", "[]")
	for path, content := range product("never", "[]") {
		files[path] = content
	}
	c = catalogWith(t, files)
	if _, err := c.BuildRelease(context.Background(), s, "c1", ""); err == nil || !strings.Contains(err.Error(), "teams/a/products/never: no published image") {
		t.Errorf("an unpublished product: %v", err)
	}
}
