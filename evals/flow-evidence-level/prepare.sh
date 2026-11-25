#!/bin/sh
# The run of record: the LibreLane flow to global routing (last step: the timing analysis after global routing).
set -e
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag grt --to OpenROAD.STAMidPNR-3 config.json > flow.out 2>&1
test -s runs/grt/43-openroad-stamidpnr-3/state_out.json
rm -f flow.out
