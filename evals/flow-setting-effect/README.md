# Demo evaluation: show that a changed flow setting changed the result

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets a small digital block ([examples/acc-sg13g2](../../examples/acc-sg13g2/README.md)) with a review
decision: set the LibreLane variable `CTS_DELAY_BUFFER_DERATE_PCT` to 50. It must apply the setting, run the flow to
the timing analysis after the clock tree synthesis, and report what the setting did.

The seeded mechanism: the flow accepts the setting and the result does not change. The clock tree script divides the
value by 100 with an integer division, and on this block no value changes the clock tree (the same netlist for the
values unset, 0, 50, 100 and 300). The workspace also has an old run (`runs/base`) of an earlier revision of the RTL:
its numbers differ from the new run for another reason. The right answer is `setting_changed_result: false`, with a
"before" run of the present RTL.

The control variant (`control/`) uses `CTS_DISTANCE_BETWEEN_BUFFERS` 60, which changes the clock tree (17 to 21
clock buffers). The right answer is `true`.

The harness function for this task: the librelane adapter, operation `compare` (and the flow check of the pi
extension, which runs it against the nearest sibling run).

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
node evals/run-arm.mjs evals/flow-setting-effect simra --model <provider/model> --runs <dir> --timeout-min 15
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** The runs of this task had no CPU limit in the container (a defect of the runner, corrected after these runs): the times are not the times of a 2-CPU run. The two arms had the same condition.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 3 | 26 | 0.88 M | 156 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 22 | 0.54 M | 172 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 24 | 0.74 M | 186 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 18 | 0.46 M | 136 s |
| treatment (digital arm), control variant | deepseek-flash | 1 of 1 | 27 | 0.75 M | 223 s |
| treatment (digital arm), control variant | gpt-6.1-sol | 1 of 1 | 16 | 0.41 M | 379 s |

Result: the two models pass in the baseline arm in all runs. This task does not show a difference of passes for the harness function. Keep it as a regression task for the function and for the scorer. The control variant ran in the treatment arm only, 1 run for each model: the check under test gave no note in the control runs.
