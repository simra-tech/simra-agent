# Demo evaluation: read the progress table of a repair before naming a cause

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets a bank of shift registers (12,000 flip-flops, see
[examples/shreg-sg13g2](../../examples/shreg-sg13g2/README.md)) with a hold uncertainty of 0.70 ns and a run of
record. The hold repair after the clock tree synthesis ends with "Unable to repair all hold checks within margin"
and hold violations remain. A review note says that the repair cannot close the block. The agent must find the
cause and find out if the repair can close the block with no change of the constraints.

The seeded mechanism: the repair made one pass for each violating end point (11976 end points, 11976 buffers) and
stopped with a worst slack of -0.40 ns. A second repair of its output ends with no negative slack. A right answer
names the cause `pass_limit` and shows a repair run without violations.

The harness functions for this task: the openroad adapter, operation `parse` (the pattern of the repair table), and
the librelane adapter, operation `replay` with `state_in` (a second repair pass).

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `prepare.sh` | makes the workspace in the tool image before the agent starts (the run of record, the history) |
| `expected.json` | the reference values and tolerances |
| `score.mjs` | the scorer for one workspace: points for each part and `pass` |
| `task.json` | the task manifest for `../run-arm.mjs` |

## Run

```
node evals/run-arm.mjs evals/flow-repair-progress simra --model <provider/model> --runs <dir> --timeout-min 15
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** Each run had 2 CPUs, pinned in the container.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 3 | 64 | 3.27 M | 744 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 53 | 2.34 M | 488 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 30 | 1.26 M | 348 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 14 | 0.36 M | 130 s |

Result: the passes are the same in the two arms. The treatment arm used fewer model calls, fewer tokens and less time. Runs that started before the CPU pin was corrected are not in the table.
