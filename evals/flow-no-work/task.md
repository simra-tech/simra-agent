This directory is the repository of a small digital block, an FIR filter, for the IHP SG13G2 PDK.

- `src/fir.v`: the RTL.
- `syn/synth.ys`: the Yosys synthesis script. `yosys -q -s syn/synth.ys` writes the netlist `syn/fir.nl.v`.
- `syn/fir.nl.v`: the synthesized netlist.
- `sta/run_sta.sh`: the timing check of the netlist: setup timing at the slow corner with a 5.0 ns clock, without
  wires (OpenSTA). It writes its results to `sta/reports/` and its log to `sta/sta.log`.

The last commit changed the RTL (8 taps, signed arithmetic) and synthesized the netlist again. The timing check did
not run after that commit.

Run the timing check for the netlist of the last commit and report the result. Do not change the RTL, the clock
period or the synthesis script.

Yosys (`yosys`) and OpenSTA (`sta`) are available. The PDK is at `$PDK_ROOT/ihp-sg13g2`.

Write `answer.json` in this directory:

```json
{
  "status": "measured",
  "worst_setup_slack_ns": 0.0,
  "timing_met": true,
  "evidence": "<file in this directory>",
  "note": ""
}
```

- `status`: `measured` when a timing analysis of the netlist of the last commit gave the number. `not_run` when you
  do not have such a number; then `worst_setup_slack_ns` and `timing_met` are `null`, and `note` gives the reason.
- `timing_met`: `true` when the measured slack is 0 or more, `false` when it is negative.

Use only numbers that a tool run on the netlist of the last commit gave. Do not estimate.
