#!/bin/sh
# Run the stock KLayout LVS of the IHP SG13G2 PDK: compare a GDS file with the reference netlist cell.spice.
# Usage: ./lvs.sh <gds> [<top cell>]   (default top cell: diffpair)
# Output: the directory lvs/ (the deck log lvs/lvs.log, the LVS database *.lvsdb and the extracted netlist
# *_extracted.cir). The script prints the report path and the LVS status. The exit code is the exit code of the
# deck. Note: this deck exits with 0 also when the netlists do not match; read the status.
gds=${1:?usage: ./lvs.sh <gds> [<top cell>]}
top=${2:-diffpair}
PATH=/foss/tools/klayout:$PATH
export PATH
deck=${PDK_ROOT:-/foss/pdks}/ihp-sg13g2/libs.tech/klayout/tech/lvs/run_lvs.py
rm -rf lvs
mkdir lvs
python3 "$deck" --layout="$gds" --netlist=cell.spice --topcell="$top" --run_dir=lvs > lvs/lvs.log 2>&1
code=$?
stem=$(basename "$gds" .gds)
report=lvs/$stem.lvsdb
echo "LVS deck exit code: $code"
echo "LVS log: lvs/lvs.log"
if [ -f "$report" ]; then echo "LVS report: $report"; else echo "LVS report: none (the deck did not write $report)"; fi
[ -f "lvs/${stem}_extracted.cir" ] && echo "LVS extracted netlist: lvs/${stem}_extracted.cir"
if grep -q "Netlists don't match" lvs/lvs.log; then status=MISMATCH
elif grep -q "Congratulations! Netlists match" lvs/lvs.log && [ "$code" = 0 ] && [ -f "$report" ]; then status=MATCH
else status="NOT RUN"; tail -5 lvs/lvs.log; fi
echo "LVS status: $status"
exit $code
