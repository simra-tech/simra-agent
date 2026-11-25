#!/bin/sh
# The run of record of the control: the LibreLane flow to the timing analysis with extracted wires.
set -e
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag route --to OpenROAD.STAPostPNR config.json > flow.out 2>&1
test -s runs/route/55-openroad-stapostpnr/summary.rpt
rm -f flow.out
