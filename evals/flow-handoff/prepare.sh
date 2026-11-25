#!/bin/sh
# Make the history of the block: revision 1 and its run (runs/base), then revision 2 of the RTL. No run of revision 2.
set -e
rm -rf .git
git init -q
g() { git -c user.name=designer -c user.email=designer@localhost "$@"; }
printf 'runs/\nsimra/\nsimra.local.json\nanswer.json\n' > .gitignore
mkdir -p src
cp /prepare/acc_v1.v src/acc.v
g add -A
g commit -q -m "Accumulator block: RTL and flow configuration"
librelane --hide-progress-bar --log-level VERBOSE --manual-pdk --pdk-root "$PDK_ROOT" --pdk "$PDK" \
	--run-tag base --to OpenROAD.STAMidPNR-3 config.json > flow.out 2>&1
test -s runs/base/43-openroad-stamidpnr-3/state_out.json
rm -f flow.out
find . -path ./.git -prune -o -exec touch -h -d '6 days ago' {} +
cp /prepare/acc_v2.v src/acc.v
g add -A
g commit -q -m "Register the output of the accumulator"
