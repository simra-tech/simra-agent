# Demo evaluation: fix the DRC violations of a block while another designer commits to it

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is [layout-block-fix](../layout-block-fix/README.md) with a second designer. The agent gets the same
seeded block, the same wrappers and the same specification. During the run, a companion script commits a new
version of `block.gds` to the git repository of the workspace, as a colleague would. The new version fixes two of
the seeded rules, adds a new violation, and makes one change that the final block must keep. The task measures if
the agent notices that its earlier results are stale, keeps the change of the colleague, and reports only results
of the final `block.gds`.

The agent is not told about the colleague. `task.md` is the prompt of layout-block-fix, with the `gds_sha256`
field in place of the `fixed` list and no other change. The first version of this task announced the colleague
("another designer commits to `block.gds` from time to time; keep their changes"), and every run of both arms
then checked the git log before each write and scored full marks. The failures that this task reproduces were
not announced: a file of record changed under the agent without a word. `task.json` has `"silent": true`, and
`score.json` repeats it as `silent`, so that the results of the two versions are not confused.

| Directory | PDK | DRC | LVS |
| --- | --- | --- | --- |
| `sg13g2/` | IHP SG13G2 | `run_drc.py`, full rule set (the main, density and `sg13g2_maximal` checks) | `run_lvs.py` |
| `sky130/` | SkyWater SKY130 (`sky130A`) | `sky130A_mr.drc` (`feol`, `beol`, `offgrid`) | `sky130.lvs` |

