# Demo evaluation: fix the DRC violations of a flat analog block with long deck runs

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is [layout-block-fix](../layout-block-fix/README.md) on a flat layout. The block has the same circuit,
pins, specification and seeds, but the generator flattens the hierarchy into the top cell. On a flat layout, the
stock KLayout decks cannot reuse the results of a repeated cell, so a run takes minutes and not seconds. The task
gives a baseline for the behaviour of an agent with a long deck run: does it wait in the foreground, start the deck
in the background, read the logs, or time out.

| Directory | PDK | DRC | LVS |
| --- | --- | --- | --- |
| `sg13g2/` | IHP SG13G2 | `run_drc.py`, full rule set (the main, density and `sg13g2_maximal` checks) | `run_lvs.py` |
| `sky130/` | SkyWater SKY130 (`sky130A`) | `sky130A_mr.drc` (`feol`, `beol`, `offgrid`) | `sky130.lvs` |

| File | Contents |
| --- | --- |
| `reference.mjs` | makes the variants, verifies them, runs the klayout adapter, and writes the netlist, the input GDS and `expected.json` |
| `<pdk>/generate.py` | the generator of the flat block: the block of `../layout-block-fix/<pdk>/generate.py` with the flat mode of `../layout-block-fix/block.py` |
| `<pdk>/flat-seeded.gds` | the input of the task (the seeded variant). It is too large to commit: `reference.mjs` makes it (see below) |
| `<pdk>/block.spice` | the flat reference netlist: one subcircuit `idac` with every device |
| `<pdk>/spec.md` | the specification: the circuit, the layout, the pins and their order, the pin layers, the checks |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/expected.json` | the reference results, the runtimes and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `../layout-drc-fix/layout.mjs` in the mode `block-fix`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs`, with the hash of the generated GDS |

The task uses the wrappers `drc.sh` and `lvs.sh` and the configuration `simra.config.json` of
`../layout-block-fix/<pdk>/`, with no change. The agent gets `block.gds`, `block.spice`, `spec.md`, `task.md`,
`drc.sh`, `lvs.sh` and `simra.config.json`. It does not get the generator, the other variants or `expected.json`.
`../run-arm.mjs` reports a run as contaminated if the transcript names `expected.json`, `layout-long-job/` or a
variant file (`flat-seeded.gds`, `flat-clean.gds`, `flat-cheat.gds`).

## The block

The circuit, the pins, the pin order and the pin layers are the ones of layout-block-fix. Two things are different:

1. The layout is flat. `../layout-block-fix/block.py` builds the hierarchy of layout-block-fix and then copies
   every shape into the top cell `idac`. The GDS has one cell and no instances. On IHP SG13G2, the fill of the
   frame is flat in the top cell too.
2. The array is larger. Branch k of the current-source array has 81 × 2^k devices, not 36 × 2^k: the generator
   multiplies the base shapes of the branches by `SCALE = (9, 9)`, not by (6, 6). The diode, the input pair and
   the tail do not change. The device count is 255 × 9 × 9 + 832 = 21487.

| PDK | Devices | Size | Cells in the GDS | GDS size |
| --- | --- | --- | --- | --- |
| IHP SG13G2 | 21487 | 1753.1 µm × 476.5 µm | 1 | 60.7 MB |
| SKY130 | 21487 | 1553.1 µm × 275.98 µm | 1 | 47.3 MB |

The reference netlist `block.spice` is flat too: one subcircuit `idac` with one device line for each device. The
stock LVS of both PDKs accepts it.

### Why 21487 devices

The target was: on each PDK, at least one deck takes 3 minutes or more, and one eval run (two DRC runs and one LVS
run) takes at most 12 minutes of deck time, on an idle host. The size is the same on both PDKs.

