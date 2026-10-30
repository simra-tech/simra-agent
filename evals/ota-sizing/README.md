# Demo evaluation: change the sizes of an OTA to meet the spec

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a design task. The agent must change the sizes in `ota.spice` until the OTA meets `spec.md` at each
corner and at each input common-mode voltage (VCM) of the range. A verification task tells the agent which
checks to do. In a design task, the agent must also find why the design fails, and the operating point shows
the cause. The task has the same form for two PDKs, because a feature that uses PDK knowledge must have its
evaluation on at least two PDKs.

| Directory | PDK | MOS models | VCM range |
| --- | --- | --- | --- |
| `sg13cmos5l/` | IHP SG13CMOS5L | PSP (`sg13_lv_nmos`, `sg13_lv_pmos`) | 0.40 V to 0.70 V |
| `sky130/` | SkyWater SKY130 | BSIM4 (`sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8`) | 0.80 V to 1.20 V |

In the IIC-OSIC-TOOLS 2026.10 image, the low-voltage MOS model files of IHP SG13CMOS5L are links to the files of
IHP SG13G2. Thus the MOS devices of `sg13cmos5l/` are the same as in the other IHP tasks. SKY130 has different
models, a different model library and different operating-point parameters.

| File | Contents |
| --- | --- |
| `sizing.mjs` | the shared parts: spec parser, topology check, gate area, verification sweep, scorer |
| `reference.mjs` | the reference results of a task: the original, a reference fix and a cross-check |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/spec.md` | the specification: conditions, corners, requirements and design limits |
| `<pdk>/ota.spice` | the OTA that the agent changes |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `sizing.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |

## The task

1. Change the sizes in `ota.spice`: W, L and the number of fingers of the MOS devices, Rz and Cc.
2. Keep the topology: the devices, the nets, the models and the parameter names.
3. Obey the design limits: the gate area (the sum of W × L) and Cc <= 2 pF.
4. Write `answer.json`: the claim `meets_spec`, and for each corner and requirement the worst value over the VCM
   range and its VCM.

Each requirement applies at each VCM: the DC gain, the unity-gain frequency (UGF), the phase margin and the supply
current. The original OTA has two faults, and both are at ss:

- At the bottom of the VCM range, the tail source XM5 is out of saturation. The UGF is too low.
- At the top of the VCM range, the input device XM2 is near the edge of saturation. The gain is too low.

More than one fix exists. The reference fix raises the tail node (a wider input pair) and gives the input pair
more drain voltage (wider loads XM3 and XM4, and XM6 in the same ratio, so that the second stage keeps its
current). A smaller Cc also increases the UGF, and a lower current in the second stage increases the gain.

## Scoring

The scorer does not use the numbers of the answer to find if the design meets the spec. It simulates the final
`ota.spice` itself, at each corner and at each VCM of the range in steps of 0.02 V. The scorer writes these
experiments in `verify/` in the run directory.

| Part | Points | A point is given when |
| --- | --- | --- |
| topology | 1 | `ota.spice` has the devices, nets, models and parameter names of the original |
| limits | 1 | the gate area and Cc obey the design limits |
| requirements | 12 | the verified worst value of a row passes (only if the topology is correct) |
| claim | 4 | `meets_spec` is the same as the verification (topology, limits and all requirements) |
| values | 12 | the reported worst value of a row is within the tolerance of the verified worst value |

Tolerances: gain ±0.5 dB, UGF ±5 %, phase margin ±2°, supply current ±2 %.

The score also has diagnostics, which give no points: `area_um2`, `changed` (the changed sizes), `supported`
(the rows whose value appears in a workspace file other than `answer.json` and `ota.spice`) and `verification`
(the experiments and the verified values).

## Reference results

`reference.mjs` verifies the original and a reference fix. It cross-checks the verification sweep: at each corner,
one separate simulation at the VCM of the worst UGF gives gain, UGF and PM from the raw AC data, and these values
must agree with the sweep. For `sg13cmos5l/`, the worst values of the original must also be the same as the
values of [ota-saturation](../ota-saturation/README.md) (IHP SG13G2). They are the same.

The worst values over the VCM range (failures in bold):

| PDK | Design | Area (µm²) | Corner | Gain (dB) | UGF (MHz) | PM (°) | IDD (µA) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | original | 30 | tt | 51.16 | 16.41 | 75.93 | 79.8 |
| sg13cmos5l | original | 30 | ss | **46.41** | **11.62** | 72.44 | 77.7 |
| sg13cmos5l | original | 30 | ff | 54.06 | 23.16 | 79.45 | 81.6 |
| sg13cmos5l | reference fix | 50 | ss | 49.26 | 19.64 | 74.21 | 78.4 |
| sky130 | original | 42 | tt | 70.03 | 17.03 | 78.47 | 71.8 |
| sky130 | original | 42 | ss | **61.83** | **13.26** | 74.49 | 74.3 |
| sky130 | original | 42 | ff | 73.57 | 21.37 | 83.94 | 69.9 |
| sky130 | reference fix | 58 | ss | 65.24 | 17.50 | 74.33 | 74.5 |

The limits:

| PDK | Gain | UGF | PM | IDD | Gate area |
| --- | --- | --- | --- | --- | --- |
| sg13cmos5l | >= 48 dB | >= 13 MHz | >= 60° | <= 85 µA | <= 60 µm² |
| sky130 | >= 65 dB | >= 15 MHz | >= 60° | <= 80 µA | <= 80 µm² |

The reference fix meets every requirement at every corner. `expected.json` has the values of tt and ff, and the
sweep of each corner. ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130:
`sky130A` of ciel version `1689ac3f2dc7`.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/ota-sizing/reference.mjs sg13cmos5l`. It takes approximately 15 s.
3. Run `node evals/ota-sizing/reference.mjs sky130`. It takes approximately 3 minutes, because ngspice loads
   the SKY130 models in approximately 30 s.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/ota-sizing/<pdk> <arm> [--model <id>] --timeout-min 30`.
