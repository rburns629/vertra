#!/usr/bin/env bash
# Copies the platform's docs into console/docs/reference/ (its SOURCES file
# lists them), so they ship in the console's image: `make console-docs`.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/console/docs/reference"
grep -v "^\s*#" "$dir/SOURCES" | while read -r id _kind path; do
  [ -n "$id" ] || continue
  cp "$root/$path" "$dir/$id.md"
done
echo "console/docs/reference: copied $(grep -cv '^\s*#' "$dir/SOURCES") docs."
