This directory holds a digital block for the IHP SG13G2 PDK and one run of the LibreLane flow.

- `src/shreg.v`: the RTL, a bank of shift registers (12,000 flip-flops).
- `config.json`, `shreg.sdc`: the flow configuration and the timing constraints. The hold uncertainty of the clock is
  0.70 ns. This is a requirement of the project.
- `runs/r1/`: the run of record (LibreLane 3.1.0.dev2), to the timing analysis after the hold repair (last step
  `OpenROAD.STAMidPNR-2`).

The run of record was made with this command:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag r1 --to OpenROAD.STAMidPNR-2 config.json
```

In the run of record, the hold repair after the clock tree synthesis (step 37, `OpenROAD.ResizerTimingPostCTS`) ends
with the warning "Unable to repair all hold checks within margin". The timing analysis after it (step 38) shows hold
violations.

A review note says: "The hold repair cannot close this block at 0.70 ns. The block needs a lower hold uncertainty."
Before the project changes a requirement, find out if the note is right.

1. Find the cause: why did the repair stop with violations?
2. Find out if the hold repair of OpenROAD can close the hold timing of this block after the clock tree synthesis
   (no hold violation at the corner `nom_typ_1p20V_25C`), with no change of the RTL, the SDC file or the clock
   period. If it can, show it with a run, and report the worst hold slack after the repair.

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`. One run of the flow to step 38 takes about 3 minutes. The session limit is 15 minutes.

Write `answer.json` in this directory:

```json
{
  "cause": "<name>",
  "repair_can_close": true,
  "hold_ws_ns": 0.0,
  "evidence": "<the log of the repair run that shows it>",
  "note": ""
}
```

- `cause`: one of these names.
  - `setup_limit`: the repair stopped because more hold buffers would make setup violations.
  - `buffer_count_limit`: the repair stopped at its maximum number of buffers.
  - `pass_limit`: the repair made a fixed number of passes (for example one pass for each violating end point) and
    stopped; the paths that remain can be repaired.
  - `placement_limit`: there is no space for more buffers.
  - `margin_only`: all hold checks are met; the message is about the repair margin only.
  - `path_limit`: the paths that remain cannot be repaired with the buffers of the library.
- `repair_can_close`: `true` when a run of yours ends the repair with no hold violation. `false` when you conclude
  that the repair cannot close the block. `null` when you did not find out.
- `hold_ws_ns`: the worst hold slack after the repair in your run (the last row of the repair table, or a timing
  analysis after it). `null` when you have no such run.

Use only results that a tool run gave. Keep the log of the run in this directory.
