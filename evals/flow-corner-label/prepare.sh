#!/bin/sh
# The project keeps copies of the timing libraries in lib/. /prepare/slow_source names the PDK library that the copy
# with the slow-corner file name holds: the seeded variant puts the typical library there.
# Then the run of record: synthesis and the timing analysis without wires.
set -e
L="$PDK_ROOT/$PDK/libs.ref/sg13g2_stdcell/lib"
mkdir -p lib
cp "$L/sg13g2_stdcell_typ_1p20V_25C.lib" "$L/sg13g2_stdcell_fast_1p32V_m40C.lib" lib/
cp "$L/$(cat /prepare/slow_source)" lib/sg13g2_stdcell_slow_1p08V_125C.lib
chmod 644 lib/*.lib
touch -d '30 days ago' lib/*.lib
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag syn --to OpenROAD.STAPrePNR config.json > flow.out 2>&1
test -s runs/syn/12-openroad-staprepnr/summary.rpt
rm -f flow.out
