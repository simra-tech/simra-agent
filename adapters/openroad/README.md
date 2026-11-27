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
  | `not run` | the log has no complete slack line and no `wns`, `tns` or `worst slack` line: the tool did not read or link the design. The exit code of a script does not show this. Also: a line after the last result says that the tool had no design (a failed run appended to an old log). | status `failed`; `worst_slack_ns` is missing |
  | `invalid check` | the worst slack is more than `max_slack_periods` clock periods negative (default 10), or more than `max_violations` max slew, max fanout or max capacitance violations remain (default 0) | status `failed`; `worst_slack_ns` has no value and the report has no slack number; `worst_path_stages` and `worst_path_logic_depth` are measured |
  | `valid` | else | status `completed`; `worst_slack_ns` is measured |

  Rules of the reader:

  1. A `Startpoint:` line without its slack line is not a result.
  2. The worst slack is the lowest slack line or `worst slack` line. A `wns` of 0 is not a slack (`wns_ns` is a
     separate measurement).
  3. The clock period comes from the input `clock_period_ns`, else from a `create_clock` line of the log for the
     clock of the worst path, else from the two clock edge rows of that path when they are the same edge of one clock.
     A rise edge and a fall edge do not give the period.
  4. The time unit comes from the input `time_unit`, else from the log (`report_units` output or a `set_cmd_units`
     line), else it is ns as an assumption. All measurements are in ns.
  5. The slack limit is not checked when the slack is negative and the period is not known, or when the period is an
     input and the unit of the log is an assumption. The measurement `slack_limit_check` is then missing with the
     reason `not run`, and the response has a warning. The verdict does not include that check.
  6. The violations that remain are those of the newest table of each kind after the last repair of the log. A table
     before the repair does not count.
  7. The stages of the worst path start at the start point. Cells of the clock network before it are not stages.

  An `invalid check` is typical for a check before the placement: `repair_design` cannot buffer a net with a very
  high fanout without cell locations. The slack of such a run is not a timing result. The stage count and the logic
  depth of the worst path are.

- `spef`: an extracted SPEF file in (plain or `.gz`). It counts the nets, the resistance segments and the segments of
  0 ohm (below 1e-6 ohm). A resistance is one number or a triplet (`best:typical:worst`); each is one segment. The
  verdict is `invalid` when the file has no net, a missing or unknown `*R_UNIT` or `*C_UNIT`, a row of a `*RES`
  section that is not a resistance, no resistance segment, a negative segment, only segments of 0 ohm, or a share of
  such segments above `max_zero_fraction` (default 0.25); else `valid`. A file that cannot be read gives `not run`.
  An extraction can end with exit code 0 and write a file without wire resistance, for example with
  `extract_parasitics -lef_res` and a technology LEF without `RESISTANCE` values.

The inputs and measurements are in [adapter.json](adapter.json). `openroad_log.py` has the readers; the librelane
adapter uses them too. It also reads the header of a Liberty file (library name, nominal voltage and temperature)
and compares it with the conditions in a corner name such as `nom_slow_1p08V_125C`.

The adapter has no PDK facts. It needs only the Python standard library (Python 3.6 or later).

The fixtures in `fixtures/` are outputs of tool runs on public designs with IHP SG13G2.
[fixtures/README.md](fixtures/README.md) states the run and the changes of each one.

Test: `python3 -m unittest discover -s adapters/openroad -p "test_*.py"`.
