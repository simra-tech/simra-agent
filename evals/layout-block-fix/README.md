# Demo evaluation: fix the DRC violations of a hierarchical analog block

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a layout task, like [layout-drc-fix](../layout-drc-fix/README.md), on a larger layout. The agent gets
the layout of a hierarchical analog block (`block.gds`, 10012 devices in four levels of cells) with seeded DRC
violations, the hierarchical reference netlist and two scripts that run the stock KLayout DRC and LVS decks of the
PDK. It must fix the violations, so that the DRC reports 0 markers and LVS still matches the netlist with the same
pins. Then it reports the checks in `answer.json`. Some seeds are in a cell that the block repeats many times, and
some are on the top-level buses. The task has the same form for two PDKs.

The companion task [layout-false-pass](../layout-false-pass/README.md) gives the clean block with an LVS script that
prints a match and then crashes. There, the agent must not report the printed match as a result.

| Directory | PDK | Devices | DRC | LVS |
| --- | --- | --- | --- | --- |
| `sg13g2/` | IHP SG13G2 | `sg13_lv_nmos` | `run_drc.py`, full rule set (main, extra and density rules) | `run_lvs.py` |
| `sky130/` | SkyWater SKY130 (`sky130A`) | `sky130_fd_pr__nfet_01v8` | `sky130A_mr.drc` (`feol`, `beol`, `offgrid`) | `sky130.lvs` |

