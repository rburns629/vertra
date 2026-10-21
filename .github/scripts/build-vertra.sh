#!/usr/bin/env bash
# Builds vertra from this checkout for this machine, in the pinned Go image
# the CLI's CI uses (no Go needed here), and prints the binary's path:
#
#   export VERTRA_BIN=$(bash .github/scripts/build-vertra.sh)
#
# A catalog's ./vertra runs VERTRA_BIN instead of its pinned release.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
image=$(sed -n 's/^GO_IMAGE ?= *//p' "$root/Makefile")
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "build-vertra.sh: no build for $(uname -m)" >&2; exit 1 ;;
esac
name="vertra-$os-$arch"
docker run --rm -v "$root":/repo -v vertra-gomod:/go/pkg/mod -w /repo/cli \
  -e CGO_ENABLED=0 -e GOOS="$os" -e GOARCH="$arch" "$image" \
  go build -trimpath -o "bin/$name" ./cmd/vertra >&2
echo "$root/cli/bin/$name"
