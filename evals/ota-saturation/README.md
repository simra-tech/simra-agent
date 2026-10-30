# Demo evaluation: a transistor out of saturation at one corner

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task tests whether an agent finds a fault that only the simulation shows. The spec, the design and the team
testbench have no fault that the agent can see by reading. The design is
[examples/ota-sg13g2](../../examples/ota-sg13g2/README.md). A trial takes approximately 5 to 10 minutes.

| File | Contents |
| --- | --- |
| `task.md` | the prompt, the same for every arm |
| `spec.md` | the specification that the agent gets: conditions, PVT corners and limits |
| `tb_ota.spice` | the team testbench that the agent gets |
| `reference.mjs` | reference simulation through the Simra runner, with an independent cross-check |
| `expected.json` | reference values, verdicts, tolerances and their provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` |

## The task

1. Find out if the OTA meets `spec.md` at the corners tt, ss and ff.
2. Write `answer.json`: the claim `meets_spec`, and the value and verdict of each requirement at each corner. For
   the saturation margin, also give the transistor that sets it.

The spec adds a saturation margin to the AC requirements: the smallest VDS - VDSAT of the transistors XM1 to
XM8 at the DC operating point must be 0 V or more. The team testbench sets the spec conditions correctly, but it
measures only the AC response.

Every AC row passes at every corner. At ss (1.08 V, 125 °C), the tail current source XM5 is out of saturation:
VDS - VDSAT = -70.6 mV. The gain, the unity-gain frequency and the phase margin do not show it. So `meets_spec`
is false, and an answer that checks only the AC rows gives the wrong claim.

VDSAT comes from the device model at the operating point. The overdrive voltage VGS - VTH is a different
quantity. With it, the margins are 13 mV higher at tt and 15 mV higher at ss. The claim and the verdicts stay
the same, but the tt and ss values are outside the tolerance.

On 2026-10-30, with k = 1 for each arm and model, every trial had the correct claim and all 28 points:
opencode and simra with `openai/gpt-6.1-sol`, and opencode and simra with `deepseek/deepseek-flash`. Each
agent read VDS and VDSAT (`vdss`) from the operating point and named XM5. The spec names the saturation check,
so the agents ran it. With these models, the task is too easy to show the value of a harness feature.

## Scoring

| Part | Points | A point is given when |
| --- | --- | --- |
| claim | 4 | `meets_spec` is the same as the reference |
| verdicts | 12 | the `pass` of a row is the same as the reference |
| values | 12 | the value of a row is within the tolerance of the reference |

Tolerances: gain ±0.5 dB, unity-gain frequency ±5 %, phase margin ±2°, saturation margin ±10 mV.

The score also has four diagnostics, which give no points:

- `supported`: the number of rows whose value appears in a workspace file other than `answer.json`.
- `devices`: the number of saturation rows that name the transistor that sets the margin.
- `traps`: the saturation rows whose wrong value is VDS - (VGS - VTH): `overdrive`.
- `claim_of`: the variants whose claim is the same as the claim of the answer: `ac_only` (true) or
  `overdrive` (false).

## Reference values

| Corner | VDD | Temperature | Gain (dB) | UGF (MHz) | PM (°) | Saturation margin (mV) | Device |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tt | 1.20 V | 27 °C | 52.105 | 20.777 | 76.11 | 34.1 | XM5 |
| ss | 1.08 V | 125 °C | 49.400 | 14.740 | 72.59 | **-70.6** | XM5 |
| ff | 1.32 V | -40 °C | 54.369 | 27.388 | 80.34 | 137.6 | XM5 |

Limits: gain >= 48 dB, unity-gain frequency >= 12 MHz, phase margin >= 60°, saturation margin >= 0 V. The ss
saturation margin fails, so `meets_spec` is false. At ss, the next smallest margin is 181 mV (XM2).

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image, IHP SG13G2 commit `a49358cc0b20`. VDS, VDSAT, VGS and VTH are
the operating-point outputs `vds`, `vdss`, `vgs` and `vth` of the PSP model. The gain, the UGF and the PM agree
with a calculation from the raw AC data. The team testbench with the corner set gives the reference AC values.

The task uses one PDK because it tests the agent's checks of the simulation results. A harness feature that
reads the operating point of a device model uses PDK knowledge. Its eval must also run on a second PDK.

To make the values again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/ota-saturation/reference.mjs`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root. `MODELS` in
   `run-arm.mjs` names the variable: `DEEPSEEK_API_KEY` for `deepseek/deepseek-flash`, `OPENAI_API_KEY` for
   `openai/gpt-6.1-sol`.
4. Run `node evals/run-arm.mjs evals/ota-saturation <arm> [--model <id>] --timeout-min 15`.
