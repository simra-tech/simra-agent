#!/bin/sh
# The run of record: the LibreLane flow to the timing analysis after the hold repair.
set -e
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag r1 --to OpenROAD.STAMidPNR-2 config.json > flow.out 2>&1
test -s runs/r1/38-openroad-stamidpnr-2/state_out.json
grep -q "RSZ-0064" runs/r1/37-openroad-resizertimingpostcts/openroad-resizertimingpostcts.log
rm -f flow.out
