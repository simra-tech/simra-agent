#!/bin/sh
# Run the stock KLayout DRC of the SKY130 PDK (sky130A_mr.drc) on a GDS file: the main rule set, with the switches
# of the run_drc_full macro of the PDK (feol, beol and offgrid). The deck has no density rules.
# Usage: ./drc.sh <gds> [<top cell>]   (default top cell: idac)
# Output: the directory drc/ (the deck log drc/drc.log and the marker database drc/<top cell>.lyrdb). The script
# prints the report path and the marker count of each rule. The exit code is the exit code of the deck (this deck
# exits with 0 also when it finds violations; read the marker count).
gds=${1:?usage: ./drc.sh <gds> [<top cell>]}
top=${2:-idac}
PATH=/foss/tools/klayout:$PATH
export PATH
deck=${PDK_ROOT:-/foss/pdks}/sky130A/libs.tech/klayout/drc/sky130A_mr.drc
rm -rf drc
mkdir drc
report=drc/$top.lyrdb
klayout -b -r "$deck" -rd input="$gds" -rd top_cell="$top" -rd report="$report" -rd feol=true -rd beol=true -rd offgrid=true -rd thr=4 > drc/drc.log 2>&1
code=$?
echo "DRC deck exit code: $code"
echo "DRC log: drc/drc.log"
if [ -f "$report" ]; then
	echo "DRC report: $report"
	python3 -c '
import collections, sys, xml.etree.ElementTree as ET
items = ET.parse(sys.argv[1]).getroot().find("items")
rules = collections.Counter(i.findtext("category").strip("'"'"'") for i in (items if items is not None else []))
print(f"DRC markers: {sum(rules.values())}")
for rule, n in sorted(rules.items()):
    print(f"  {rule}: {n}")
' "$report"
else
	echo "DRC report: none (the deck did not write $report)"
	tail -5 drc/drc.log
fi
exit $code
