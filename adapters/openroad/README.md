# openroad adapter

The openroad adapter reads the logs and the extracted files of OpenROAD and OpenSTA and gives typed records. It runs
no tool. It has three operations:

- `parse`: a log in. It gives the message counts, the last row of each repair table (`repair_timing`,
  `repair_design`), and the congestion report of `global_route`. For a repair table that did not close, it names the
  pattern that the table shows:

  | Pattern | What the table shows |
  | --- | --- |
  | `buffer_limit` | the repair stopped at the maximum buffer count (message RSZ-0060) |
  | `one_pass_per_endpoint` | a hold repair made one pass for each violating end point and stopped; violations remain |
  | `worst_slack_constant` | the worst slack does not change in the last third of the rows, or more |
  | `margin_only` | no negative slack is left; the message "unable to repair ... within margin" is about the margin |

- `timing`: the log of a timing step in (OpenSTA, or OpenROAD with `report_checks`, `report_wns`, `report_tns`,
  `report_worst_slack`, `report_check_types`). It gives one of three verdicts:

  | Verdict | When | Response |
  | --- | --- | --- |
  | `not run` | the log has no slack line and no path report: the tool did not read or link the design. The exit code of a script does not show this. | status `failed`; `worst_slack_ns` is missing |
  | `invalid check` | the worst slack is more than `max_slack_periods` clock periods negative (default 10), or more than `max_violations` max slew, max fanout or max capacitance violations remain (default 0) | status `failed`; `worst_slack_ns` has no value; `worst_path_stages` and `worst_path_logic_depth` are measured |
  | `valid` | else | status `completed`; `worst_slack_ns` is measured |

  An `invalid check` is typical for a check before the placement: `repair_design` cannot buffer a net with a very
  high fanout without cell locations. The slack of such a run is not a timing result. The stage count and the logic
  depth of the worst path are.

- `spef`: an extracted SPEF file in (plain or `.gz`). It counts the nets, the resistance segments and the segments of
  0 ohm (below 1e-6 ohm). The verdict is `invalid` when the file has no net, no resistance segment, only segments of
  0 ohm, or a share of such segments above `max_zero_fraction` (default 0.25); else `valid`. An extraction can end with
  exit code 0 and write a file without wire resistance, for example with `extract_parasitics -lef_res` and a
  technology LEF without `RESISTANCE` values.

The inputs and measurements are in [adapter.json](adapter.json). `openroad_log.py` has the readers; the librelane
adapter uses them too. It also reads the header of a Liberty file (library name, nominal voltage and temperature)
and compares it with the conditions in a corner name such as `nom_slow_1p08V_125C`.

The adapter has no PDK facts. It needs only the Python standard library (Python 3.6 or later).

The fixtures in `fixtures/` are outputs of tool runs on public designs with IHP SG13G2.
[fixtures/README.md](fixtures/README.md) states the run and the changes of each one.

Test: `python3 -m unittest discover -s adapters/openroad -p "test_*.py"`.
