#!/bin/sh
# Regression of the FIR block: simulate the RTL with the stimulus and compare with the golden output.
# Usage: ./regress.sh      Output: out/ (compile.log, sim.log, result.txt)
cd "$(dirname "$0")" || exit 1
mkdir -p out
# vvp of the tool image needs its library directory.
export LD_LIBRARY_PATH=/foss/tools/iverilog/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
iverilog -g2005 -o out/sim.vvp TB_DIRtb.v RTL_DIRfir.v > out/compile.log 2>&1 || { echo "compile failed: see out/compile.log"; exit 1; }
vvp -n out/sim.vvp > out/sim.log 2>&1
python3 TB_DIRcheck.py out/result.txt TB_DIRgolden.txt
