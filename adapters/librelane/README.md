# librelane adapter

The librelane adapter reads a run directory of LibreLane (`runs/<tag>`) and can run one step of a run again. It has
four operations:

- `read`: the typed record of a run, with no tool run. For each corner it gives the worst setup and hold slack from
  the last step that computed it, with the evidence level of that step:

  | Level | Wires of the timing analysis | Steps |
  | --- | --- | --- |
  | `no_wires` | none | `OpenROAD.STAPrePNR`, and each step before the placement |
  | `placement_estimate` | estimated from the placement | the steps after the global placement |
  | `global_route` | from the global route | the steps after `OpenROAD.GlobalRouting` |
  | `extracted` | extracted | `OpenROAD.STAPostPNR` |

  The metrics of the last state of a run repeat the numbers of earlier steps. `read` uses the metrics that each step
  computed (`or_metrics_out.json`), and gives a warning for a corner whose newest number has a lower level than the
  newest level of the run. Other warnings: a corner name that does not agree with the header of the library that the
  corner loaded; a step that did not end; a repair table with a known pattern (see the openroad adapter); a design
  input that is newer than the run.
- `compare`: two runs in. It gives the settings that differ, the first step that reads one of them and the first
  step whose netlists or metrics differ. A changed setting with no different step had no effect. A difference
  before the first step that reads the setting comes from another input.
- `replay`: one step of a run again, on the saved input state of the step, with changed flow variables
  (`python3 -m librelane.steps run`). The work is in the directory of the experiment; the run directory is not
  changed. It gives the metrics that differ from the step in the run. Examples: a timing step with `PNR_CORNERS` set
  to one corner gives that corner with the wires of the step; a repair step with a changed limit; a second repair
  pass with `state_in` set to the `state_out.json` of the first replay. A variable that the step does not read fails
  the request before the run.

- `preflight`: the check of the environment before a long run. It starts the version command of each flow tool with
  the PATH of the `librelane` launcher, lists the view counts of each library of the PDK, and checks the free space
  and a write. It gives a warning for a tool that does not start and for two builds of a tool with different
  versions. The report is the record of the tool versions.

`read` also records the hashes of the design inputs that the run names (the RTL and the SDC files, as they are now)
and of the launcher files that the request gives (input `launcher`).

The inputs and measurements are in [adapter.json](adapter.json).

`read` also checks each SPEF file that a step of the run wrote (the extraction step). It gives the measurements
`spef_files` and `spef_files_invalid`, and a warning for a file without wire resistance: no resistance segment, only
segments of 0 ohm, or too many of them. The slack numbers with the level `extracted` used these files. A file above
200 MB is not read: the warning says that the check did not run. The check is the operation `spef` of the openroad
adapter.

The pi extension calls `read` (with `against: "auto"`) after a shell command that runs LibreLane or reads a run
directory, and adds the warnings to the result of the command, each one time. The variable `SIMRA_FLOW_CHECK=off`
turns this off.

The timing step check is part of the same hook: after a shell command with exit code 0 that wrote the log of a
timing step (a file named `sta`, `opensta` or `timing`, or a log with timing commands) and no file with a slack line
or a path report, the result gets the note `Simra timing check: not run` with the first error line. The step
directories of a LibreLane run are not part of this check.

The command check is another hook, off by default (`SIMRA_COMMAND_CHECK=on`): after a shell command with exit code
0, it adds the logs with error lines and the empty result files that the command wrote. In the pilots of
`evals/flow-no-work` and `evals/flow-vacuous-checker` the agents found these faults without it, and the notes added
tokens; so it is not on by default.

`read` and `compare` need only the Python standard library. `replay` needs LibreLane in the environment of the
experiment (tested with LibreLane 3.1.0.dev2). The adapter uses the log readers of the openroad adapter
(`uses_adapters`). It has no PDK facts: corners, libraries and variables come from the run.

Test: `python3 -m unittest discover -s adapters/librelane -p "test_*.py"`.
