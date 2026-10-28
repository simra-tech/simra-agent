#!/usr/bin/env bash
# Build the Simra Agent environment image from the committed tree (HEAD).
# Usage: container/build.sh [tag]    (engine: SIMRA_ENGINE=docker or podman, default docker)
set -euo pipefail
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
engine=${SIMRA_ENGINE:-docker}
commit=$(git -C "$repo" rev-parse --short HEAD)
tag=${1:-simra-agent-env:$commit}
git -C "$repo" diff --quiet HEAD -- || echo "note: uncommitted changes are not in the image" >&2
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$ctx"
"$engine" build --pull=false -f "$ctx/container/Containerfile" --build-arg COMMIT="$commit" -t "$tag" "$ctx"
echo "$tag"
