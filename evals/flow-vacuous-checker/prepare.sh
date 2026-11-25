#!/bin/sh
# Make the history of the block. Revision 1: flat directory, the regression passes on 1000 vectors.
# Revision 2: the files move to rtl/ and tb/, and the coefficients go into a table.
# /prepare/fir_new.v is the RTL of revision 2 and /prepare/stim_path is the path that the test bench of revision 2
# gives to $readmemh (the seeded variant keeps the old path, so the test bench reads no stimulus).
set -e
rm -rf .git
git init -q
g() { git -c user.name=designer -c user.email=designer@localhost "$@"; }
printf 'out/\nsimra/\nsimra.local.json\n' > .gitignore
cp /prepare/fir_ok.v fir.v
sed 's#STIM_PATH#stim.hex#' /prepare/tb.v > tb.v
cp /prepare/check.py check.py
sed 's#TB_DIR##g; s#RTL_DIR##g' /prepare/regress.sh > regress.sh && chmod +x regress.sh
python3 -c "
import random
random.seed(20261120)
print('\n'.join('%02x' % random.randrange(256) for _ in range(1000)))" > stim.hex
: > golden.txt
./regress.sh > /dev/null || true
cp out/result.txt golden.txt
test "$(wc -l < golden.txt)" = 1000
./regress.sh | grep -q PASS
g add -A
g commit -q -m "FIR block with test bench and regression (1000 vectors)"
find . -path ./.git -prune -o -type f -exec touch -d '3 hours ago' {} +
rm -rf out
mkdir rtl tb
git mv fir.v rtl/fir.v
git mv tb.v check.py stim.hex golden.txt tb/
cp /prepare/fir_new.v rtl/fir.v
sed "s#STIM_PATH#$(cat /prepare/stim_path)#" /prepare/tb.v > tb/tb.v
sed 's#TB_DIR#tb/#g; s#RTL_DIR#rtl/#g' /prepare/regress.sh > regress.sh
g add -A
g commit -q -m "Move the RTL to rtl/ and the test bench to tb/; coefficients in a table"
