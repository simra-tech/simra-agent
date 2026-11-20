# openroad adapter

The openroad adapter reads the logs of OpenROAD and gives typed records. It runs no tool. It has one operation:

- `parse`: a log in. It gives the message counts, the last row of each repair table (`repair_timing`,
  `repair_design`), and the congestion report of `global_route`. For a repair table that did not close, it names the
  pattern that the table shows:

  | Pattern | What the table shows |
  | --- | --- |
  | `buffer_limit` | the repair stopped at the maximum buffer count (message RSZ-0060) |
  | `one_pass_per_endpoint` | a hold repair made one pass for each violating end point and stopped; violations remain |
  | `worst_slack_constant` | the worst slack does not change in the last third of the rows, or more |
  | `margin_only` | no negative slack is left; the message "unable to repair ... within margin" is about the margin |

The inputs and measurements are in [adapter.json](adapter.json). `openroad_log.py` has the readers; the librelane
adapter uses them too. It also reads the header of a Liberty file (library name, nominal voltage and temperature)
and compares it with the conditions in a corner name such as `nom_slow_1p08V_125C`.

The adapter has no PDK facts. It needs only the Python standard library (Python 3.6 or later).

The fixtures in `fixtures/` are logs of the public designs in `examples/acc-sg13g2` and `examples/shreg-sg13g2`
(OpenROAD 26Q1-1024, IHP SG13G2), with the middle rows of the long tables removed. The two `.lib` files are test
headers, not PDK files.

Test: `python3 -m unittest discover -s adapters/openroad -p "test_*.py"`.
