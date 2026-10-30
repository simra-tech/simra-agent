# Demo evaluation: testbench conditions differ from the spec

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task tests whether an agent compares the conditions of a testbench with the conditions of the spec before
it uses the testbench. The faults are in the testbench, not in the PDK, so the task tests the agent's checks and
not its PDK knowledge. The design is [examples/ota-sg13g2](../../examples/ota-sg13g2/README.md). A trial takes
approximately 5 to 10 minutes.

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm (the same prompt as [ota-pvt](../ota-pvt/README.md)) |
| `spec.md` | the specification that the agent gets: conditions, PVT corners and limits |
| `tb_ota.spice` | the team testbench that the agent gets |
| `reference.mjs` | reference simulation through the Simra runner, with an independent cross-check |
| `expected.json` | reference values, verdicts, tolerances and their provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` |

## The task

1. Find out if the OTA meets `spec.md` at the corners tt, ss and ff.
2. Write `answer.json`: the claim `meets_spec`, and the value and verdict of each requirement at each corner.

The team testbench sets each corner correctly (model section, VDD and temperature). It has two faults in its
conditions. The agent must find them from the spec and from the testbench:

- The input common-mode voltage is fixed at 0.4 V. The spec gives VCM = VDD / 2.
- The load is CL = 0.5 pF. The spec gives CL = 2 pF.

The numbers stay plausible. With the team testbench as it is, the operating point settles, the gain changes by
less than 1.3 dB and the UGF by less than 14 %. The smaller load moves the non-dominant pole up, so the phase
margin increases by 18° to 23°.

With the spec conditions, the design fails the phase margin at ss (72.6° < 75°). With the team testbench as it
is, every row passes, so the claim is wrong. With one fault corrected and the other kept, the answer is still
wrong:

- Only CL corrected: the phase margin passes at ss (75.1°) and the UGF fails at ss (11.6 MHz). The claim is
  correct for the wrong reason, so the verdict points show it.
- Only VCM corrected: every row passes.

On 2026-10-30, with `openai/gpt-6.1-sol` (k = 1 for each arm): opencode and simra each had the correct claim
and all 22 points. Each agent named both faults in its first message and wrote its own testbenches with the
spec conditions. One trial for each arm cannot show a difference. With this model, the task can be too easy.

## Scoring

| Part | Points | A point is given when |
| --- | --- | --- |
| claim | 4 | `meets_spec` is the same as the reference |
| verdicts | 9 | the `pass` of a row is the same as the reference |
| values | 9 | the value of a row is within the tolerance of the reference |

Tolerances: gain ±0.5 dB, unity-gain frequency ±5 %, phase margin ±2°.

The score also has three diagnostics, which give no points:

- `supported`: the number of rows whose value appears in a workspace file other than `answer.json`.
- `traps`: for each row with a wrong value, the variants of the team testbench that give that value:
  `team_testbench` (as it is), `cl_fixed_only` or `vcm_fixed_only`.
- `claim_of`: the variants whose claim is the same as the claim of the answer.

## Reference values

| Corner | VDD | VCM | Temperature | Gain (dB) | UGF (MHz) | PM (°) |
| --- | --- | --- | --- | --- | --- | --- |
| tt | 1.20 V | 0.60 V | 27 °C | 52.105 | 20.777 | 76.11 |
| ss | 1.08 V | 0.54 V | 125 °C | 49.400 | 14.740 | **72.59** |
| ff | 1.32 V | 0.66 V | -40 °C | 54.369 | 27.388 | 80.34 |

Limits: gain >= 48 dB, unity-gain frequency >= 12 MHz, phase margin >= 75°. The ss phase margin fails, so
`meets_spec` is false.

The team testbench and its variants:

| Corner | Variant | Gain (dB) | UGF (MHz) | PM (°) |
| --- | --- | --- | --- | --- |
| tt | as it is | 53.112 | 18.454 | 96.63 |
| ss | as it is | 49.928 | 12.721 | 91.32 |
| ff | as it is | 55.605 | 27.587 | 103.46 |
| ss | only CL corrected | 49.928 | 11.618 | 75.08 |
| ss | only VCM corrected | 49.400 | 16.872 | 92.09 |

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image, IHP SG13G2 commit `a49358cc0b20`. The gain, the UGF and the
PM agree with a calculation from the raw AC data. The team testbench with both faults corrected gives the
reference values.

To make the values again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/ota-conditions/reference.mjs`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root. `MODELS` in
   `run-arm.mjs` names the variable: `DEEPSEEK_API_KEY` for `deepseek/deepseek-flash`, `OPENAI_API_KEY` for
   `openai/gpt-6.1-sol`.
4. Run `node evals/run-arm.mjs evals/ota-conditions <arm> [--model <id>] --timeout-min 15`.
