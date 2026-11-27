# Fixtures of the openroad adapter

Each fixture is the output of a tool run on a public design with the public PDK IHP SG13G2. The sources of the
runs that are not in `examples/` are in `make/`. The scripts in `make/` read the Liberty files from `/work/lib/`
(unpacked copies of the PDK files) and the LEF files from the PDK directory of the tool image.

Tool versions: Yosys 0.71, OpenSTA 3.2.0 (3.1.0 where stated), OpenROAD 26Q4, LibreLane 3.1.0.dev6. The older
fixtures (`hold_*.log`, `global_route.log`) are from OpenROAD 26Q1-1024.

| Fixture | Design and run | Changes to the tool output |
| --- | --- | --- |
| `hold_*.log`, `global_route.log` | `examples/acc-sg13g2` and `examples/shreg-sg13g2`, steps of a LibreLane run | middle rows of the long tables removed |
| `sta_signed_syntax_error.log` | the signed FIR filter of `evals/flow-no-work`, `make/fir_synth.ys`, then `sta -exit make/fir_sta.tcl` with OpenSTA 3.1.0. The exit code was 0. | none |
| `sta_not_a_module.log` | `examples/acc-sg13g2/src/acc.v` below `make/acc_top.v`, `make/acc_top_synth.ys`, then `make/acc_top_sta.tcl`. The netlist has the module `$paramod\acc\W=...` and no module `acc`. The exit code was 0. | none |
| `sta_valid.log` | `examples/acc-sg13g2/src/acc.v`, synthesized as the top, timing at the slow corner without wires | none |
| `prelayout_no_buffers.log` | `make/shreg_en.v` (24 chains of 500 flip-flops, one registered enable), `make/synth.ys`, then `make/prelayout.tcl`: `repair_design` and timing reports without a placement | 25 of 36001 rows of the max slew table kept |
| `prelayout_fanout_left.log` | `examples/acc-sg13g2/src/acc.v`, `make/prelayout_acc.tcl`: the same check on a small block | 25 of 134 rows of the max fanout table kept |
| `acc_lef_res.spef` | `examples/acc-sg13g2` routed with LibreLane, then `make/rcx.tcl` with the technology LEF of the PDK and `LEF_RES=1` | the first 12 nets of 3482 |
| `acc_lef_res_no_resistance.spef` | the same, with a copy of the technology LEF without the `RESISTANCE` statements | the first 12 nets of 3482 |
| `sta_valid_then_not_a_module.log` | `sta_valid.log` with `sta_not_a_module.log` appended: a script that writes its log with `>>` | two tool outputs in one file |
| `sta_half_cycle.log` | `make/halfcycle.v` (a rising-edge flip-flop to a falling-edge flip-flop), `make/halfcycle_synth.ys`, then `make/halfcycle_sta.tcl` at a period of 10 ns. The clock edges of the path are 5 ns apart. | none |
| `sta_units_ps.log` | `examples/acc-sg13g2/src/acc.v` with `make/units_ps_sta.tcl`: `set_cmd_units -time ps`, `report_units`, then the timing reports in ps | none |
| `placed_repair_before_and_after.log` | `examples/acc-sg13g2/src/acc.v` with `make/placed_repair.tcl`: floorplan, placement, a violation report, `repair_design`, the same report again (200 max fanout violators before, 2 after) | 25 of 200 rows of the table before the repair kept |
| `hand_triplets.spef`, `hand_unknown_unit.spef` | written by hand, not tool output: OpenROAD writes single values and known units. Triplets (`best:typical:worst`) are part of the SPEF format. | - |
| `slow.lib`, `typ_named_slow.lib` | test headers, not PDK files | - |

Results of the full runs:

- Extraction with the technology LEF of the PDK: 15382 resistance segments, none at 0 ohm, 498 kilohm in total.
- Extraction with the LEF copy without `RESISTANCE`, option `-lef_res`: 11573 segments, a sum of 1.5e-13 ohm, exit code
  0, no warning.
- Extraction with the same LEF copy, without `-lef_res`: 11676 segments, 49.5 kilohm in total (from the rule file).
- `prelayout_no_buffers.log`: 0 buffers inserted, worst slack -158.792 ns at a period of 10 ns.
- `prelayout_fanout_left.log`: 66 buffers inserted, worst slack -1.085 ns at a period of 7.1 ns.
