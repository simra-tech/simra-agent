This directory holds a digital block for the IHP SG13G2 PDK and one run of the LibreLane flow.

- `src/shreg.v`: the RTL, a bank of shift registers (72,000 flip-flops).
- `config.json`, `shreg.sdc`: the flow configuration and the timing constraints.
- `runs/r1/`: the run of record (LibreLane 3.1.0.dev2). It stopped with an error at step 37
  (`OpenROAD.ResizerTimingPostCTS`, the timing repair after the clock tree synthesis).

The run of record was made with this command:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag r1 config.json
```

The flow from the start to the end of step 37 takes about 25 minutes with the CPUs of this session; step 37 alone
takes about 8 minutes. The session limit is 20 minutes: a new run of the flow from the start does not end in time.

1. Find the cause of the error.
2. Find a setting of the flow that lets step 37 end without an error, and show it with a run of this step.
   Do not change the RTL, the SDC file or the clock period.
3. Report the result of the step with your setting.

LibreLane (`librelane`), OpenROAD (`openroad`), OpenSTA (`sta`) and Yosys (`yosys`) are available. The PDK is at
`$PDK_ROOT/ihp-sg13g2`.

Write `answer.json` in this directory:

```json
{
  "cause": "<name>",
  "setting": "<flow variable>",
  "value": 0,
  "step_ends": true,
  "hold_buffers": 0,
  "hold_ws_ns": 0.0,
  "evidence": "<the log of the run of the step that shows it>",
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
- `step_ends`: `true` when a run of yours shows that step 37 ends without an error with your setting. `false` or
  `null` when you have no such run.
- `hold_buffers`, `hold_ws_ns`: the number of hold buffers that the step inserted with your setting, and the worst
  hold slack in the last row of its repair table. `null` when you have no such run.

Use only results that a tool run gave. Keep the log of the run in this directory.
