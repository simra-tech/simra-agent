# Demo evaluation: fix the DRC violations of a small analog cell

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a layout task. The agent gets the layout of a small analog cell (`cell.gds`) with seeded DRC
violations, the reference netlist and two scripts that run the stock KLayout DRC and LVS decks of the PDK. It must
fix the violations, so that the DRC reports 0 markers and LVS still matches the netlist with the same pins. Then it
reports the checks in `answer.json`. The task has the same form for two PDKs, because a feature that uses PDK
knowledge must have its evaluation on at least two PDKs.

The companion task [layout-clean](../layout-clean/README.md) gives the same cell without violations. There, the
agent must verify the cell, with no false alarm and no needless edit.

| Directory | PDK | Devices | DRC | LVS |
| --- | --- | --- | --- | --- |
| `sg13g2/` | IHP SG13G2 | `sg13_lv_nmos` | `run_drc.py`, main rule set | `run_lvs.py` |
| `sky130/` | SkyWater SKY130 (`sky130A`) | `sky130_fd_pr__nfet_01v8` | `sky130A_mr.drc` | `sky130.lvs` |

| File | Contents |
| --- | --- |
| `layout.mjs` | the shared parts: spec parser, marker database and LVS log parsers, verification, scorer (also for [layout-block-fix](../layout-block-fix/README.md) and [layout-false-pass](../layout-false-pass/README.md)) |
| `cell.py` | the floor plan of the cell and its three variants (clean, seeded, cheat), on `klayout.db` |
| `reference.mjs` | makes the variants, verifies them, and writes the input GDS files and `expected.json` |
| `<pdk>/generate.py` | the generator of the cell on the PDK: the layers, the sizes, the devices and the tap |
| `<pdk>/cell-seeded.gds` | the input of this task (the seeded variant) |
| `<pdk>/cell-clean.gds` | the input of layout-clean (the clean variant) |
| `<pdk>/cell.spice` | the reference netlist |
| `<pdk>/spec.md` | the specification: the circuit, the pins and their order, the pin layers, the checks |
| `<pdk>/drc.sh`, `<pdk>/lvs.sh` | the wrappers of the stock decks (the same for the agent and the scorer) |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/simra.config.json` | the environment of the task (the IIC-OSIC-TOOLS image) |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `layout.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |

The agent gets `cell.gds`, `cell.spice`, `spec.md`, `task.md`, `drc.sh`, `lvs.sh` and `simra.config.json`. It does
not get the generator, the other variants or `expected.json`. `../run-arm.mjs` reports a run as contaminated if
the transcript names `expected.json`, `layout-drc-fix/` or a variant file (`cell-seeded.gds`, `cell-clean.gds`,
`cell-cheat.gds`).

## The cell

The cell `diffpair` is an NMOS differential pair with a tail current mirror and a dummy device at each end of the
pair: 6 devices, W = 1 µm, L = 0.5 µm. The pins are `inp inn outp outn ibias vss`, in this order.

1. One row of devices, from left to right: a substrate tap, MD1, M1, M2, MD2, M4, M3.
2. Each source and drain goes down on Metal1 to a Metal2 bus (`tail`, `vss`, `ibias`), with a Via1.
3. The pins `inp`, `inn`, `outp`, `outn` and `ibias` are Metal1 pads. The pin `vss` is a Metal2 pad.
4. The generator writes one flat cell, with no time stamps, so the GDS hash is reproducible.

The LVS of both PDKs combines the two dummy devices into one device with W = 2 µm. On SKY130, this needs the
schematic simplification of the deck (`schematic_simplify=true`).

## The seeded rules

The seeded variant is the clean cell with four routing shapes drawn wrong. The connectivity does not change, so
LVS still matches.

| Seed | Shape | IHP SG13G2 rule | Markers | SKY130 rule | Markers |
| --- | --- | --- | --- | --- | --- |
| width | the Metal1 segment above the `outp` pad is narrow (0.14 µm on IHP, 0.12 µm on SKY130) | `M1.a` | 3 | `m1.1` | 1 |
| spacing | the Metal2 bridge of the `vss` bus moves down, near the `ibias` bus | `M2.b` | 1 | `m2.2` | 1 |
| enclosure | the Via1 of the M3 drain moves to the edge of its Metal1 pad | `V1.c` | 1 | `via.4a` | 1 |
| off-grid | the right edge of the `inp` line is 1 nm off the manufacturing grid | `metal1_drw_Offgrid` | 2 | `m1_OFFGRID` | 2 |

Total: 7 markers on IHP SG13G2 and 5 markers on SKY130.

The cheat variant is the seeded cell without the four shapes. The DRC reports 0 markers, but four connections are
open, so LVS does not match. The score gives the cheat no LVS points.

## Scoring

The scorer does not use the numbers of the answer to find if the cell is clean. It runs `drc.sh` and `lvs.sh` of
the task directory again on the final `cell.gds`, in the container of the task, with the reference netlist of the
task directory. The verification goes to `verify/` in the run directory.

| Part | Points | The points are given when |
| --- | --- | --- |
| drc | 4 | the DRC ran and reports 0 markers |
| lvs | 4 | the LVS ran, the netlists match, and the pins of the layout are the pins of `spec.md` |
| claim | 4 | `drc_clean` and `lvs_match` agree with the verification, the answer has a check row for DRC and for LVS, a claim of true has its row with `ran: true`, and each row with `ran: true` names a report file in the workspace |
| fixed | 3 | the rules of `fixed` are the seeded rules (case and quotes do not count) |

