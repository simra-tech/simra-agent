# Demo evaluation: test one flow step again when a full run does not fit the time

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

The agent gets a bank of shift registers (72,000 flip-flops,
[examples/shreg-sg13g2](../../examples/shreg-sg13g2/README.md)) and a run of record that stopped with an error at
the timing repair after the clock tree synthesis. A new run of the flow to that step takes about 25 minutes; the
session limit is 20 minutes. The agent must find the cause, find a setting that lets the step end, and show it with
a run of the step.

The seeded mechanism: the hold repair reached its maximum buffer count (50 % of the instance count, message
RSZ-0060) with 72,000 violating end points. With `PL_RESIZER_HOLD_MAX_BUFFER_PCT` at 100 the step ends. A right answer
names the cause `buffer_count_limit` and has the log of a run of the step that ends without an error.

The harness function for this task: the librelane adapter, operation `replay` (one step again on its saved input
state, with a changed variable).

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `prepare.sh` | makes the workspace in the tool image before the agent starts (the run of record, the history) |
| `expected.json` | the reference values and tolerances |
| `score.mjs` | the scorer for one workspace: points for each part and `pass` |
| `task.json` | the task manifest for `../run-arm.mjs` |

## Run

```
node evals/run-arm.mjs evals/flow-step-replay simra --model <provider/model> --runs <dir> --timeout-min 20
```

The option `--harness <checkout>` runs the same image with the harness directories of a checkout.

## Pilot counts

Pilot of 2026-11-20, models `deepseek/deepseek-flash` and `openai/gpt-6.1-sol`, image of commit `98dc11d`. The baseline arm is the image as it is. The treatment arm is the same image with the harness directories of the digital arm (`--harness`), without the registry entries for the digital tools: an entry can contain the answer of a task. **A count of 3 runs is not a rate.** Each run had 2 CPUs, pinned in the container.

| Arm | Model | Passes of runs | Model calls (median) | Tokens (median) | Time (median) |
| --- | --- | --- | --- | --- | --- |
| baseline (harness without the digital arm) | deepseek-flash | 3 of 4 | 54 | 2.97 M | 853 s |
| baseline (harness without the digital arm) | gpt-6.1-sol | 3 of 3 | 30 | 1.10 M | 596 s |
| treatment (digital arm) | deepseek-flash | 3 of 3 | 23 | 0.93 M | 656 s |
| treatment (digital arm) | gpt-6.1-sol | 3 of 3 | 20 | 0.52 M | 509 s |

Result: one baseline run of `deepseek-flash` reached the session limit before its run of the step ended (the cause in its answer was right). All other runs pass. The treatment arm used fewer model calls and fewer tokens. Runs that started before the CPU pin was corrected are not in the table.