1. SKY130: the DRC does not get to 3 minutes below 40000 devices. At 37552 devices (`SCALE = (12, 12)`) it took
   109 s under load. So the size comes from the LVS, which must take 3 to 5 minutes. At 10012 devices the LVS
   took 177 s under load, so it takes less than 3 minutes on an idle host. At 37552 devices it took 1505 s. At
   21487 devices it took 578 s to 790 s under load (load average 21 to 56). The runtime on an idle host is not
   measured yet. Thus it is not known yet if the LVS is in the range of 3 to 5 minutes on an idle host.
2. IHP SG13G2: the size cannot be much larger. At 37552 devices the Metal2 density of the block is 34.4 %, and the
   full rule set reports `M2.j` (minimum global density 35 %). The fill is only in the frame, so the density goes
   down as the core gets larger. At 21487 devices the Metal2 density is 36.5 %, and the clean block passes.

`SCALE = (8, 8)` does not work: the arrays of the input pair (8 × 16) then have the shape of a branch.

## The seeds

The seeds are the ten seeds of layout-block-fix. The generator draws them after it flattens the block. In
layout-block-fix the deck reports a seed of a repeated cell once, in that cell. In the flat block, the generator
draws such a seed on a few copies only, and the deck reports each copy.

| Seed | Copies with the seed | IHP rule | Markers | SKY130 rule | Markers |
| --- | --- | --- | --- | --- | --- |
| `unit_via1` | 4 of 21487 units | `V1.c`, `V1.c1` | 24, 4 | `via.4a` | 8 |
| `unit_m1_spur` | 4 of 21487 units | `M1.b` | 4 | `m1.2` | 4 |
| `pair_rail_neck` | 1 of the 2 arrays of the input pair | `M1.a` | 4 | `m1.1` | 4 |
| `top_nbias_neck` | (top cell) | `M2.a` | 1 | `m2.1` | 1 |
| `top_vss_comb` | (top cell) | `M2.b` | 5 | `m2.2` | 5 |
| `top_nbias_offgrid` | (top cell) | `metal2_drw_Offgrid` | 4 | `m2_OFFGRID` | 4 |
| `top_jumper_via` | (top cell) | `M3.c` | 2 | `m3.4` | 2 |
| `top_dangling_pads` | (top cell) | `M3.d` | 8 | `m3.6` | 8 |
| `top_pin_neck` | (top cell) | `M3.a` | 2 | `m3.1` | 2 |
| `top_pin_comb` | (top cell) | `M3.b` | 4 | `m3.2` | 4 |

Total: 62 markers in 11 rules on IHP SG13G2, and 42 markers in 10 rules on SKY130. The seeded variant matches LVS.
`expected.json` lists each seed (`seeds`): the cell, the cell of the seed before the flattening (`from_cell`), the
count of copies and of seeded copies, the positions, and the marker count of each rule.

The cheat variant is the seeded block without the seeded shapes. Some seeded shapes are necessary connections (for
example the Via1 on the drain of the 4 seeded units), so the cheat has opens. The DRC reports 0 markers. LVS does
not match: the pins of the extracted netlist do not include `o2` and `outp`.

## Scoring

