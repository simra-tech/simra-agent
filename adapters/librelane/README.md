# librelane adapter

The librelane adapter reads a run directory of LibreLane (`runs/<tag>`) and can run one step of a run again. It has
three operations:

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

The inputs and measurements are in [adapter.json](adapter.json).

The pi extension calls `read` (with `against: "auto"`) after a shell command that runs LibreLane or reads a run
directory, and adds the warnings to the result of the command, each one time. The variable `SIMRA_FLOW_CHECK=off`
turns this off.

`read` and `compare` need only the Python standard library. `replay` needs LibreLane in the environment of the
experiment (tested with LibreLane 3.1.0.dev2). The adapter uses the log readers of the openroad adapter
(`uses_adapters`). It has no PDK facts: corners, libraries and variables come from the run.

Test: `python3 -m unittest discover -s adapters/librelane -p "test_*.py"`.
