# Demo evaluation: write a hand-off record in limited time without a wrong claim

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets the block of [examples/acc-sg13g2](../../examples/acc-sg13g2/README.md) with a review decision
(set `CTS_DELAY_BUFFER_DERATE_PCT` to 50) and must write the hand-off record after the global routing: did the
decision change the result, the number of clock buffers, the worst setup slack of each corner with the wires of the
global route, and whether the setup timing is met. The session limit is 13 minutes.

The task joins the mechanisms of [flow-setting-effect](../flow-setting-effect/README.md) and
[flow-evidence-level](../flow-evidence-level/README.md): the setting changes nothing, the old run in the workspace
is of an earlier RTL, and the metrics of the run repeat the no-wire numbers of the slow and the fast corner. Each
question alone is asked directly in those two tasks. Here the questions are parts of one record.

The harness functions for this task: the librelane adapter, operations `read`, `compare` and `replay`, and the
flow check of the pi extension.

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `prepare.sh` | makes the workspace in the tool image before the agent starts (the run of record, the history) |
| `expected.json` | the reference values and tolerances |
| `score.mjs` | the scorer for one workspace: points for each part and `pass` |
| `task.json` | the task manifest for `../run-arm.mjs` |

## Run

```
node evals/run-arm.mjs evals/flow-handoff simra --model <provider/model> --runs <dir> --timeout-min 13
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** Each run had 2 CPUs, pinned in the container.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 5 | 81 | 4.89 M | 523 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 28 | 1.43 M | 246 s |
| treatment (digital arm) | deepseek-flash | 5 of 5 | 27 | 0.96 M | 286 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 21 | 0.59 M | 181 s |

Result: two baseline runs of `deepseek-flash` failed. One run reported that the setting changed the result and did not analyse the slow and the fast corner. One run reported the no-wire numbers of the slow and the fast corner as global-route numbers, and reported the setup timing as met. All treatment runs pass. One run that started before the CPU pin was corrected is not in the table.