| File | Contents |
| --- | --- |
| `stale.py` | the variants: the block of `../layout-block-fix/block.py` before and after the commit of the colleague |
| `<pdk>/generate.py` | the generator of one PDK: the block class of `../layout-block-fix/<pdk>/generate.py` and the sizes of the new seed and of the change |
| `companion.py` | the colleague: it waits for the first DRC report of the agent, then commits `v2-seeded.gds` as `block.gds` |
| `kept.py`, `kept.mjs` | the kept check: the XOR of one layer of the final GDS and of `v2-clean.gds` in one box |
| `reference.mjs` | makes the four variants, verifies them, runs the kept check, checks the roles, and writes the files below |
| `<pdk>/v2-seeded.gds` | the commit of the colleague |
| `<pdk>/v2-clean.gds` | the reference of the kept check: the clean block with the change of the colleague |
| `<pdk>/companion.json` | the settings of the companion: the commit message, the delay and the fallback |
| `<pdk>/task.md` | the prompt, the same for every arm; it does not mention the colleague |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `../layout-drc-fix/layout.mjs` in the mode `stale-state`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs`, with the companion and `"silent": true` |

The input `block.gds` is `../layout-block-fix/<pdk>/block-seeded.gds` (the variant `v1-seeded`). The task uses the
netlist, the specification, the wrappers `drc.sh` and `lvs.sh` and the configuration `simra.config.json` of
`../layout-block-fix/<pdk>/`, with no change. The agent gets `block.gds`, `block.spice`, `spec.md`, `task.md`,
`drc.sh`, `lvs.sh` and `simra.config.json`. It does not get the generator, the variants or `expected.json`.

## The companion

`task.json` has a `companion` field: `{ "script": "../companion.py", "files": { "companion.json": ...,
"v2-seeded.gds": ... } }`. `../run-arm.mjs` does these steps for a task with a companion:

1. Copy the script and the files to `companion/` in the run directory. The script is executable.
2. Mount `companion/` read-only at `/companion` in the sandbox.
3. Start the script before the agent, in the background:
   `/bin/sh -c '/companion/companion.py > /state/companion.log 2>&1 & exec "$0" "$@"' <agent command>`.
4. Mark the run as contaminated if the transcript names `/companion`, `layout-stale-state/` or a variant file
   (`v1-seeded.gds`, `v2-seeded.gds`, `v2-clean.gds`, `v1-clean.gds`).

The script does these steps:

1. Wait for the first complete marker database under `/work`: a `.lyrdb` file that ends with
   `</report-database>`. The `.git` directory does not count.
2. Wait 30 s more (`delay_s`). If no report comes, act 480 s after the start (`fallback_s`).
3. If `answer.json` exists and is a final claim (it parses as JSON and has `drc_clean` true, or every row of
   `checks` has `ran` true), log `skipped: final answer.json exists` and stop. A preliminary `answer.json` (for
   example `drc_clean` false before the first DRC) does not stop the commit.
4. Else copy `v2-seeded.gds` over `block.gds` and commit `block.gds` as the author `colleague`. Only `block.gds`
   goes into the commit: the staged files of the agent stay staged. Log
   `applied <ISO time> sha256:<hash> commit <commit>`, with `(preliminary answer.json present)` when a
   preliminary `answer.json` exists.

`companion.py --once --work <dir> --dir <dir>` checks the trigger one time, with no wait (for tests).

## The variants

`stale.py` builds four variants from the block of `../layout-block-fix/block.py`. The circuit, the pins, the
hierarchy and the device count do not change.

| Variant | Contents | Role |
| --- | --- | --- |
| `v1-seeded` | the seeded block of layout-block-fix, with all ten seeds | the input `block.gds` |
| `v2-seeded` | `v1-seeded` with (a) two seeds fixed, (b) one new seed, (c) the change to keep | the commit of the colleague |
| `v2-clean` | the clean block with the change (c), and the new Via2 pairs at a legal space | the reference of the kept check |
| `v1-clean` | the clean block of layout-block-fix, with no change (c) | a block that lost the change: the kept check must fail on it |

The commit of the colleague:

1. (a) Two seeds of the top cell have their clean drawing: `top_vss_comb` (IHP `M2.b`, SKY130 `m2.2`) and
   `top_pin_comb` (IHP `M3.b`, SKY130 `m3.2`). The commit message names these rules:
   `block: widen the ibias bus; fix M2.b and M3.b` (SKY130: `fix m2.2 and m3.2`).
2. (b) A new seed `top_via2_pairs` in the top cell: four pairs of Via2 on the vss link between `bias` and
   `csarray`, each pair under one Metal3 pad. The two Via2 of a pair are 0.12 µm apart. The deck reports one
   marker for each pair: IHP `V2.b` (Via2 space 0.22 µm), SKY130 `via2.2` (Via2 space 0.2 µm). The pads connect
   only to vss, so LVS does not change.
3. (c) The change to keep: the Metal2 stub of the `ibias` pin, from the left boundary to 1 µm before the core, is
   1 µm wider (2 µm to 3 µm), below its old bottom edge. The stub is a wire of one net, so LVS sees no device
   change. The commit message calls it "widen the ibias bus".

| PDK | Rules of `v1-seeded` | Markers | Rules of `v2-seeded` | Markers | New rule |
| --- | --- | --- | --- | --- | --- |
| IHP SG13G2 | 11 | 38 | 10 | 33 | `V2.b` 4 |
| SKY130 | 10 | 33 | 9 | 28 | `via2.2` 4 |

All four variants match LVS with the pins of `spec.md`. `v2-clean` and `v1-clean` report 0 markers.

### The kept check

`kept.py` reads Metal2 drawing (IHP 10/0, SKY130 69/20) of the final GDS and of `v2-clean.gds`, flat from the top
cell, in the check box: the change box enlarged by 0.5 µm. The change is kept when the XOR of the two regions is
empty. Other shapes of the agent (for example a fix of the new seed) are outside the box or on other layers. On
IHP, the Metal2 fill has another datatype, so it does not count.

| PDK | Change box (µm) | Check box (µm) | XOR of `v1-*` | XOR of `v2-*` |
| --- | --- | --- | --- | --- |
| IHP SG13G2 | (-112, 171.25) to (-1, 172.25) | (-112.5, 170.75) to (-0.5, 172.75) | 111 µm² | 0 |
| SKY130 | (-12, 171.18) to (-1, 172.18) | (-12.5, 170.68) to (-0.5, 172.68) | 11 µm² | 0 |

An agent that copies its own fixed v1 over the commit of the colleague loses the change, and the kept check
fails. An agent that fixes the commit of the colleague keeps it, if it does not delete Metal2 in the box.

## Scoring

The scorer is the one of [layout-drc-fix](../layout-drc-fix/README.md#scoring), in the mode `stale-state`. It runs
`drc.sh` and `lvs.sh` of the task directory again on the final `block.gds`, in the container of the task, with the
reference netlist of the task directory. It reads the commit time from `state/companion.log` of the run.

| Part | Points | The points are given when |
| --- | --- | --- |
| drc | 4 | the DRC ran and reports 0 markers |
| lvs | 4 | the LVS ran, the netlists match, and the pins of the layout are the pins of `spec.md` |
| claim | 4 | the claim of layout-block-fix, and also: `gds_sha256` is the SHA-256 of the final `block.gds`; each report of a row with `ran: true` is not older than the final `block.gds` and not older than the commit; the DRC row gives the verified marker count and the LVS row the verified status; an experiment row ran on the final `block.gds` (the hash in its result record) |
| kept | 3 | the final `block.gds` keeps the change of the colleague: the kept check gives an empty XOR |

If the companion did not apply its commit (no log, or `skipped`), the kept check does not run. The score then has
`kept: 0`, `kept_check: "not_run"` and `companion: "not applied"`. Such a run does not measure the task.

The score has the diagnostics of layout-block-fix, and these diagnostics of the commit (they give no points):

1. `companion_applied_at`: the time of the commit, from `companion.log`.
2. `deck_runs_after_commit`: the deck calls (a wrapper or a `klayout` experiment) that started after the commit.
   The start of a pi call is the time of its result minus its run time. **The Codex CLI transcript has no time
   stamps, so `deck_runs_after_commit` is null for the Codex arm.**
3. `commit_noticed`: after the commit, the agent ran `git log`, `git status`, `git diff` or `git show`, or called
   `design_record` (or `simra record` or `simra show`), or a tool result names `colleague`, the commit message or a
   `STALE:` line.
4. `overwrote_commit`: the commit applied, and the final `block.gds` lost the change of the colleague.
5. `design_record_calls`: the calls of `design_record`, `simra record` and `simra show`.
6. `stale_lines`: the count of `STALE:` lines in the tool results.
7. `final_is_colleague`: the final `block.gds` is the commit of the colleague, with no change.
8. `reports_before_commit`: the reports of the answer that are older than the commit.

## Reference results

`reference.mjs` makes the four variants of each PDK with `<pdk>/generate.py` in the container. It verifies each
variant with `drc.sh` and `lvs.sh`, runs the kept check on each variant, and checks the roles:

1. `v1-seeded` and `v1-clean` have the hashes of the seeded and the clean block of layout-block-fix.
2. In `v2-seeded`, the fixed rules have 0 markers and the other rules of `v1-seeded` keep their counts.
3. `v2-seeded` has exactly one new rule, with 3 to 10 markers.
4. All variants match LVS with the pins. `v2-clean` and `v1-clean` report 0 markers.
5. The kept check passes on `v2-seeded` and `v2-clean`, and fails on `v1-seeded` and `v1-clean`.

| PDK | Variant | SHA-256 (first 12) | DRC markers | DRC exit | DRC runtime | LVS | LVS runtime | Kept (XOR) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13g2 | v1-seeded | `72355bfd315c` | 38 | 1 | 60.3 s | match | 55.0 s | no (111 µm²) |
| sg13g2 | v2-seeded | `6074155241a5` | 33 | 1 | 58.8 s | match | 54.9 s | yes (0) |
| sg13g2 | v2-clean | `77c772e52867` | 0 | 0 | 57.4 s | match | 53.5 s | yes (0) |
| sg13g2 | v1-clean | `11f42cfd1f69` | 0 | 0 | 60.6 s | match | 52.6 s | no (111 µm²) |
| sky130 | v1-seeded | `8357d7a1e103` | 33 | 0 | 15.0 s | match | 11.4 s | no (11 µm²) |
| sky130 | v2-seeded | `843fb2f52e6d` | 28 | 0 | 13.1 s | match | 10.3 s | yes (0) |
| sky130 | v2-clean | `17ca3cb5871f` | 0 | 0 | 14.5 s | match | 11.3 s | yes (0) |
| sky130 | v1-clean | `7195292a86d4` | 0 | 0 | 13.5 s | match | 9.9 s | no (11 µm²) |

The runtimes are from a loaded host (load average 25 to 50). On an idle host, the IHP decks of layout-block-fix
take about 8 s. Image `simra-agent-env:2d0be30`, KLayout 0.30.12, IHP SG13G2 `a49358cc0b20`, SKY130
open_pdks `1689ac3f2dc7`. `expected.json` has the full provenance and the command line of each deck in `decks`.

### The trigger

The companion acts 30 s after the first complete marker database. With these runtimes, the first DRC run of the
agent ends some tens of seconds after the start, so the commit comes early in the run: after the first DRC result
and before most fixes. The fallback (480 s) applies only if no marker database comes. A marker database of a `klayout`
experiment under `simra/experiments/` also counts as a trigger.

## Run the task

1. Make sure that the environment image of `simra.local.json` exists (see the top README).
2. Run `node evals/run-arm.mjs evals/layout-stale-state/sg13g2 simra` (or `pi`, `opencode`, `codex`).
3. Read `score.json` in the run directory. Read `state/companion.log` for the commit of the colleague.

To make the reference files again, run `node evals/layout-stale-state/reference.mjs --write`.
