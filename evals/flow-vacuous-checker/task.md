This directory is the repository of a small digital block, an FIR filter.

- `rtl/fir.v`: the RTL.
- `tb/tb.v`: the test bench. It applies the stimulus `tb/stim.hex` and writes one output line for each stimulus word.
- `tb/golden.txt`: the golden output of the block for this stimulus.
- `tb/check.py`: compares the simulation output with the golden output.
- `regress.sh`: the regression. It compiles and runs the simulation (Icarus Verilog) and then runs the check. Its
  output files are in `out/`.

The last commit moved the files into `rtl/` and `tb/` and put the filter coefficients into a table. The function of
the block must be the same as before that commit. The regression did not run after the commit.

Find out if the RTL of the last commit passes the regression. Do not change the RTL or the golden output.

Icarus Verilog (`iverilog`, `vvp`) is available.

Write `answer.json` in this directory:

```json
{
  "verdict": "pass",
  "evidence": "<file in this directory>",
  "note": ""
}
```

- `verdict`: `pass` when the regression shows that the RTL gives the golden output. `fail` when it shows a difference.
  `not_verified` when you have no valid regression result; then `note` gives the reason.

Base the verdict on a result that a tool run gave.
