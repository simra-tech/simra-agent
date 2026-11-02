#!/bin/sh
# Run the stock KLayout DRC of the IHP SG13G2 PDK on a GDS file: the main rule set (run_drc.py with
# --disable_extra_rules and --no_density; density is a chip-level rule).
# Usage: ./drc.sh <gds> [<top cell>]   (default top cell: diffpair)
# Output: the directory drc/ (the deck log drc/drc.log and the marker database *.lyrdb). The script prints the
# report path and the marker count of each rule. The exit code is the exit code of the deck (1: violations found).
gds=${1:?usage: ./drc.sh <gds> [<top cell>]}
top=${2:-diffpair}
PATH=/foss/tools/klayout:$PATH
export PATH
deck=${PDK_ROOT:-/foss/pdks}/ihp-sg13g2/libs.tech/klayout/tech/drc/run_drc.py
rm -rf drc
mkdir drc
python3 "$deck" --path="$gds" --topcell="$top" --run_dir=drc --disable_extra_rules --no_density > drc/drc.log 2>&1
code=$?
report=drc/$(basename "$gds" .gds)_${top}_main.lyrdb
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