The scorer is the one of [layout-block-fix](../layout-block-fix/README.md#scoring), with the same points. It runs
`drc.sh` and `lvs.sh` again on the final `block.gds`, so the scoring of one workspace takes one DRC run and one LVS
run.

The score report has five diagnostics from `transcript.jsonl` for the long decks (they give no points):

1. `deck_runs`: the runs of `drc.sh` and of `lvs.sh`, and in `deck_runs.run_experiment` the `run_experiment` calls
   of the `klayout` adapter for `drc` and for `lvs`.
2. `wait_calls`: the shell commands that wait: `sleep`, a `while` or `until` loop, or `tail -f`.
3. `background_runs`: the shell commands that start a deck in the background (with `&`, `nohup`, `setsid` or
   `disown`), and the calls of a job tool (a tool with `job`, `background` or `detach` in its name) that name a
   deck.
4. `log_reads`: the shell commands that read a deck log or report: `tail`, `cat`, `grep` or `wc` on a file under
   `drc/`, `lvs/` or `simra/experiments/`.
5. `deck_wall_s`: the sum of the run times of the tool calls that run a deck. The run time of a call is the time
   between the tool call and its result in the transcript. **The Codex CLI transcript has no time stamps, so
   `deck_wall_s` is null for the Codex arm.** It is a number for the pi and OpenCode arms.

Without a transcript, the five diagnostics are "not_run". A poll of a running Codex session (`write_stdin`) is not
a shell command, so `wait_calls` does not count it.

## The decks

The wrappers are the ones of layout-block-fix, with no change. They run the stock decks of the PDKs in the image.
`expected.json` has the command line of each wrapper in `decks`.

1. IHP SG13G2 DRC: `run_drc.py` with the full rule set. It runs three groups of checks one after the other: the
   main checks, the density checks and the `sg13g2_maximal` checks.
2. IHP SG13G2 LVS: `run_lvs.py`.
3. SKY130 DRC: `sky130A_mr.drc` with `feol`, `beol` and `offgrid` on, and 4 threads.
4. SKY130 LVS: `sky130.lvs` in deep mode, with 4 threads and `schematic_simplify=true`.

### Why the decks are slow on this block

The decks run in deep (hierarchical) mode. In deep mode, KLayout checks a repeated cell once and uses the result for
each instance. A flat layout has no repeated cell, so the deck checks every shape in the top cell. These times are
from one run of the seeded block under load (load average about 55):

1. IHP SG13G2 DRC (414 s): the main checks took 145 s, the density checks 27 s and the `sg13g2_maximal` checks
   240 s. The layout has 923070 polygons.
2. SKY130 LVS (790 s): the extraction took 66 s, and the netlist comparison took 714 s. The comparison grows faster
   than the device count: 177 s at 10012 devices, 790 s at 21487 devices, 1505 s at 37552 devices (all under load).
3. IHP SG13G2 LVS (99 s) and SKY130 DRC (78 s) are the short decks.

## The klayout adapter

`reference.mjs` also runs the `klayout` adapter on the seeded block, with the kernel runner, as the
`run_experiment` tool runs it: `drc` with the default rule set of the technology pack, and `lvs`. The adapter gives
the marker count, the count of each rule and the LVS status of the wrappers. `expected.json` has the adapter
results and runtimes in `adapter`. No technology pack changed for this task.

## Reference results

**All runtimes in this section and in `expected.json` are measured under load (load average 55.75).** The host had
other jobs. The runtimes on an idle host are shorter. They are not measured yet.

The runtime is the time of the wrapper in the container, without the start of the container. KLayout 0.30.12 in
the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of open_pdks `1689ac3f2dc7`.

| PDK | Variant | SHA-256 (first 12) | DRC markers | DRC exit | DRC runtime | LVS | LVS exit | LVS runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13g2 | clean | `c28dbc5b2991` | 0 | 0 | 427.7 s | match | 0 | 97.3 s |
| sg13g2 | seeded | `fa714ad96f8c` | 62 | 1 | 391.8 s | match | 0 | 79.8 s |
| sg13g2 | cheat | `7fc0b1a4d24f` | 0 | 0 | 340.7 s | **mismatch** | 0 | 90.8 s |
| sky130 | clean | `64d528235782` | 0 | 0 | 76.4 s | match | 0 | 704.2 s |
| sky130 | seeded | `0d9d8c11fe97` | 42 | 0 | 72.9 s | match | 0 | 599.8 s |
| sky130 | cheat | `d5a75553420a` | 0 | 0 | 68.2 s | **mismatch** | 1 | 592.6 s |

| PDK | Adapter DRC (seeded) | Adapter LVS (seeded) | Longer deck (shortest run) | Eval deck time (2 DRC + 1 LVS, longest runs) |
| --- | --- | --- | --- | --- |
| sg13g2 | 62 markers, 339.5 s | match, 81.0 s | DRC, 340.7 s | 952.7 s |
| sky130 | 42 markers, 59.4 s | match, 591.3 s | LVS, 592.6 s | 857.1 s |

Under load, the eval deck time is more than 12 minutes on both PDKs, so `runtimes.in_target` is false. The target
is for an idle host. `expected.json` records the target (`runtime_target_s`), the runtimes (`runtimes`), the load
at the start and at the end of the run (`host_load_1min`), and the text "measured under load (load average N)" in
`runtimes.measured` and `adapter.measured`.

## Make the input and the results again

The input GDS of the task (`<pdk>/flat-seeded.gds`, about 50 MB) is not committed. `task.json` gives its SHA-256
and the command that makes it (`generated`). `../run-arm.mjs` stops if the file is missing or has a different
hash.

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/layout-long-job/reference.mjs <pdk> --gds`. It makes `<pdk>/flat-seeded.gds` in the container
   and checks its hash. This takes some seconds.
3. To make the reference results again, run `node evals/layout-long-job/reference.mjs`. It checks the roles and
   the adapter, and it prints the results. It writes no file. It runs 8 decks for each PDK, so it takes some tens
   of minutes.
4. Run `node evals/layout-long-job/reference.mjs --write` on an idle host (1-min load average under 10). It also
   writes `<pdk>/flat-seeded.gds`, `<pdk>/block.spice`, `<pdk>/expected.json` and the hash in `<pdk>/task.json`.
   It stops if the host was not idle. `--write --loaded` writes on a loaded host and marks the runtimes as
   measured under load.
5. Run `npm test`. With `SIMRA_TEST_IMAGE` set, `test/layout-long-job-container.test.mjs` makes the variants again
   in the container and compares the hashes, the counts, the LVS status and the adapter with `expected.json`. It
   checks the runtimes against the target only on an idle host. On a loaded host, that check is skipped.

## A long command in the shell tool of the arms

The task measures what the agent does with a deck that runs for minutes. The shell tools of the two arms handle a
long command in different ways. This section is from the documentation, the code and the binaries of the tools.
No arm was run for it.

### pi (`bash` tool, `@earendil-works/pi-coding-agent` 1.4.0)

1. The tool has a `timeout` parameter in seconds: "Timeout in seconds (optional, no default timeout)". Without
   `timeout`, the call waits until the command stops. A 4-minute deck blocks the call for 4 minutes.
2. The tool starts the command in its own process group. It streams the output to the agent as the command runs,
   and it gives the agent the last 2000 lines or 50 KB of the output. The full output goes to a temporary file.
3. When the timeout comes first, the tool stops the process group, and the call fails with "Command timed out
   after N seconds". So a model that sets a timeout shorter than the deck loses the deck run.
4. A command that ends with `&` returns at once. The deck continues in the background, and the agent must read
   its log or wait for it with a second command. pi stops these background processes when the session ends.

The models in the layout-block-fix runs set a timeout of 900 s or 1200 s on each deck call.

### Codex CLI (`exec_command` tool, 0.166.0)

1. The arm runs `codex exec --json`. The shell tool is `exec_command` (unified exec, on by default). It runs the
   command in a PTY.
2. The call waits `yield_time_ms` (default 10000 ms, at most 30000 ms). If the command is still running then, the
   call returns the output so far and a session ID. The command continues.
3. The model polls the session with `write_stdin` and empty `chars`. A poll waits up to 300000 ms (5 min) for
   more output. So a 4-minute deck takes one `exec_command` call and one or more polls.
4. Without unified exec, the shell tool has `timeout_ms`, with a default of 10000 ms.

How the `--json` event stream shows a running session and its polls was not checked (not run). The Codex events
have no time stamps, so `deck_wall_s` is null for the Codex arm.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Run `node evals/layout-long-job/reference.mjs <pdk> --gds` to make the input GDS.
4. Put the key variable of the model in the environment or in `.env` in the repository root.
5. Run `node evals/run-arm.mjs evals/layout-long-job/<pdk> <arm> [--model <id>] --timeout-min 60`.
