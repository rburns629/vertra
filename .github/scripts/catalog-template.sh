#!/usr/bin/env bash
# Runs ./catalogctl in a catalog assembled from catalog-template/, with
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
rm -rf "$work/.catalogctl"
# This checkout's catalogctl, not the template's pinned release.
if [ -z "${VERTRA_CATALOGCTL:-}" ]; then
  VERTRA_CATALOGCTL=$(bash "$root/.github/scripts/build-catalogctl.sh")
  export VERTRA_CATALOGCTL
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
    [ ${#command[@]} -eq 0 ] || ./catalogctl "${command[@]}"
    command=()
  else
    command+=("$arg")
  fi
done
echo "catalog-template: $* passed (samples: $samples)"
