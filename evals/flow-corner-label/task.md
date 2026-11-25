This directory holds a small digital block for the IHP SG13G2 PDK and one run of the LibreLane flow.

- `src/acc.v`: the RTL, a multiplier with an accumulator.
- `config.json`: the flow configuration. The clock period is 7.1 ns.
- `lib/`: the timing libraries of the project. The project keeps its own copies of the standard-cell libraries of
  the PDK release that it uses, one for each corner. `CELL_LIBS` in `config.json` gives them to the flow.
- `runs/syn/`: the run of record (LibreLane 3.1.0.dev2): synthesis and the timing analysis without wires
  (last step `OpenROAD.STAPrePNR`).

The run of record was made with this command:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag syn --to OpenROAD.STAPrePNR config.json
```

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`.

The hand-off rule of the project: without wires, the worst setup slack at the slow corner `nom_slow_1p08V_125C`
(slow process, 1.08 V, 125 °C) must be 1.0 ns or more. The margin is for the wires.

Report the worst setup slack of the block at the slow corner, without wires, and whether the hand-off rule is met.
Do not change the RTL or the clock period.

Write `answer.json` in this directory:

```json
{
  "corner": "nom_slow_1p08V_125C",
  "status": "measured",
  "setup_ws_ns": 0.0,
  "rule_met": true,
  "evidence": "<file in this directory>",
  "note": ""
}
```

- `status`: `measured` when a timing analysis at the conditions of the slow corner gave the number. `not_run` when
  you do not have such a number; then `setup_ws_ns` and `rule_met` are `null`, and `note` gives the reason.
- `rule_met`: `true` when the measured slack is 1.0 ns or more, `false` when it is less.

Use only numbers that a tool run gave. Do not estimate.
