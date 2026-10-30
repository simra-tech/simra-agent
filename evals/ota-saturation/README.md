# Demo evaluation: the worst case is not where the team testbench looks

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task tests whether an agent finds faults that only the simulation shows. The spec gives an input
common-mode range. The team testbench uses one VCM, and its comment says that this VCM is the worst case. The
comment is wrong, but only a simulation over the range shows it. The design is
[examples/ota-sg13g2](../../examples/ota-sg13g2/README.md). A trial takes approximately 5 to 15 minutes.

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `spec.md` | the specification that the agent gets: conditions, input range, PVT corners and limits |
| `tb_ota.spice` | the team testbench that the agent gets |
| `reference.mjs` | reference simulation through the Simra runner, with an independent cross-check |
| `expected.json` | reference values, verdicts, tolerances and their provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` |

## The task

1. Find out if the OTA meets `spec.md` at the corners tt, ss and ff, over the input range VCM = 0.40 V to
   0.70 V.
2. Write `answer.json`: the claim `meets_spec`, and for each requirement at each corner, the worst value over the
   input range, the VCM where it occurs and the verdict.

The team testbench sets the corner correctly. It uses VCM = VDD / 2 only, and its comment says that VDD / 2 is
the worst case of the input range. At VDD / 2, every row passes at every corner.

The comment is wrong at ss (1.08 V, 125 °C). Two rows fail, at the two ends of the range:

- At VCM = 0.40 V, the tail current source XM5 is out of saturation (VDS - VDSAT = -162 mV). The tail current
  falls, and the unity-gain frequency falls to 11.6 MHz (limit 13 MHz).
- At VCM = 0.70 V, the saturation margin of the input transistor XM2 falls to 41 mV. The gain falls to
  46.4 dB (limit 48 dB).

So `meets_spec` is false. An answer that believes the comment gives the wrong claim. An answer that checks only
one end of the range finds only one of the two failing rows.

Version 1 of this task (commit 82731a5) gave a saturation margin row in the spec. Every agent ran that check and
got all the points, so the task could not show the value of a harness feature.

On 2026-10-30, with k = 1 for each arm and model, every trial of version 2 had the correct claim and all 22
points: opencode and simra with `deepseek/deepseek-flash` and with `openai/gpt-6.1-sol`. Each agent swept the
input range at every corner, did not believe the comment, and found the VCM of each worst value. With these
models, a verification task that states its conditions in the spec is too easy to show the value of a harness
feature.

## Scoring

| Part | Points | A point is given when |
| --- | --- | --- |
| claim | 4 | `meets_spec` is the same as the reference |
| verdicts | 9 | the `pass` of a row is the same as the reference |
| values | 9 | the worst value of a row is within the tolerance of the reference |

Tolerances: gain ±0.5 dB, unity-gain frequency ±5 %, phase margin ±2°.

The score also has four diagnostics, which give no points:

- `supported`: the number of rows whose value appears in a workspace file other than `answer.json`.
- `vcm`: the number of rows whose VCM is within 0.05 V of the VCM of the reference worst value.
- `traps`: the rows whose wrong value is the value at VCM = VDD / 2: `team_testbench`.
- `claim_of`: the variants whose claim is the same as the claim of the answer: `team_testbench` (true).

## Reference values

The reference sweeps VCM from 0.40 V to 0.70 V in steps of 20 mV at each corner.

| Corner | VDD | Temperature | Gain (dB) | at VCM | UGF (MHz) | at VCM | PM (°) | at VCM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tt | 1.20 V | 27 °C | 51.161 | 0.70 V | 16.413 | 0.40 V | 75.93 | 0.52 V |
| ss | 1.08 V | 125 °C | **46.412** | 0.70 V | **11.618** | 0.40 V | 72.44 | 0.60 V |
| ff | 1.32 V | -40 °C | 54.063 | 0.70 V | 23.155 | 0.40 V | 79.45 | 0.46 V |

Limits: gain >= 48 dB, unity-gain frequency >= 13 MHz, phase margin >= 60°. The ss gain and the ss UGF fail, so
`meets_spec` is false.

The team testbench, at VCM = VDD / 2:

| Corner | VCM | Gain (dB) | UGF (MHz) | PM (°) |
| --- | --- | --- | --- | --- |
| tt | 0.60 V | 52.105 | 20.777 | 76.11 |
| ss | 0.54 V | 49.400 | 14.740 | 72.59 |
| ff | 0.66 V | 54.369 | 27.388 | 80.34 |

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image, IHP SG13G2 commit `a49358cc0b20`. At each sweep point, the
gain, the UGF and the PM agree with a calculation from the raw AC data. The team testbench gives the reference
values at VCM = VDD / 2. `expected.json` also gives, for each sweep point, the smallest VDS - VDSAT and its
transistor (the PSP operating-point outputs `vds` and `vdss`).

The task uses one PDK because it tests the agent's checks of the simulation results. A harness feature that
reads the operating point of a device model uses PDK knowledge. Its eval must also run on a second PDK.

To make the values again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/ota-saturation/reference.mjs`. It runs 51 simulations.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root. `MODELS` in
   `run-arm.mjs` names the variable: `DEEPSEEK_API_KEY` for `deepseek/deepseek-flash`, `OPENAI_API_KEY` for
   `openai/gpt-6.1-sol`.
4. Run `node evals/run-arm.mjs evals/ota-saturation <arm> [--model <id>] --timeout-min 15`.
