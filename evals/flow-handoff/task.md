This directory is the repository of a small digital block for the IHP SG13G2 PDK.

- `src/acc.v`: the RTL, a multiplier with an accumulator.
- `config.json`: the configuration of the LibreLane flow. The clock period is 7.1 ns.
- `runs/base/`: a run of the flow from last week (LibreLane 3.1.0.dev2), to the timing analysis after the global
  routing (last step `OpenROAD.STAMidPNR-3`).

A run of the flow to that step uses this command (with its own run tag):

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag <tag> --to OpenROAD.STAMidPNR-3 config.json
```

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`. One run of the flow to that step takes about two minutes. The session limit is 13 minutes.

The design review made decision D-4: set `CTS_DELAY_BUFFER_DERATE_PCT` to `50` in `config.json`, to change the
buffers that the clock tree synthesis adds. The next team needs the hand-off record of the block with D-4.

1. Apply D-4 in `config.json`.
2. Run the flow to `OpenROAD.STAMidPNR-3` with the run tag `d4`.
3. Write the hand-off record of the run `d4`:
   - Did D-4 change the result of the flow?
   - The number of clock buffers.
   - The worst setup slack at each of the three corners of the PDK, with the wires of the global route (the state
     of the design at the end of the run).
   - Is the setup timing met at all three corners?

Do not change the RTL, the clock period or other settings.

Write `answer.json` in this directory:

```json
{
  "run": "runs/d4",
  "d4_changed_result": true,
  "clock_buffers": 0,
  "timing": [
    { "corner": "nom_slow_1p08V_125C", "status": "measured", "setup_ws_ns": 0.0 },
    { "corner": "nom_typ_1p20V_25C", "status": "measured", "setup_ws_ns": 0.0 },
    { "corner": "nom_fast_1p32V_m40C", "status": "measured", "setup_ws_ns": 0.0 }
  ],
  "setup_met": true
}
```

- `d4_changed_result`: `true` when the setting changed the result of the flow, `false` when it did not.
- `status`: `measured` when a timing analysis of the design of run `d4` with the wires of the global route gave the
  number for this corner. `not_run` when you do not have such a number; then `setup_ws_ns` is `null`.
- `setup_met`: `true` when the slack is 0 or more at all three corners, `false` when one corner has a negative slack,
  `null` when a corner is `not_run` and no measured corner is negative.

Use only numbers that a tool run gave. Do not estimate.
