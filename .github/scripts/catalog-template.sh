#!/usr/bin/env bash
# Runs ./catalogctl in a catalog assembled from catalog-template/, with
# samples installed as teams (each folder under samples/ copied to teams/,
# with its CODEOWNERS line), so samples are checked and can be published as
# the catalog a new install starts with.
#
#   catalog-template.sh validate               every sample, checked
#   catalog-template.sh check                  every product built, tested, scanned
#   SAMPLES=local catalog-template.sh publish  just the local sample, published
#                                              (to ACYCLIX_REGISTRY/CONSOLE_URL)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
template="$root/catalog-template"
samples=${SAMPLES:-$(cd "$template/samples" && ls -d */ | tr -d / | tr '\n' ' ')}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -R "$template/." "$work"
rm -rf "$work/.venv"
for team in $samples; do
  [ -d "$template/samples/$team" ] || { echo "No sample named $team in catalog-template/samples/." >&2; exit 1; }
  cp -R "$template/samples/$team" "$work/teams/$team"
  # Under the teams section's example line, before the admins' block.
  awk -v line="/teams/$team/ @your-org/catalog-admins" \
    '{ print } /^#   \/teams\/<team>\// { print line }' \
    "$work/.github/CODEOWNERS" > "$work/CODEOWNERS.new"
  mv "$work/CODEOWNERS.new" "$work/.github/CODEOWNERS"
done

cd "$work"
./catalogctl "${@:-validate}"
echo "catalog-template: ${*:-validate} passed (samples: $samples)"
