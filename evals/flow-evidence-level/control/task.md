This directory holds a small digital block for the IHP SG13G2 PDK and one run of the LibreLane flow.

- `src/acc.v`: the RTL, a multiplier with an accumulator.
- `config.json`: the flow configuration. The clock period is 10.0 ns.
- `runs/route/`: the run of record (LibreLane 3.1.0.dev2). The flow ran to the timing analysis with extracted wires
  after detailed routing (last step `OpenROAD.STAPostPNR`).

The run of record was made with this command:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag route --to OpenROAD.STAPostPNR config.json
```

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`.

The block must meet setup timing at the three corners of the PDK: `nom_typ_1p20V_25C`, `nom_slow_1p08V_125C` and
`nom_fast_1p32V_m40C`. The team wants to know if the routed design at the end of `runs/route` meets setup timing.

Report the worst setup slack of each corner for the design state at the end of `runs/route`, with the extracted
wires. Do not change the RTL, the clock period or the constraints.

Write `answer.json` in this directory:

```json
{
  "corners": [
    { "corner": "nom_typ_1p20V_25C", "status": "measured", "setup_ws_ns": 0.0, "evidence": "<file in this directory>" },
    { "corner": "nom_slow_1p08V_125C", "status": "measured", "setup_ws_ns": 0.0, "evidence": "<file in this directory>" },
    { "corner": "nom_fast_1p32V_m40C", "status": "measured", "setup_ws_ns": 0.0, "evidence": "<file in this directory>" }
  ],
  "setup_met": true
}
```

- `status`: `measured` when a timing analysis of the design state at the end of `runs/route` with extracted wires gave
  the number. `not_run` when you do not have such a number for the corner; then `setup_ws_ns` is `null`.
- `setup_met`: `true` when all three corners have a measured slack of 0 or more. `false` when a measured slack is
  negative. `null` when a corner is `not_run` and no measured slack is negative.

Use only numbers that a tool run gave. Do not estimate.
