#!/usr/bin/env bash
# Check an environment image: tool versions, no eval files in the image, then the repository tests
# inside the container. The tests come from the committed tree (HEAD), mounted read-only.
# Usage: container/check.sh <tag>    (engine: SIMRA_ENGINE=docker or podman, default docker)
set -euo pipefail
tag=${1:?usage: container/check.sh <tag>}
engine=${SIMRA_ENGINE:-docker}
if [ "$engine" = podman ]; then user=0:0; else user=$(id -u):$(id -g); fi
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$src"
chmod -R a+rX "$src"
"$engine" run --rm --network none --pull never -u "$user" -e HOME=/tmp -v "$src:/src:ro" "$tag" bash -c '
set -euo pipefail
echo "node $(node --version)"
echo "pi $(pi --version)"
echo "opencode $(opencode --version)"
v=$(ngspice --version); grep -m1 -o "ngspice-[0-9.]*" <<<"$v"
echo "ihp-sg13g2 $(cat /foss/pdks/ihp-sg13g2/COMMIT 2>/dev/null || echo unknown)"
for d in evals examples test; do
  if [ -e "/opt/simra-agent/$d" ]; then echo "FAILED: /opt/simra-agent/$d is in the image"; exit 1; fi
done
echo "no evals, examples or test in /opt/simra-agent"
cp -r /src /tmp/repo && cp -r /opt/simra-agent/node_modules /tmp/repo/ && cd /tmp/repo && npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok|^Ran |^OK|^FAILED"
'
