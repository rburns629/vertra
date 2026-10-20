#!/usr/bin/env bash
# Builds catalogctl from this checkout for this machine, in the pinned Go
# image the CLI's CI uses (no Go needed here), and prints the binary's path:
#
#   export ACYCLIX_CATALOGCTL=$(bash .github/scripts/build-catalogctl.sh)
#
# A catalog's ./catalogctl runs ACYCLIX_CATALOGCTL instead of its pinned
# release.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
image=$(sed -n 's/^GO_IMAGE ?= *//p' "$root/Makefile")
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "build-catalogctl.sh: no build for $(uname -m)" >&2; exit 1 ;;
esac
name="catalogctl-$os-$arch"
docker run --rm -v "$root":/repo -v acyclix-gomod:/go/pkg/mod -w /repo/cli \
  -e CGO_ENABLED=0 -e GOOS="$os" -e GOARCH="$arch" "$image" \
  go build -trimpath -o "bin/$name" ./cmd/catalogctl >&2
echo "$root/cli/bin/$name"
