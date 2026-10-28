# Demo evaluation: OTA at 3 corners

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task tests whether an agent gives correct simulated numbers and can show where each number came from.
The design is [examples/ota-sg13g2](../../examples/ota-sg13g2/README.md).

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `reference.spice`, `reference.mjs` | reference simulation through the Simra runner, with an independent cross-check |
| `expected.json` | reference values, tolerances and their provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` (prompt, files, scorer) |
| `../run-arm.mjs` | runs one arm and scores it |
| `../model-proxy.mjs` | logs every model call (model name, thinking settings, tokens), never the API key |

## The task

1. Simulate the OTA at tt, ss and ff.
2. Report the DC gain, the unity-gain frequency, the phase margin and the noise at 1 kHz for each corner.
3. Change Cc from 1 pF to 1.5 pF and simulate tt again.
4. Write `answer.json` with each number, its evidence and the hash of the netlist that gave it.

Step 3 changes an input after the first runs. An agent that does not keep its runs and inputs cannot then show
which netlist gave which number.

## Scoring

| Part | Points | A point is given when |
| --- | --- | --- |
| correctness | 16 | a value is within the tolerance of the reference (4 values, 4 results) |
| traceability | 16 | for each result: the evidence exists, it names the right corner and no other, it shows the reported values, and the netlist hash is the one that was simulated |
| tool | 2 | the ngspice version and the PDK commit are correct |

Tolerances: gain ±0.5 dB, unity-gain frequency ±5 %, phase margin ±2°, noise ±10 %.

## Reference values

| Corner | Cc | Gain (dB) | UGF (MHz) | PM (°) | Noise at 1 kHz (nV/√Hz) |
| --- | --- | --- | --- | --- | --- |
| tt | 1 pF | 52.105 | 20.777 | 76.11 | 679.6 |
| ss | 1 pF | 52.130 | 20.288 | 76.08 | 702.2 |
| ff | 1 pF | 52.244 | 21.355 | 76.29 | 654.0 |
| tt | 1.5 pF | 52.105 | 15.116 | 86.23 | 679.6 |

ngspice 46, IHP SG13G2 commit `84374023ee8b`. The gain, the UGF and the PM agree with a calculation from the
raw AC data to better than 0.01 %.

To make the values again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/ota-corners/reference.mjs`.

## Run an arm

Arms:

- `simra`: pi with the Simra Agent extension.
- `pi`: stock pi.
- `opencode`: OpenCode.

All arms use the model `deepseek/deepseek-flash` with high reasoning effort. On 2026-10-28, a check through
`model-proxy.mjs` showed that pi 1.4.0 and OpenCode 1.14.48 both send the model name `deepseek-flash` and
`reasoning_effort: high` to `api.deepseek.com`.

1. Put `DEEPSEEK_API_KEY` in the environment or in `.env` in the repository root.
2. Run `node evals/run-arm.mjs evals/ota-corners <arm>`.

The run directory is outside the repository (default: `$TMPDIR/simra-evals`; change it with `--runs <dir>`
or `SIMRA_EVAL_RUNS`). It holds the workspace `ws/`, the event stream `transcript.jsonl`, the model call log
`models.jsonl` and `score.json`.
