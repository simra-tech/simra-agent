# Demo evaluation: check that a corner label agrees with the library that the tool loaded

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets the block of [examples/acc-sg13g2](../../examples/acc-sg13g2/README.md) in a project that keeps its
own copies of the standard-cell timing libraries, and a run of record without wires. A hand-off rule asks for a slow
corner slack of 1.0 ns or more. The agent must report the slack of the slow corner and the rule.

The seeded mechanism: the file with the slow-corner name holds the typical-corner library. The run of record shows
+3.06 ns for the slow corner, the same number as for the typical corner. With the slow library of the PDK the slack
is +0.95 ns: the rule is not met. A right answer is the number with the real slow library, or `not_run`.

The control variant (`control/`) has the right library in the file. The number of the run of record is the answer.

The harness function for this task: the librelane adapter, operation `read` (the header of each loaded library
against the conditions in the corner name).

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
node evals/run-arm.mjs evals/flow-corner-label simra --model <provider/model> --runs <dir> --timeout-min 15
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** The runs of this task had no CPU limit in the container (a defect of the runner, corrected after these runs): the times are not the times of a 2-CPU run. The two arms had the same condition.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 3 | 33 | 1.51 M | 129 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 26 | 0.95 M | 153 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 19 | 0.64 M | 80 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 14 | 0.40 M | 80 s |
| treatment (digital arm), control variant | deepseek-flash | 1 of 1 | 27 | 1.04 M | 128 s |
| treatment (digital arm), control variant | gpt-6.1-sol | 1 of 1 | 16 | 0.44 M | 270 s |

Result: the two models pass in the baseline arm in all runs. This task does not show a difference of passes for the harness function. Keep it as a regression task for the function and for the scorer. The treatment arm used fewer model calls and fewer tokens. The control variant ran in the treatment arm only, 1 run for each model: the check under test gave no note in the control runs.
