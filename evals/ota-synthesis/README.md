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
[ota-sizing](../ota-sizing/README.md), with one more requirement: the input current `iin_a` (see
[The input current](#the-input-current)). The design part is also different.

| File | Contents |
| --- | --- |
| `synthesis.mjs` | the shared parts: spec parser, verification (the `verify()` of `../ota-sizing/sizing.mjs`), scorer |
| `reference.mjs` | the reference results of a task: a known pass, a known fail, a cheat and an input load |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/spec.md` | the specification: conditions, corners, requirements and design rules |
| `<pdk>/verify.spice` | the verification bench (the bench of ota-sizing with the measurement of `iin_a`) |
| `<pdk>/requirements.json` | the corners, the limits and the design contract (the `design` section) |
| `<pdk>/simra.config.json` | the environment of the task (the same as in ota-sizing) |
| `<pdk>/expected.json` | the reference results and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `synthesis.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |
| `family.json` | the variants: the roles of `expected.json` and the limits that derive from the target |
| `<pdk>/target.json` | the target: the best known design point of the task on the PDK, with provenance |
| `<pdk>-f<factor>/` | a variant of the task with tighter limits (see [Variants](#variants)) |

## The task

1. Write the subcircuit `ota` in `ota.spice`, with the pins `inp inn out vdd vss ibias`, in this order.
2. Use only the MOS devices of the model library of the corner, ideal resistors up to 1 MΩ and ideal capacitors
   up to 2 pF. Do not use a source, a behavioural element, `.model`, `.option`, `.include`, `.lib` or `.param`.
3. Give each size as a plain number. Obey the minimum sizes of the PDK. On SKY130, W and L are in µm without a
   suffix (`w=2 l=0.5`), because the model library sets `.option scale=1.0u`. On IHP, they are in metres with a
   suffix (`w=2u l=0.5u`).
4. Obey the area limit: the gate area plus the area of the R and C is <= 1000 µm² (sg13cmos5l) or <= 770 µm²
   (sky130). See [The area](#the-area).
5. Write `answer.json`: the claim `meets_spec`, the area, and for each corner and requirement the worst value
   over the VCM range and its VCM.

The `design` section of `requirements.json` gives the same rules to the check. Its `devices` list gives the MOS
devices of `spec.md`. Thus a check of
`requirements.json` by the agent and the score use the same design rules and the same bench.

## Scoring

The scorer does not use the numbers of the answer to find if the design meets the spec. It runs the check of
`requirements.json` on the final `ota.spice`: first the design check (a lint of the netlist against the design
contract, without a simulation), then the bench at each corner and at each VCM of the range in steps of 0.02 V.
The scorer writes these experiments in `verify/` in the run directory.

| Part | Points | A point is given when |
| --- | --- | --- |
| design | 2 | the design part of the verdict is `pass` (the contract, the element rules and the limits) |
| requirements | 15 | the verified worst value of a row passes (only when the design part passes) |
| claim | 4 | `meets_spec` is the same as the verification (the design part and all rows) |
| values | 15 | the reported worst value of a row is within the tolerance of the verified worst value |

Tolerances: gain ±0.5 dB, UGF ±5 %, phase margin ±2°, supply current ±2 %, input current ±2 % or ±20 pA (either
one is sufficient; 20 pA is 1 % of the limit).

The score also has diagnostics, which give no points: `area_um2` (the gate area plus the area of the R and C),
`gate_area_um2`, `passive_area_um2` (the R and C) and `mos_count` from the design part,
`design_errors` (each with file and line), `supported` (the rows whose value appears in a workspace file other
than `answer.json` and `ota.spice`), `verification` (the experiments, the sweep points and the worst values with
their provenance) and `errors`.

## The input current

The spec does not give the source impedance of the inputs. Thus a design can load the inputs, for example with a
resistive divider from each input to `vss`, and the bench sources supply the current. The requirement `iin_a`
prevents this. It is the same in [comparator-synthesis](../comparator-synthesis/README.md): the same name, the
same unit, the same limit and the same rule on both PDKs.

1. `iin_a` is the larger magnitude of the DC current into `inp` and into `inn`.
2. The bench measures it at the DC operating point. The current into `inp` is the current of the input source.
   The current into `inn` is the current of the feedback inductor. A DC point has no capacitor current. (In a
   transient, a sample of a source current has the numerical ringing of the capacitor currents. With the
   comparator reference on SKY130, this ringing is 0.1 µA to 0.3 µA.)
3. The limit is `iin_a <= 2 nA`, at each corner and at each VCM of the range.

The evidence for the limit (the worst value over the corners and the VCM range):

| Task | PDK | Reference | Input load | Input load / limit |
| --- | --- | --- | --- | --- |
| ota-synthesis | sg13cmos5l | 2.1 pA (fix) | 70 µA (10 kΩ from `inp` to `vss`) | 35000 |
| ota-synthesis | sky130 | 0 A (fix) | 120 µA (10 kΩ from `inp` to `vss`) | 60000 |
| comparator-synthesis | sg13cmos5l | 1.3 pA (reference) | 175 µA (1 kΩ / 3 kΩ dividers) | 87500 |
| comparator-synthesis | sky130 | 0 A (reference) | 38.7 µA (1 kΩ / 30 kΩ dividers) | 19400 |

For the input load, the value is the smallest of the three corner values. The gate inputs of the targets
also pass: 16.6 pA (ota-synthesis, sg13cmos5l) and 0 A (comparator-synthesis, sky130). `expected.json` records
these values in `input_current`.

The largest gate-input value is 16.6 pA, so a MOS gate input passes with a margin of more than 100. The input
loads of the reference results fail by a factor of more than 10000. The SKY130 models have no gate current, so the
gate inputs give 0 A there.

A design with 8 × 1 MΩ in series from each input to `vss` takes 50 nA to 87 nA at the inputs. It fails `iin_a`
by a factor of more than 25. Its resistors
also count in the area (see [The area](#the-area)).

## The area

The area limit applies to the gate area plus the area of the R and C. Each instance of a block counts.

1. Gate area: the sum of W × L over the MOS devices. W is the total width of all fingers. The multiplier m counts.
2. A resistor R counts as the high-resistance poly resistor of the PDK at its minimum width: R × w_min² / R_sheet.
3. A capacitor C counts as the densest capacitor of the PDK: C / density.

The technology pack gives the facts, with their sources (`ngspice.passives` in
[technologies/README.md](../../technologies/README.md)). The design check reads them for the PDK of the
environment.

| PDK | Resistor | R_sheet | w_min | 10 kΩ counts as | Capacitor | Density | 1 pF counts as |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | `rhigh` | 1360 Ω/sq | 0.5 µm | 1.84 µm² | `cap_cmomf` (MOM, Metal1 to Metal4) | 1.287 fF/µm² | 777 µm² |
| sky130 | `sky130_fd_pr__res_xhigh_po` | 2000 Ω/sq | 0.35 µm | 0.61 µm² | `sky130_fd_pr__cap_mim_m3_1` (MIM) | 2 fF/µm² | 500 µm² |

SG13CMOS5L has no MIM layer, so its densest capacitor is the MOM capacitor `cap_cmomf`. Its density is an estimate
from the simulation model of the PDK.

The limits come from the earlier gate area limits (60 µm² and 80 µm²). The new limit is the old limit times the
ratio of the area to the gate area of the reference fix, rounded to 10 µm²:

| PDK | Fix: gate area | Fix: R and C (5 kΩ, 1 pF) | Fix: area | Old limit (gate area) | New limit (area) |
| --- | --- | --- | --- | --- | --- |
| sg13cmos5l | 50 µm² | 777.92 µm² | 827.92 µm² | 60 µm² | 1000 µm² |
| sky130 | 58 µm² | 500.31 µm² | 558.31 µm² | 80 µm² | 770 µm² |

The per-element limits (R <= 1 MΩ, C <= 2 pF) do not change.

## Reference results

`reference.mjs` verifies four designs:

1. The reference fix of ota-sizing. The design part passes and every row passes. It is the known answer.
2. The original OTA of ota-sizing. The design part passes. The ss gain and the ss UGF fail, as in ota-sizing.
3. A cheat: an ideal voltage-controlled voltage source (E) with one RC pole and a bias resistor. The design part
   fails with three errors: the area (the 1 MΩ, 10 kΩ and 2 pF are 1740 µm² on sg13cmos5l and 1062 µm² on sky130),
   the E element and node 0. The simulation passes every row. The score gives 0 design points and 0 requirement
   points, also with a correct answer.
4. An input load: the reference fix with a 10 kΩ resistor from `inp` to `vss`. The source of `inp` supplies
   VCM / 10 kΩ. The source is ideal, so the other rows do not change. The design part passes. Only `iin_a` fails,
   at each corner. (A load on `inn` also increases the supply current, because the bench drives `inn` from the
   output of the OTA.)

For designs 1 and 2, the worst values and the gate area must be the same as in
`../ota-sizing/<pdk>/expected.json`. They are the same.

The worst values over the VCM range (failures in bold). The table does not show `iin_a`: the fix, the original and
the cheat pass it, and the input load fails it at each corner (see [The input current](#the-input-current)). The
input load has the same values as the fix in the other rows:

| PDK | Design | Gate area (µm²) | Corner | Gain (dB) | UGF (MHz) | PM (°) | IDD (µA) |
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

| PDK | Gain | UGF | PM | IDD | IIN | Area | R | C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | >= 48 dB | >= 13 MHz | >= 60° | <= 85 µA | <= 2 nA | <= 1000 µm² | <= 1 MΩ | <= 2 pF |
| sky130 | >= 65 dB | >= 15 MHz | >= 60° | <= 80 µA | <= 2 nA | <= 770 µm² | <= 1 MΩ | <= 2 pF |

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of ciel version
`1689ac3f2dc7`. `expected.json` has the image ID, the sweep of each corner and the design part of each design.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/ota-synthesis/reference.mjs sg13cmos5l`.
3. Run `node evals/ota-synthesis/reference.mjs sky130`.

## Variants

A variant is the task with tighter limits. The limits derive from a hidden design point, the target, with a
factor f. An agent can design to the base limits and stop there. In a variant, the agent must reach the target in each derived metric at the same time, with an area not larger
than f times the area of the target. Thus f is a difficulty control: f near 1 is the hardest task.

The target and the reference are different concepts:

- The reference (`<pdk>/expected.json`) is the known answer of the base task. It sets the base limits. It does
  not change.
- The target (`<pdk>/target.json`) is the best known design point of the task on the PDK. Its `source` tells
  how the design was found: the reference role `fix`, or an arm run. A verified design of an arm run replaces the
  target when it is at least as good in every derived metric.

The derived limits are in `family.json`: the gain (`lower_db`, step 0.5 dB), the UGF (`lower`, step 0.5 MHz), the
supply current (`upper`, step 1 µA) and the area (`upper`, step 1 µm²). The phase margin does not change.
For a factor f:

1. The worst value of a metric is the worst value of the target over the corners.
2. The raw limit is worst × f (`upper`), worst / f (`lower`) or worst − 20·log10(f) dB (`lower_db`).
3. The limit rounds to the step, in the direction that keeps a margin of at least f.
4. A limit never loosens. If the base limit is tighter than the rounded limit, the variant keeps the base limit.

The generator refuses f below 1 and f at or above the largest base factor (base limit divided by the worst value of
the target).

To make a variant:

1. Run `node evals/synthesis-family.mjs variant evals/ota-synthesis/<pdk> <factor>`.
2. The generator writes `evals/ota-synthesis/<pdk>-f<factor>/`: `spec.md`, `requirements.json`, `task.json` and
   `expected.json` with the new limits, and copies of the other task files. `expected.json` has a fourth role,
   `target`, and the limit margins. It comes from the base `expected.json` and `target.json`, without a
   simulation.
3. Run an arm on the variant directory as on the base task (see [Run an arm](#run-an-arm)).

To replace the target with the design of an arm run:

1. Run `node evals/synthesis-family.mjs target evals/ota-synthesis/<pdk> <run dir>`. The generator refuses a run
   whose design check or rows fail, and a run that is worse than the current target in a derived metric.
2. Make the committed variants again (step 1 above) and run `npm test`.

The targets:

| PDK | Source | Gain | UGF | IDD | Area (gate area) |
| --- | --- | --- | --- | --- | --- |
| sg13cmos5l | a verified run design (`source` in `target.json`) | 51.54 dB | 19.72 MHz | 78.1 µA | 471.75 µm² (43.2 µm²) |
| sky130 | the reference role `fix` | 65.24 dB | 17.50 MHz | 74.5 µA | 558.31 µm² (58 µm²) |

On sg13cmos5l, the target is a verified run design. It is at least as good as the fix in each derived metric. It is a two-stage
OTA with a PMOS input pair and Miller compensation with a series resistor (10 MOS devices, 6.5 kΩ and 0.55 pF).
Its area is 471.75 µm², and the area of the fix is 827.92 µm². It passes `iin_a`: the worst value is 16.6 pA. `test/synthesis-target.test.mjs` verifies the design of the run again in the
container and compares the results with `target.json`.

The committed variants, at f = 1.05 (base limit → variant limit, and the real margin of the target in parentheses):

| Variant | Gain | UGF | IDD | Area |
| --- | --- | --- | --- | --- |
| `sg13cmos5l-f1.05` | 48 → 51 dB (1.064) | 13 → 18.5 MHz (1.066) | 85 → 82 µA (1.050) | 1000 → 496 µm² (1.051) |
| `sky130-f1.05` | 65 dB, no change (1.028) | 15 → 16.5 MHz (1.061) | 80 → 79 µA (1.060) | 770 → 587 µm² (1.051) |

In both variants, the original and the input load fail the spec. On SKY130, the reference fix meets the spec. On
sg13cmos5l, the reference fix fails the variant: its area (827.92 µm²) is above the limit, its ss gain fails and
its ff supply current fails. `expected.json` of the variant records this.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/ota-synthesis/<pdk> <arm> [--model <id>] --timeout-min 30`.
