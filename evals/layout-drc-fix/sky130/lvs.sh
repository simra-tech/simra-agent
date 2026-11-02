#!/bin/sh
# Run the stock KLayout LVS deck of the SKY130 PDK (sky130.lvs): compare a GDS file with the reference netlist
# cell.spice. The deck runs with the switches of the PDK script run_lvs.py and schematic simplification on.
# (run_lvs.py itself is not used: with PDK_ROOT set, it looks for the deck in the wrong place, and it writes the
# extracted netlist in the current directory.)
# Usage: ./lvs.sh <gds> [<top cell>]   (default top cell: diffpair)
# Output: the directory lvs/ (the deck log lvs/lvs.log, the LVS database lvs/<top cell>.lvsdb and the extracted
# netlist lvs/<top cell>_extracted.cir). The script prints the report path and the LVS status. The exit code is the
# exit code of the deck (1: the netlists do not match).
gds=${1:?usage: ./lvs.sh <gds> [<top cell>]}
top=${2:-diffpair}
PATH=/foss/tools/klayout:$PATH
export PATH
deck=${PDK_ROOT:-/foss/pdks}/sky130A/libs.tech/klayout/lvs/sky130.lvs
rm -rf lvs
mkdir lvs
report=lvs/$top.lvsdb
klayout -b -r "$deck" -rd input="$gds" -rd top_cell="$top" -rd report="$report" -rd schematic=cell.spice \
	-rd target_netlist="lvs/${top}_extracted.cir" -rd thr=4 -rd run_mode=deep -rd spice_net_names=true \
	-rd spice_comments=false -rd scale=false -rd verbose=false -rd schematic_simplify=true -rd net_only=false \
	-rd top_lvl_pins=false -rd combine=false -rd purge=false -rd purge_nets=false > lvs/lvs.log 2>&1
code=$?
echo "LVS deck exit code: $code"
echo "LVS log: lvs/lvs.log"
if [ -f "$report" ]; then echo "LVS report: $report"; else echo "LVS report: none (the deck did not write $report)"; fi
[ -f "lvs/${top}_extracted.cir" ] && echo "LVS extracted netlist: lvs/${top}_extracted.cir"
if grep -q "Netlists don't match" lvs/lvs.log; then status=MISMATCH
elif grep -q "Congratulations! Netlists match" lvs/lvs.log && [ "$code" = 0 ] && [ -f "$report" ]; then status=MATCH
else status="NOT RUN"; tail -5 lvs/lvs.log; fi
echo "LVS status: $status"
exit $code
