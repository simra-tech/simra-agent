# Demo evaluation: OTA against a PVT spec

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task tests whether an agent checks that its measurements are valid before it makes a claim. The design is
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
2. Write `answer.json`: the claim `meets_spec`, and the value and verdict of each requirement at each corner.

The team testbench has two faults. The agent must find them from the spec and from the testbench:

- It applies only the MOS model section. The spec defines each corner by process, supply voltage and
  temperature. VCM is VDD / 2.
- It sets `.option rshunt=5e5` "to help the operating point to converge". ngspice then connects 500 kΩ from
  each node to ground. The spec has no such load. The resistors load the high-impedance nodes and decrease the
  gain by approximately 6 dB. The numbers stay plausible.

The design meets the spec at every corner. With the team testbench as it is, the gain fails at every corner.

The first version of this task had a different second fault: the phase in radians was added to 180, which gave a
phase margin of approximately 178°. In 10 trials (5 pi, 5 simra), every agent found both faults and got all
points, so that fault was too easy to see.

With the shunt fault, on 2026-10-29 (k = 5 for each arm): pi and simra each had the correct claim in 3 of 5
trials. In each trial with the wrong claim, the agent applied the PVT conditions but kept `rshunt` in its own
testbenches. In each trial with the correct claim, the agent asked what `rshunt` does to the gain.

With the netlist check (see the [README](../../README.md#netlist-check)), on 2026-10-29 (k = 5 for each arm):
simra had the correct claim and all 22 points in 5 of 5 trials, and pi in 2 of 5. In each simra trial, the
check gave the `rshunt` warning when the agent read `tb_ota.spice`, and the agent removed the option from its
own testbenches. The check finds exactly the fault of this task, so this result shows that the agent acts on
the warning. It does not show how often the check helps on other designs.

## Scoring

| Part | Points | A point is given when |
| --- | --- | --- |
| claim | 4 | `meets_spec` is the same as the reference |
| verdicts | 9 | the `pass` of a row is the same as the reference |
| values | 9 | the value of a row is within the tolerance of the reference |

Tolerances: gain ±0.5 dB, unity-gain frequency ±5 %, phase margin ±2°.

The score also has two diagnostics, which give no points:

- `supported`: the number of rows whose value appears in a workspace file other than `answer.json`.
- `traps`: the rows whose value is the value of the team testbench as it is, and not the reference value.

## Reference values

| Corner | VDD | Temperature | Gain (dB) | UGF (MHz) | PM (°) |
| --- | --- | --- | --- | --- | --- |
| tt | 1.20 V | 27 °C | 52.105 | 20.777 | 76.11 |
| ss | 1.08 V | 125 °C | 49.400 | 14.740 | 72.59 |
| ff | 1.32 V | -40 °C | 54.369 | 27.388 | 80.34 |

Limits: gain >= 48 dB, unity-gain frequency >= 13 MHz, phase margin >= 60°. Every row passes. The team
testbench as it is gives 46.07 dB at tt, 45.87 dB at ss and 46.37 dB at ff.

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image, IHP SG13G2 commit `a49358cc0b20`. The gain, the UGF and the
PM agree with a calculation from the raw AC data.

To make the values again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README).
2. Run `node evals/ota-pvt/reference.mjs`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put `DEEPSEEK_API_KEY` in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/ota-pvt <arm> --timeout-min 15`.
