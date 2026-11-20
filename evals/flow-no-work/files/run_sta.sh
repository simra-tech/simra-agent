#!/bin/sh
# Timing check of the synthesized netlist (syn/fir.nl.v) at the slow corner.
# Usage: sta/run_sta.sh      Results: sta/reports/ (summary.txt, setup.rpt, wns.rpt, tns.rpt), log: sta/sta.log
cd "$(dirname "$0")" || exit 1
export CLOCK_PERIOD_NS=5.0
mkdir -p reports
sta -no_splash -exit sta.tcl > sta.log 2>&1
python3 summary.py reports > reports/summary.txt
cat reports/summary.txt
echo "timing check done"