A deck result is "not run" when the deck did not complete. The scorer compares the printed result with the exit code
and the report:

1. DRC: no marker database, a marker database that does not parse, an exit code other than 0 (or 1 with markers),
   or a printed pass with markers give "not run".
2. LVS: no LVS database, a printed match with an exit code other than 0, or a printed mismatch with an exit code
   other than 0 or 1 give "not run". Thus a deck that prints a match and then crashes is "not run".

The score also has diagnostics, which give no points: the marker count of each rule (`drc_rules`), the LVS status
text and the pins, the hash of the final `cell.gds` and of the input, `not_run` (the rows of the answer with
`ran: false`), `stale_reports` (report files older than the final `cell.gds`), the deck runtimes of the
verification, `verification` and `errors`. `metrics` has the run metrics from `transcript.jsonl` next to the
workspace: `tool_calls`, `inline_python_calls` (shell commands that run Python code from the command line, with
`python -c` or a script on standard input) and `result_bytes` (the bytes of the tool results). The scorer reads the
three transcript formats of `../run-arm.mjs`: pi, Codex CLI and OpenCode. Without a transcript, `metrics` is
"not_run".

## The decks

The wrappers run the stock decks of the PDKs in the image. They do not change the decks.

1. IHP SG13G2 DRC: `python3 $PDK_ROOT/ihp-sg13g2/libs.tech/klayout/tech/drc/run_drc.py --path=<gds>
   --topcell=diffpair --run_dir=drc --disable_extra_rules --no_density`. The main rule set: the deck names its
   report `drc/<gds name>_diffpair_main.lyrdb`. Density is a chip-level rule, and the density rules (`M1.j` and
   others) fail on a small cell. The deck exits with 1 when it finds violations.
2. IHP SG13G2 LVS: `python3 $PDK_ROOT/ihp-sg13g2/libs.tech/klayout/tech/lvs/run_lvs.py --layout=<gds>
   --netlist=cell.spice --topcell=diffpair --run_dir=lvs`. The deck exits with 0 also when the netlists do not
   match. The wrapper and the scorer read the printed result.
3. SKY130 DRC: `klayout -b -r $PDK_ROOT/sky130A/libs.tech/klayout/drc/sky130A_mr.drc` with the switches of the stock
   macro `run_drc_full.lydrc` (`feol`, `beol` and `offgrid` on). The deck exits with 0 also when it finds
   violations. The wrapper and the scorer read the marker database.
4. SKY130 LVS: `klayout -b -r $PDK_ROOT/sky130A/libs.tech/klayout/lvs/sky130.lvs` with the switches of the stock
   script `run_lvs.py` and schematic simplification on. The wrapper does not use `run_lvs.py`: with `PDK_ROOT` set,
   the script looks for the deck at `$PDK_ROOT/$PDK/sky130.lvs`, which does not exist in the image. Without
   `PDK_ROOT`, it works, but it writes the extracted netlist in the current directory. The deck exits with 1 when
   the netlists do not match.

`expected.json` has the full command line of each deck in `decks`.

## Reference results

`reference.mjs` makes the three variants of each PDK with `generate.py` in the container. It verifies each
variant with `drc.sh` and `lvs.sh`, and it checks the roles: the clean variant has 0 markers and matches, the
seeded variant has exactly the seeded rules and matches, and the cheat has 0 markers and does not match.

| PDK | Variant | SHA-256 (first 12) | DRC markers | DRC exit | DRC runtime | LVS | LVS exit | LVS runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13g2 | clean | `6be355899640` | 0 | 0 | 1.93 s | match | 0 | 1.22 s |
| sg13g2 | seeded | `6a7dc89701d0` | 7 | 1 | 1.95 s | match | 0 | 1.20 s |
| sg13g2 | cheat | `b3358df8d087` | 0 | 0 | 1.95 s | **mismatch** | 0 | 1.22 s |
| sky130 | clean | `545b55db919e` | 0 | 0 | 1.21 s | match | 0 | 0.84 s |
| sky130 | seeded | `721d6250a61b` | 5 | 0 | 1.17 s | match | 0 | 0.84 s |
| sky130 | cheat | `70e7c3d4702c` | 0 | 0 | 1.15 s | **mismatch** | 1 | 0.83 s |

The runtime is the time of the wrapper in the container, without the start of the container. The pins of the
extracted netlist of the cheat are `ibias inn outn vss`: the open connections remove `inp` and `outp`.

KLayout 0.30.12 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of
open_pdks `1689ac3f2dc7`. `expected.json` has the image ID, the full hashes, the marker counts per rule, the LVS
status and pins, the deck command lines and the runtimes.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/layout-drc-fix/reference.mjs`. It checks the roles and prints the results. It writes no file.
3. Run `node evals/layout-drc-fix/reference.mjs --write`. It also writes `<pdk>/cell-seeded.gds`,
   `<pdk>/cell-clean.gds`, and `expected.json` of both tasks.
4. Run `npm test`. With `SIMRA_TEST_IMAGE` set, `test/layout-verify.test.mjs` makes the variants again in the
   container and compares the hashes and the results with `expected.json`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/layout-drc-fix/<pdk> <arm> [--model <id>] --timeout-min 30`.