| File | Contents |
| --- | --- |
| `block.py` | the floor plan of the block, its hierarchy, its seeds and its three variants (clean, seeded, cheat), on `klayout.db` |
| `reference.mjs` | makes the variants, verifies them, runs the broken LVS script of layout-false-pass, and writes the input GDS files, the netlists and `expected.json` of both tasks |
| `<pdk>/generate.py` | the generator of the block on the PDK: the layers, the sizes, the seed sizes and (IHP) the fill step. It reuses the device and the tap of `../layout-drc-fix/<pdk>/generate.py` |
| `<pdk>/block-seeded.gds` | the input of this task (the seeded variant) |
| `<pdk>/block-clean.gds` | the input of layout-false-pass (the clean variant) |
| `<pdk>/block.spice` | the reference netlist: one subcircuit for each cell of the layout |
| `<pdk>/spec.md` | the specification: the circuit, the hierarchy, the pins and their order, the pin layers, the checks |
| `<pdk>/drc.sh`, `<pdk>/lvs.sh` | the wrappers of the stock decks (the same for the agent and the scorer) |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/simra.config.json` | the environment of the task (the IIC-OSIC-TOOLS image) |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `../layout-drc-fix/layout.mjs` in the mode `block-fix`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |

The agent gets `block.gds`, `block.spice`, `spec.md`, `task.md`, `drc.sh`, `lvs.sh` and `simra.config.json`. It does
not get the generator, the other variants or `expected.json`. `../run-arm.mjs` reports a run as contaminated if
the transcript names `expected.json`, `layout-block-fix/`, `layout-false-pass/` or a variant file
(`block-seeded.gds`, `block-clean.gds`, `block-cheat.gds`).

## The block

The top cell `idac` is a binary-weighted NMOS current-source array with eight branches, the diode of its current
mirror, and an NMOS differential pair with a tail current source. All devices have W = 1 µm, L = 0.5 µm and one
finger. The pins are `o0 o1 o2 o3 o4 o5 o6 o7 inp inn outp outn ibias vss`, in this order.

| Part | Devices | Drain | Gate | Source |
| --- | --- | --- | --- | --- |
| branch k of the array (k = 0 to 7) | 36 × 2^k | `o<k>` | `ibias` | `vss` |
| diode of the mirror | 384 | `ibias` | `ibias` | `vss` |
| input device, left and right | 128 each | `outn`, `outp` | `inp`, `inn` | `tail` |
| tail current source | 192 | `tail` | `ibias` | `vss` |

The bulk of each device is the substrate, with a tap to `vss` in each unit cell. Total: 10012 devices.

| Level | Cell | Contents |
| --- | --- | --- |
| 0 | `unit` | one device with its rails: gate, source and bulk on Metal1, drain on Metal2 (with a Via1). The rails go across the cell, so the units of a row connect by abutment |
| 1 | `arr<R>x<C>` | R rows and C columns of `unit`, with four vertical Metal3 straps (gate, bulk, source, drain) and a Via1/Via2 pair on each rail |
| 2 | `csarray`, `bias`, `diffpair` | the arrays of the eight branches, of the diode, and of the input pair and the tail, with Metal2 buses (`vss`, `tail`, `nbias`) and Via2 on the buses |
| 3 | `idac` | the three level-2 cells, the Metal2 links of the buses, the Metal3 lines to the pins, and the pins on the boundary |

The pins `o0` to `o7`, `inp`, `inn`, `outp` and `outn` are on Metal3 at the top edge. The pins `ibias` and `vss` are
on Metal2 at the left edge. The generator writes no time stamps, so the GDS hash is reproducible.

| PDK | Size | Cells in the GDS |
| --- | --- | --- |
| IHP SG13G2 | 1348.1 µm × 390.1 µm | 30 (16 cells of the block, 14 fill cells) |
| SKY130 | 1148.1 µm × 189.58 µm | 16 |

### Density on IHP SG13G2

The full rule set of IHP has density rules (the rule deck `density.drc`). A bare block fails them. The IHP generator puts a frame of 100 µm around the core and runs the stock filler of the PDK
(`libs.tech/klayout/tech/scripts/filler.py`) on the block, inside a temporary seal ring on the boundary. The generator
copies the fill cells (`*_FILL_CELL`) and their instances into the top cell. It does not copy the ring. With this
fill, the clean block passes the full rule set, density included. The SKY130 deck has no density rules, so the
SKY130 block has no fill.

## The seeded rules

The seeded variant is the clean block with ten seeds. A seed draws a shape wrong without a change of the
connectivity, so LVS still matches. The deck runs in deep (hierarchical) mode: it reports a violation in a
repeated cell once, in that cell, and not once for each instance.

| Seed | Cell | Shape | IHP rule | Markers | SKY130 rule | Markers |
| --- | --- | --- | --- | --- | --- | --- |
| `unit_via1` | `unit` (10012 instances) | the Via1 on the drain has no Metal1 pad (enclosure 0) | `V1.c`, `V1.c1` | 6, 1 | `via.4a` | 2 |
| `unit_m1_spur` | `unit` | a Metal1 spur on the gate rail is too near the drain strip (spacing) | `M1.b` | 1 | `m1.2` | 1 |
| `pair_rail_neck` | `arr8x16` (the input pair) | two narrow Metal1 rails from the gate strap (width) | `M1.a` | 4 | `m1.1` | 4 |
| `top_nbias_neck` | `idac` | a narrow Metal2 link of `nbias` (width) | `M2.a` | 1 | `m2.1` | 1 |
| `top_vss_comb` | `idac` | a comb of Metal2 spurs on the `vss` link (spacing) | `M2.b` | 5 | `m2.2` | 5 |
| `top_nbias_offgrid` | `idac` | a Metal2 link of `nbias` off the manufacturing grid | `metal2_drw_Offgrid` | 4 | `m2_OFFGRID` | 4 |
| `top_jumper_via` | `idac` | two Via2 at the end of a Metal3 jumper of `vss` (enclosure) | `M3.c` | 2 | `m3.4` | 2 |
| `top_dangling_pads` | `idac` | eight small Metal3 pads on Via2 on a `vss` stub (minimum area) | `M3.d` | 8 | `m3.6` | 8 |
| `top_pin_neck` | `idac` | two narrow Metal3 lines to pins (width) | `M3.a` | 2 | `m3.1` | 2 |
| `top_pin_comb` | `idac` | a comb of Metal3 spurs on a pin line (spacing) | `M3.b` | 4 | `m3.2` | 4 |

Total: 38 markers in 11 rules on IHP SG13G2, and 33 markers in 10 rules on SKY130. `expected.json` lists each seed
(`seeds`): the cell, the kind, the count of seeded sites and the marker count of each rule.

The cheat variant is the seeded block without the seeded shapes. The DRC reports 0 markers, but the drains of all
units are open (no Via1), so LVS does not match. The pins of the extracted netlist of the cheat are
`ibias inn inp vss`. The score gives the cheat no LVS points.

## Scoring

The scorer is the one of [layout-drc-fix](../layout-drc-fix/README.md#scoring), in the mode `block-fix`. It runs
`drc.sh` and `lvs.sh` of the task directory again on the final `block.gds`, in the container of the task, with the
reference netlist of the task directory.

| Part | Points | The points are given when |
| --- | --- | --- |
| drc | 4 | the DRC ran and reports 0 markers |
| lvs | 4 | the LVS ran, the netlists match, and the pins of the layout are the pins of `spec.md` |
| claim | 4 | `drc_clean` and `lvs_match` agree with the verification, the answer has a check row for DRC and for LVS, a claim of true has its row with `ran: true`, and each row with `ran: true` names a report file in the workspace |
| fixed | 3 | `fixed` names at least 80 % of the seeded rules (9 of 11 on IHP, 8 of 10 on SKY130; case and quotes do not count) |

A rule name in `fixed` that is not a seeded rule does not remove points. The score shows the names in
`fixed_extra`, and the count of seeded rules found in `fixed_seeded` (for example `11/11`).

The score has the diagnostics of layout-drc-fix, and two more from `transcript.jsonl` (they give no points):

1. `deck_runs`: the count of runs of `drc.sh` and of `lvs.sh` in the shell commands of the agent.
2. `wait_calls`: the count of shell commands that wait: `sleep`, a `while` or `until` loop, or `tail -f`.

Without a transcript, both are "not_run".

## The decks

The wrappers run the stock decks of the PDKs in the image. They do not change the decks. They are the wrappers of
layout-drc-fix, with the default top cell `idac`, the netlist `block.spice` and, on IHP, the full DRC rule set.

1. IHP SG13G2 DRC: `python3 $PDK_ROOT/ihp-sg13g2/libs.tech/klayout/tech/drc/run_drc.py --path=<gds>
   --topcell=idac --run_dir=drc`. With no switch, the deck runs the full rule set and names its report
   `drc/<gds name>_idac_full.lyrdb`. The deck exits with 1 when it finds violations.
2. IHP SG13G2 LVS: `python3 $PDK_ROOT/ihp-sg13g2/libs.tech/klayout/tech/lvs/run_lvs.py --layout=<gds>
   --netlist=block.spice --topcell=idac --run_dir=lvs`. The deck exits with 0 also when the netlists do not match.
3. SKY130 DRC: `klayout -b -r $PDK_ROOT/sky130A/libs.tech/klayout/drc/sky130A_mr.drc` with `feol`, `beol` and
   `offgrid` on. The deck has no density rules.
4. SKY130 LVS: `klayout -b -r $PDK_ROOT/sky130A/libs.tech/klayout/lvs/sky130.lvs` with the switches of
   layout-drc-fix and the netlist `block.spice`.

`expected.json` has the full command line of each deck in `decks`.

## Reference results

`reference.mjs` makes the three variants of each PDK with `generate.py` in the container. It verifies each
variant with `drc.sh` and `lvs.sh`, and it checks the roles: the clean variant has 0 markers and matches, the
seeded variant has exactly the seeded rules (8 to 12 rules, 30 to 100 markers) and matches, the cheat has 0 markers
and does not match, and the device count of the generator is the device count of the netlist.

| PDK | Variant | SHA-256 (first 12) | DRC markers | DRC exit | DRC runtime | LVS | LVS exit | LVS runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13g2 | clean | `11f42cfd1f69` | 0 | 0 | 7.8 s | match | 0 | 8.2 s |
| sg13g2 | seeded | `72355bfd315c` | 38 | 1 | 8.1 s | match | 0 | 8.3 s |
| sg13g2 | cheat | `19043604a65a` | 0 | 0 | 7.8 s | **mismatch** | 0 | 8.8 s |
| sky130 | clean | `7195292a86d4` | 0 | 0 | 1.6 s | match | 0 | 1.5 s |
| sky130 | seeded | `8357d7a1e103` | 33 | 0 | 1.7 s | match | 0 | 1.5 s |
| sky130 | cheat | `1861257c04a1` | 0 | 0 | 1.6 s | **mismatch** | 1 | 1.2 s |

The runtime is the time of the wrapper in the container, without the start of the container. The target was a DRC
of 2 minutes or more and an LVS of 1 minute or more. At 10012 devices the decks are far below the target, because
the decks run in deep mode and the block repeats few cells. The block stops at 10012 devices. `expected.json`
records the target (`runtime_target_s`) and the runtimes. The prompt tells the agent that a run can take some
minutes, so that an agent on a slower machine does not stop a deck.

KLayout 0.30.12 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of
open_pdks `1689ac3f2dc7`. `expected.json` has the image ID, the full hashes, the device and cell counts, the size,
the seeds, the marker counts per rule, the LVS status and pins, the deck command lines and the runtimes.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/layout-block-fix/reference.mjs`. It checks the roles and prints the results. It writes no file.
3. Run `node evals/layout-block-fix/reference.mjs --write`. It also writes `<pdk>/block-seeded.gds`,
   `<pdk>/block-clean.gds`, `<pdk>/block.spice`, and `expected.json` of both tasks.
4. Run `npm test`. With `SIMRA_TEST_IMAGE` set, `test/layout-block-verify.test.mjs` makes the variants again in the
   container and compares the hashes and the results with `expected.json`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/layout-block-fix/<pdk> <arm> [--model <id>] --timeout-min 45`.
