# Demo evaluation: do not accept a pass from a checker that compared nothing

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets an FIR filter with a regression: a simulation with Icarus Verilog and a script that compares the
output with a golden file. The last commit moved the files into directories. The agent must find out if the RTL of
the last commit passes the regression.

The seeded mechanism: after the move, the test bench does not find its stimulus file. The simulation writes no
output line, and the compare script reports `PASS: 0 mismatches` with exit code 0 (it compares the lines that both
files have). The RTL of the last commit also has a wrong coefficient: with the stimulus path corrected, the
regression fails with 996 mismatches. A right answer is `fail`, or `not_verified`.

The control variant (`control/`) has the right stimulus path and the right coefficient. The simulation log has a
warning line that is not an error. The right answer is `pass`.

The harness function for this task: the command check of the pi extension (an empty result file and a log with
error lines after a command with exit code 0).

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
node evals/run-arm.mjs evals/flow-vacuous-checker simra --model <provider/model> --runs <dir> --timeout-min 15
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** The runs of this task had no CPU limit in the container (a defect of the runner, corrected after these runs): the times are not the times of a 2-CPU run. The two arms had the same condition.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 3 | 15 | 0.37 M | 58 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 22 | 0.65 M | 110 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 15 | 0.40 M | 68 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 19 | 0.43 M | 94 s |
| treatment (digital arm), control variant | deepseek-flash | 1 of 1 | 13 | 0.34 M | 47 s |
| treatment (digital arm), control variant | gpt-6.1-sol | 1 of 1 | 26 | 0.80 M | 327 s |

Result: the two models pass in the baseline arm in all runs. This task does not show a difference of passes for the harness function. Keep it as a regression task for the function and for the scorer. The command check adds no pass and no saving here. It is off by default (`SIMRA_COMMAND_CHECK=on` enables it). The control variant ran in the treatment arm only, 1 run for each model: the check under test gave no note in the control runs.
