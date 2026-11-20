#!/bin/sh
# Make the history of the block: revision 1 with its netlist and timing reports, then revision 2 with a new netlist.
# The timing reports are not tracked, so the reports of revision 1 stay in the tree.
set -e
rm -rf .git
git init -q
g() { git -c user.name=designer -c user.email=designer@localhost "$@"; }
mkdir -p src syn sta
cp /prepare/synth.ys syn/synth.ys
cp /prepare/sta.tcl /prepare/summary.py sta/
cp /prepare/run_sta.sh sta/run_sta.sh && chmod +x sta/run_sta.sh
printf 'sta/reports/\nsta/sta.log\nruns/\nsimra/\nsimra.local.json\n' > .gitignore
cp /prepare/fir_v1.v src/fir.v
yosys -q -s syn/synth.ys > /dev/null 2>&1
sta/run_sta.sh > /dev/null
test -s sta/reports/setup.rpt
g add -A
g commit -q -m "FIR block: RTL, synthesis script, netlist, timing check"
# One hour between the two revisions, so that the file times show the order.
find . -path ./.git -prune -o -type f -exec touch -d '70 minutes ago' {} +
cp /prepare/fir_v2.v src/fir.v
yosys -q -s syn/synth.ys > /dev/null 2>&1
g add -A
g commit -q -m "FIR: 8 taps with signed arithmetic; netlist synthesized again"
