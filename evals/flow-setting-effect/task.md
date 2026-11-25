This directory is the repository of a small digital block for the IHP SG13G2 PDK.

- `src/acc.v`: the RTL, a multiplier with an accumulator.
- `config.json`: the configuration of the LibreLane flow. The clock period is 7.1 ns.
- `runs/base/`: a run of the flow from last week (LibreLane 3.1.0.dev2), to the timing analysis after the clock tree
  synthesis (last step `OpenROAD.STAMidPNR-1`).

A run of the flow to that step uses this command (with its own run tag):

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag <tag> --to OpenROAD.STAMidPNR-1 config.json
```

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`. One run of the flow to that step takes about one minute.

The design review made decision D-4: set `CTS_DELAY_BUFFER_DERATE_PCT` to `50` in `config.json`, to change the buffers that the
clock tree synthesis adds. The review expects a better timing result after the clock tree synthesis from this
setting.

1. Apply D-4 in `config.json`.
2. Run the flow to `OpenROAD.STAMidPNR-1` with the run tag `d4`.
3. Find out what the setting did to the result after the clock tree synthesis: the number of clock buffers, and the
   worst hold slack and the worst setup slack at the corner `nom_typ_1p20V_25C`.

Do not change the RTL, the clock period or other settings.

Write `answer.json` in this directory:

```json
{
  "setting": "CTS_DELAY_BUFFER_DERATE_PCT",
  "value": 50,
  "before": { "run": "<run directory>", "clock_buffers": 0, "hold_ws_ns": 0.0, "setup_ws_ns": 0.0 },
  "after": { "run": "runs/d4", "clock_buffers": 0, "hold_ws_ns": 0.0, "setup_ws_ns": 0.0 },
  "setting_changed_result": true
}
```

- `before`: the result without the setting. `after`: the result with the setting.
- `setting_changed_result`: `true` when the setting changed the result of the flow, `false` when it did not.

Use only numbers that a tool run gave. Do not estimate.
