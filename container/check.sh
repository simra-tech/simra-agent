#!/usr/bin/env bash
# Check an environment image: tool versions, then the repository tests inside the container.
# Usage: container/check.sh <tag>    (engine: SIMRA_ENGINE=docker or podman, default docker)
set -euo pipefail
tag=${1:?usage: container/check.sh <tag>}
engine=${SIMRA_ENGINE:-docker}
if [ "$engine" = podman ]; then user=0:0; else user=$(id -u):$(id -g); fi
"$engine" run --rm --network none --pull never -u "$user" -e HOME=/tmp "$tag" bash -c '
set -euo pipefail
echo "node $(node --version)"
echo "pi $(pi --version)"
echo "opencode $(opencode --version)"
v=$(ngspice --version); grep -m1 -o "ngspice-[0-9.]*" <<<"$v"
echo "ihp-sg13g2 $(cat /foss/pdks/ihp-sg13g2/COMMIT 2>/dev/null || echo unknown)"
cp -r /opt/simra-agent /tmp/repo && cd /tmp/repo && npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok|^Ran |^OK|^FAILED"
'
