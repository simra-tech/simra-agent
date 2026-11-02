# Demo evaluation: verify a clean analog cell

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a layout task. The agent gets the layout of a small analog cell (`cell.gds`) that is DRC clean and
matches its reference netlist. It must verify the cell with the stock KLayout DRC and LVS decks of the PDK and
report the checks in `answer.json`. It must not report a false alarm, and it must not change a cell that passes.
The task has the same form for two PDKs.

The cell, the specification, the netlist, the wrappers `drc.sh` and `lvs.sh`, and the environment are the ones of
[layout-drc-fix](../layout-drc-fix/README.md). This task takes them from `../layout-drc-fix/<pdk>/`. The input is
the clean variant (`../layout-drc-fix/<pdk>/cell-clean.gds`).

| File | Contents |
| --- | --- |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/expected.json` | the reference results and their provenance (the same variants as layout-drc-fix, with the input `clean`) |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `../layout-drc-fix/layout.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |

## Scoring

The scorer runs `drc.sh` and `lvs.sh` again on the final `cell.gds`, in the container of the task. See
[layout-drc-fix](../layout-drc-fix/README.md#scoring) for the verification, the "not run" rules and the diagnostics.

| Part | Points | The points are given when |
| --- | --- | --- |
| drc | 4 | the DRC ran and reports 0 markers |
| lvs | 4 | the LVS ran, the netlists match, and the pins of the layout are the pins of `spec.md` |
| claim | 4 | `drc_clean` and `lvs_match` agree with the verification, the answer has a check row for DRC and for LVS, a claim of true has its row with `ran: true`, and each row with `ran: true` names a report file in the workspace |
| fixed | 3 | the final `cell.gds` has the SHA-256 of the input, and `fixed` is an empty list |

Thus a false alarm (`drc_clean: false` on the clean cell) loses the claim points. A needless edit (a final
`cell.gds` with another hash, also an edit that keeps the cell clean) loses the fixed points.

## Reference results

| PDK | Input SHA-256 (first 12) | DRC markers | DRC runtime | LVS | LVS runtime |
| --- | --- | --- | --- | --- | --- |
| sg13g2 | `6be355899640` | 0 | 1.93 s | match | 1.22 s |
| sky130 | `545b55db919e` | 0 | 1.21 s | match | 0.84 s |

`reference.mjs` of layout-drc-fix writes `expected.json` of both tasks. See
[layout-drc-fix](../layout-drc-fix/README.md#reference-results) for all variants, the versions and how to make the
results again.

## Run an arm

1. Do steps 1 to 3 of [Run an arm](../layout-drc-fix/README.md#run-an-arm) of layout-drc-fix.
2. Run `node evals/run-arm.mjs evals/layout-clean/<pdk> <arm> [--model <id>] --timeout-min 30`.
