# Demo evaluation: design an OTA from a pin specification

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a synthesis task. The agent gets a specification at the pins, a verification bench and the
requirements. It gets no netlist. It must write the OTA in `ota.spice`: the topology, the devices and the sizes.
The OTA must meet `spec.md` at each corner and at each input common-mode voltage (VCM) of the range. The task has
the same form for two PDKs, because a feature that uses PDK knowledge must have its evaluation on at least two
PDKs.

| Directory | PDK | MOS devices | VCM range |
| --- | --- | --- | --- |
| `sg13cmos5l/` | IHP SG13CMOS5L | `sg13_lv_nmos`, `sg13_lv_pmos` | 0.40 V to 0.70 V |
| `sky130/` | SkyWater SKY130 | `sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8` and their `_lvt` and `_hvt` variants | 0.80 V to 1.20 V |

The conditions, the corners, the requirements and the bench are the same as in
[ota-sizing](../ota-sizing/README.md). Only the design part is different.

| File | Contents |
| --- | --- |
| `synthesis.mjs` | the shared parts: spec parser, verification (the `verify()` of `../ota-sizing/sizing.mjs`), scorer |
| `reference.mjs` | the reference results of a task: a known pass, a known fail and a cheat |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/spec.md` | the specification: conditions, corners, requirements and design rules |
| `<pdk>/verify.spice` | the verification bench (the same as in ota-sizing) |
| `<pdk>/requirements.json` | the corners, the limits and the design contract (the `design` section) |
| `<pdk>/simra.config.json` | the environment of the task (the same as in ota-sizing) |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `synthesis.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |

## The task

1. Write the subcircuit `ota` in `ota.spice`, with the pins `inp inn out vdd vss ibias`, in this order.
2. Use only the MOS devices of the model library of the corner, ideal resistors up to 1 MΩ and ideal capacitors
   up to 2 pF. Do not use a source, a behavioural element, `.model`, `.option`, `.include`, `.lib` or `.param`.
3. Give each size as a plain number. Obey the minimum sizes of the PDK. On SKY130, W and L are in µm without a
   suffix (`w=2 l=0.5`), because the model library sets `.option scale=1.0u`. On IHP, they are in metres with a
   suffix (`w=2u l=0.5u`).
4. Obey the gate area limit: the sum of W × L over the MOS devices is <= 60 µm² (sg13cmos5l) or <= 80 µm²
   (sky130).
5. Write `answer.json`: the claim `meets_spec`, the gate area, and for each corner and requirement the worst
   value over the VCM range and its VCM.

The `design` section of `requirements.json` gives the same rules to the check. Thus a check of
`requirements.json` by the agent and the score use the same design rules and the same bench.

## Scoring

The scorer does not use the numbers of the answer to find if the design meets the spec. It runs the check of
`requirements.json` on the final `ota.spice`: first the design check (a lint of the netlist against the design
contract, without a simulation), then the bench at each corner and at each VCM of the range in steps of 0.02 V.
The scorer writes these experiments in `verify/` in the run directory.

| Part | Points | A point is given when |
| --- | --- | --- |
| design | 2 | the design part of the verdict is `pass` (the contract, the element rules and the limits) |
| requirements | 12 | the verified worst value of a row passes (only when the design part passes) |
| claim | 4 | `meets_spec` is the same as the verification (the design part and all rows) |
| values | 12 | the reported worst value of a row is within the tolerance of the verified worst value |

Tolerances: gain ±0.5 dB, UGF ±5 %, phase margin ±2°, supply current ±2 %.

The score also has diagnostics, which give no points: `area_um2` and `mos_count` from the design part,
`design_errors` (each with file and line), `supported` (the rows whose value appears in a workspace file other
than `answer.json` and `ota.spice`), `verification` (the experiments, the sweep points and the worst values with
their provenance) and `errors`.

## Reference results

`reference.mjs` verifies three designs:

1. The reference fix of ota-sizing. The design part passes and every row passes. It is the known answer.
2. The original OTA of ota-sizing. The design part passes. The ss gain and the ss UGF fail, as in ota-sizing.
3. A cheat: an ideal voltage-controlled voltage source (E) with one RC pole and a bias resistor. The design part
   fails with two errors: the E element and node 0. The simulation passes every row. The score gives 0 design
   points and 0 requirement points, also with a correct answer.

For designs 1 and 2, the worst values and the gate area must be the same as in
`../ota-sizing/<pdk>/expected.json`. They are the same.

The worst values over the VCM range (failures in bold):

| PDK | Design | Area (µm²) | Corner | Gain (dB) | UGF (MHz) | PM (°) | IDD (µA) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | reference fix | 50 | tt | 53.48 | 28.67 | 78.38 | 80.4 |
| sg13cmos5l | reference fix | 50 | ss | 49.26 | 19.64 | 74.21 | 78.4 |
| sg13cmos5l | reference fix | 50 | ff | 56.93 | 41.99 | 80.92 | 82.1 |
| sg13cmos5l | original | 30 | tt | 51.16 | 16.41 | 75.93 | 79.8 |
| sg13cmos5l | original | 30 | ss | **46.41** | **11.62** | 72.44 | 77.7 |
| sg13cmos5l | original | 30 | ff | 54.06 | 23.16 | 79.45 | 81.6 |
| sky130 | reference fix | 58 | tt | 71.91 | 22.54 | 78.50 | 71.9 |
| sky130 | reference fix | 58 | ss | 65.24 | 17.50 | 74.33 | 74.5 |
| sky130 | reference fix | 58 | ff | 74.74 | 28.34 | 84.23 | 70.0 |
| sky130 | original | 42 | tt | 70.03 | 17.03 | 78.47 | 71.8 |
| sky130 | original | 42 | ss | **61.83** | **13.26** | 74.49 | 74.3 |
| sky130 | original | 42 | ff | 73.57 | 21.37 | 83.94 | 69.9 |

The limits:

| PDK | Gain | UGF | PM | IDD | Gate area | R | C |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | >= 48 dB | >= 13 MHz | >= 60° | <= 85 µA | <= 60 µm² | <= 1 MΩ | <= 2 pF |
| sky130 | >= 65 dB | >= 15 MHz | >= 60° | <= 80 µA | <= 80 µm² | <= 1 MΩ | <= 2 pF |

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of ciel version
`1689ac3f2dc7`. `expected.json` has the image ID, the sweep of each corner and the design part of each design.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/ota-synthesis/reference.mjs sg13cmos5l`.
3. Run `node evals/ota-synthesis/reference.mjs sky130`.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/ota-synthesis/<pdk> <arm> [--model <id>] --timeout-min 30`.
