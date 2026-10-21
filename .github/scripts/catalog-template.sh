#!/usr/bin/env bash
# Runs ./vertra in a catalog assembled from catalog-template/, with
# samples installed as teams (each folder under samples/ copied to teams/,
# with its CODEOWNERS line), so samples are checked and can be published as
# the catalog a new install starts with.
#
#   catalog-template.sh validate               every sample, checked
#   catalog-template.sh check                  every product built, tested, scanned
#   SAMPLES=local catalog-template.sh publish  just the local sample, published
#                                              (to VERTRA_REGISTRY)
#   ... publish -- release                     then the catalog's release, in
#                                              the same catalog (commands are
#                                              separated by --)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
template="$root/catalog-template"
samples=${SAMPLES:-$(cd "$template/samples" && ls -d */ | tr -d / | tr '\n' ' ')}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp -R "$template/." "$work"
rm -rf "$work/.vertra"
# This checkout's vertra, not the template's pinned release.
if [ -z "${VERTRA_BIN:-}" ]; then
  VERTRA_BIN=$(bash "$root/.github/scripts/build-vertra.sh")
  export VERTRA_BIN
fi
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
[ $# -gt 0 ] || set -- validate
command=()
for arg in "$@" --; do
  if [ "$arg" = "--" ]; then
    [ ${#command[@]} -eq 0 ] || ./vertra catalog "${command[@]}"
    command=()
  else
    command+=("$arg")
  fi
done
echo "catalog-template: $* passed (samples: $samples)"
