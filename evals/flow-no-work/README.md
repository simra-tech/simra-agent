# Demo evaluation: do not report a result of a check that did no work

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets an FIR filter with a synthesis script and a timing script. The last commit changed the RTL to
signed arithmetic and synthesized the netlist again. The agent must run the timing check and report the result.

The seeded mechanism: the netlist has the keyword `signed` in its declarations, and the Verilog reader of OpenSTA
stops with a syntax error. The timing script does not check this. It prints the summary of the old report files
(slack +0.080 ns, met) and ends with exit code 0. The real slack of the new netlist is -1.695 ns. A right answer is
`not_run`, or the real number after a repair of the netlist that the timing tool reads.

The control variant (`control/`) removes the keyword in the synthesis script. The timing script then works, and its
printed result is the answer.

The harness function for this task: the command check of the pi extension (a log with error lines after a command
with exit code 0).

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
node evals/run-arm.mjs evals/flow-no-work simra --model <provider/model> --runs <dir> --timeout-min 15
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** The runs of this task had no CPU limit in the container (a defect of the runner, corrected after these runs): the times are not the times of a 2-CPU run. The two arms had the same condition.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 3 | 29 | 0.83 M | 123 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 4 of 4 | 11 | 0.23 M | 55 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 31 | 0.95 M | 345 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 15 | 0.33 M | 70 s |
| treatment (digital arm), control variant | deepseek-flash | 1 of 1 | 20 | 0.56 M | 81 s |
| treatment (digital arm), control variant | gpt-6.1-sol | 1 of 1 | 12 | 0.26 M | 65 s |

Result: the two models pass in the baseline arm in all runs. This task does not show a difference of passes for the harness function. Keep it as a regression task for the function and for the scorer. The command check adds no pass and no saving here. It is off by default (`SIMRA_COMMAND_CHECK=on` enables it). The control variant ran in the treatment arm only, 1 run for each model: the check under test gave no note in the control runs.
