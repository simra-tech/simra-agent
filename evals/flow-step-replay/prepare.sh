#!/bin/sh
# The run of record: the LibreLane flow with the default settings. It stops at the timing repair after the clock tree
# synthesis (the maximum buffer count of the hold repair).
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag r1 config.json > flow.out 2>&1
set -e
grep -q "RSZ-0060" runs/r1/37-openroad-resizertimingpostcts/openroad-resizertimingpostcts.log
test ! -e runs/r1/37-openroad-resizertimingpostcts/state_out.json
rm -f flow.out
