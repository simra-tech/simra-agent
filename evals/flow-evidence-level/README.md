# Demo evaluation: report a timing number at the level that the question asks for

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets the block of [examples/acc-sg13g2](../../examples/acc-sg13g2/README.md) and a run of the flow to
the timing analysis after the global routing. It must report the worst setup slack of each corner with the wires of
the global route.

The seeded mechanism: the timing steps between the layout steps analyse the typical corner only. The metrics of the
run still show a slack for the slow and the fast corner: the numbers of the timing step before the layout, without
wires. With the wires of the global route, the slow corner fails (-1.35 ns); the carried-over number is +0.95 ns.
A right answer has its own timing run for the slow and the fast corner, or reports them as not run.

The control variant (`control/`) asks for the numbers after the detailed routing with extracted wires, at a 10 ns
clock. The last timing step analyses all corners, so the numbers of the run are the answer.

The harness functions for this task: the librelane adapter, operation `read` (the evidence level of each number and
the warning for carried-over numbers) and operation `replay` (the timing step again with one corner).

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `prepare.sh` | makes the workspace in the tool image before the agent starts (the run of record, the history) |
| `expected.json` | the reference values and tolerances |
| `score.mjs` | the scorer for one workspace: points for each part and `pass` |
| `task.json` | the task manifest for `../run-arm.mjs` |
| `control/` | the control variant: the same files with the mechanism removed |

## Run

```
node evals/run-arm.mjs evals/flow-evidence-level simra --model <provider/model> --runs <dir> --timeout-min 20
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** The runs of this task had no CPU limit in the container (a defect of the runner, corrected after these runs): the times are not the times of a 2-CPU run. The two arms had the same condition.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 4 of 4 | 107 | 9.26 M | 605 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 28 | 1.04 M | 175 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 30 | 1.09 M | 118 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 12 | 0.31 M | 61 s |
| treatment (digital arm), control variant | deepseek-flash | 1 of 1 | 25 | 1.00 M | 92 s |
| treatment (digital arm), control variant | gpt-6.1-sol | 1 of 1 | 11 | 0.26 M | 129 s |

Result: the two models pass in the baseline arm in all runs. This task does not show a difference of passes for the harness function. Keep it as a regression task for the function and for the scorer. The treatment arm used fewer model calls and fewer tokens. The control variant ran in the treatment arm only, 1 run for each model: the check under test gave no note in the control runs.
