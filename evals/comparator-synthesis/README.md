# Demo evaluation: design a comparator from a pin specification

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check a change
quickly, from start to end, with a real model. Do not use its score to compare harnesses or to make a release
decision: one small public task cannot support that.

This task is a synthesis task, in the same form as [ota-synthesis](../ota-synthesis/README.md). The agent gets a
specification at the pins, a transient verification bench and the requirements. It gets no netlist. It must
write a continuous-time comparator in `cmp.spice`: the topology, the devices and the sizes. The comparator must
meet `spec.md` at each corner and at each VCM point of the bench. The task has the same form for two PDKs,
because a feature that uses PDK knowledge must have its evaluation on at least two PDKs.

| Directory | PDK | MOS devices | VCM points |
| --- | --- | --- | --- |
| `sg13cmos5l/` | IHP SG13CMOS5L | `sg13_lv_nmos`, `sg13_lv_pmos` | 0.4, 0.475, 0.55, 0.625, 0.7 V |
| `sky130/` | SkyWater SKY130 | `sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8`, `sky130_fd_pr__nfet_01v8_lvt`, `sky130_fd_pr__pfet_01v8_lvt`, `sky130_fd_pr__pfet_01v8_hvt` | 0.8, 0.9, 1, 1.1, 1.2 V |

The corners, VDD, the temperatures, the model library, the VCM range and the design rules are the same as in
ota-synthesis. The requirements, the load, the bench and the area limit are different.

| File | Contents |
| --- | --- |
| `synthesis.mjs` | the shared parts: spec parser, requirement ids, tolerances; the verification and the scorer of `../ota-synthesis/synthesis.mjs` |
| `reference.mjs` | the reference results of a task: a known pass, a known fail, a cheat and an input load |
| `<pdk>/task.md` | the prompt, the same for every arm |
| `<pdk>/spec.md` | the specification: conditions, corners, requirements and design rules |
| `<pdk>/verify.spice` | the transient verification bench |
| `<pdk>/requirements.json` | the corners, the limits and the design contract (the `design` section) |
| `<pdk>/simra.config.json` | the environment of the task (the same as in ota-synthesis) |
| `<pdk>/expected.json` | the reference results, the limit margins and their provenance |
| `<pdk>/score.mjs` | the scorer for one workspace (it calls `synthesis.mjs`) |
| `<pdk>/task.json` | the task manifest for `../run-arm.mjs` |
| `family.json` | the variants: the roles of `expected.json` and the limits that derive from the target |
| `<pdk>/target.json` | the target: the best known design point of the task on the PDK, with provenance |
| `<pdk>-f<factor>/` | a variant of the task with tighter limits (see [Variants](#variants)) |

## The task

1. Write the subcircuit `cmp` in `cmp.spice`, with the pins `inp inn out vdd vss ibias`, in this order. `out` is
   high when v(inp) > v(inn), and low when v(inp) < v(inn).
2. Use only the MOS devices of the model library of the corner, ideal resistors up to 1 MΩ and ideal capacitors
   up to 2 pF. Do not use a source, a behavioural element, `.model`, `.option`, `.include`, `.lib` or `.param`.
3. Give each size as a plain number. Obey the minimum sizes of the PDK. On SKY130, W and L are in µm without a
   suffix (`w=2 l=0.5`), because the model library sets `.option scale=1.0u`. On IHP, they are in metres with a
   suffix (`w=2u l=0.5u`).
4. Obey the area limit: the gate area plus the area of the R and C is <= 30 µm². The R and C count as in
   ota-synthesis (see [The area](../ota-synthesis/README.md#the-area)).
5. Write `answer.json`: the claim `meets_spec`, the area, and for each corner and requirement the worst value over
   the VCM points and its VCM.

## The bench

`verify.spice` sets VCM on `inn` and the differential input Vd = v(inp) - v(inn) with a PWL source from `inn` to
`inp`. It connects 10 µA into `ibias` (from the `vdd` net) and CL = 50 fF from `out` to ground. For each VCM point
(`alter` of the VCM source), it calculates one DC operating point with Vd = -10 mV, then it runs one transient
analysis from 0 to 21.2 µs with a maximum time step of 0.5 ns and no `uic`. It prints one `ROW` line with eight
values:

| Id | Measurement |
| --- | --- |
| `tpd_r_s` | Vd steps from -10 mV to +10 mV at 100 ns: the time from Vd = 0 to v(out) = VDD / 2 (rising) |
| `tpd_f_s` | Vd steps from +10 mV to -10 mV at 600 ns: the time from Vd = 0 to v(out) = VDD / 2 (falling) |
| `voh_rel` | v(out) / VDD at 590 ns (Vd = +10 mV) |
| `vol_rel` | v(out) / VDD at 1.09 µs (Vd = -10 mV) |
| `vos_v` | the mean of the two switching points of the slow ramp |
| `hyst_v` | the rising switching point minus the falling switching point |
| `idd_a` | the current from the `vdd` source at 1.09 µs (Vd = -10 mV), with the 10 µA of the bias |
| `iin_a` | at the DC operating point: the larger magnitude of the current into `inp` (from the Vd source) and into `inn` (from the Vd and VCM sources) |

The slow ramp goes from -50 mV to +50 mV in 10 µs and back. A switching point is the value of Vd when v(out)
crosses VDD / 2. The ramp is slow: with the reference designs, the delay of the comparator moves each switching
point by less than 0.2 mV. A crossing that does not occur gives no value, and the requirement fails at that point.

## Scoring

The scorer is the `scoreSynthesis()` of `../ota-synthesis/synthesis.mjs`, with the tolerances of this task. It
does not use the numbers of the answer to find if the design meets the spec. It runs the check of
`requirements.json` on the final `cmp.spice`: first the design check (a lint of the netlist against the design
contract, without a simulation), then the bench at each corner and at each VCM point. The scorer writes these
experiments in `verify/` in the run directory.

| Part | Points | A point is given when |
| --- | --- | --- |
| design | 2 | the design part of the verdict is `pass` (the contract, the element rules and the limits) |
| requirements | 24 | the verified worst value of a row passes (only when the design part passes) |
| claim | 4 | `meets_spec` is the same as the verification (the design part and all rows) |
| values | 24 | the reported worst value of a row is within the tolerance of the verified worst value |

Tolerances: delays ±5 %, `voh_rel` and `vol_rel` ±0.01, offset and hysteresis ±0.1 mV, supply current ±2 %,
input current ±2 % or ±20 pA (either one is sufficient).

The diagnostics are the same as in ota-synthesis: `area_um2`, `gate_area_um2`, `passive_area_um2`, `mos_count`,
`design_errors`, `supported`,
`verification` and `errors`.

## Reference results

`reference.mjs` verifies four designs:

1. The reference: an NMOS differential pair with a PMOS current-mirror load, a PMOS common-source second stage
   with an NMOS current sink, and a CMOS inverter at the output. It has 10 MOS devices. The design part passes
   and every row passes. It is the known answer.
2. The known fail: the reference with one change. The tail current source XM5 has half its width. The design
   part passes. At least 2 rows fail at one corner: on sg13cmos5l at each corner, on SKY130 at ss (the fall
   delay and the offset) and at tt (the fall delay).
3. A cheat: a behavioural source (B) with a tanh of the input, a 1 kΩ output resistor and a bias resistor to
   node 0. The design part fails with two errors: the B element and node 0. (Its R area is below the limit.) The simulation passes every row. The
   score gives 0 design points and 0 requirement points, also with a correct answer.
4. An input load: a design with a resistive divider on each input, so that the bench sources supply the input
   current. The design part passes. Only `iin_a` fails, at each corner. On sg13cmos5l, it has 1 kΩ from the input to a gate node and
   3 kΩ from the gate node to `vss`. On SKY130, it is the reference with the input load of ota-synthesis (1 kΩ and 30 kΩ).

The worst values over the VCM points (failures in bold). The delays are in ns, `vos_v` and `hyst_v` in mV, and
IDD in µA:

| PDK | Design | Area (µm²) | Corner | tpd_r | tpd_f | voh_rel | vol_rel | vos | hyst | IDD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | reference | 20.39 | tt | 2.68 | 3.56 | 1.000 | 0.000 | -1.65 | 0.16 | 58.3 |
| sg13cmos5l | reference | 20.39 | ss | 2.68 | 4.31 | 1.000 | 0.000 | -2.75 | 0.18 | 56.0 |
| sg13cmos5l | reference | 20.39 | ff | 2.70 | 2.99 | 1.000 | 0.000 | -1.00 | 0.14 | 60.6 |
| sg13cmos5l | known fail | 18.39 | tt | 3.19 | **8.64** | 1.000 | 0.000 | **-6.56** | 0.21 | 46.2 |
| sg13cmos5l | known fail | 18.39 | ss | **5080.21** | **514.31** | 1.000 | **1.000** | **-13.13** | 0.20 | 50.4 |
| sg13cmos5l | known fail | 18.39 | ff | 3.74 | **6.73** | 1.000 | 0.000 | -4.06 | 0.21 | 48.5 |
| sky130 | reference | 22.45 | tt | 3.75 | 3.08 | 1.000 | 0.000 | -0.43 | 0.16 | 51.7 |
| sky130 | reference | 22.45 | ss | 4.23 | 3.90 | 1.000 | 0.000 | -0.84 | 0.16 | 53.6 |
| sky130 | reference | 22.45 | ff | 3.15 | 2.29 | 1.000 | 0.000 | -0.44 | 0.13 | 50.7 |
| sky130 | known fail | 20.45 | tt | 5.16 | **6.07** | 1.000 | 0.000 | -2.38 | 0.23 | 41.7 |
| sky130 | known fail | 20.45 | ss | 5.63 | **8.93** | 1.000 | 0.000 | **-5.84** | 0.19 | 41.9 |
| sky130 | known fail | 20.45 | ff | 4.29 | 4.46 | 1.000 | 0.000 | -1.76 | 0.20 | 41.6 |

At ss, the sg13cmos5l known fail does not follow the ±10 mV steps at all VCM points. Its delays of 5 µs and
0.5 µs are crossings later in the transient. The reference has a hysteresis of 0.13 mV to 0.18 mV: this is the
shift of the two switching points by the delay of the comparator on the slow ramp.

The table does not show `iin_a`. The reference, the known fail and the cheat pass it: at most 1.3 pA. The input
load fails it at each corner. The values are in
[The input current](../ota-synthesis/README.md#the-input-current) of ota-synthesis.

## The limits

The input current limit is the same as in ota-synthesis (see
[The input current](../ota-synthesis/README.md#the-input-current)). The delay, supply current and area limits
come from the reference: the worst value of the reference times
1.3, rounded up to a round number. `reference.mjs` checks that each limit is at least 1.3 times the worst value
of the reference.

| PDK | tpd_r, tpd_f | voh_rel | vol_rel | vos | hyst | IDD | IIN | Area | R | C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sg13cmos5l | <= 6 ns | >= 0.9 | <= 0.1 | -5 mV to 5 mV | 0 to 20 mV | <= 80 µA | <= 2 nA | <= 30 µm² | <= 1 MΩ | <= 2 pF |
| sky130 | <= 6 ns | >= 0.9 | <= 0.1 | -5 mV to 5 mV | 0 to 20 mV | <= 70 µA | <= 2 nA | <= 30 µm² | <= 1 MΩ | <= 2 pF |

The references have no R and no C, so their area is the gate area. The area limit stays at 30 µm².

The limit divided by the worst value of the reference:

| PDK | tpd_r | tpd_f | IDD | Area |
| --- | --- | --- | --- | --- |
| sg13cmos5l | 2.22 | 1.39 | 1.32 | 1.47 |
| sky130 | 1.42 | 1.54 | 1.31 | 1.34 |

ngspice 47 in the IIC-OSIC-TOOLS 2026.10 image. IHP PDK commit `a49358cc0b20`. SKY130: `sky130A` of ciel version
`1689ac3f2dc7`. `expected.json` has the image ID, the sweep of each corner and the design part of each design.

To make the results again:

1. Write `examples/ota-sg13g2/simra.local.json` for your container image (see the example README). Both tasks
   use this file for the image.
2. Run `node evals/comparator-synthesis/reference.mjs sg13cmos5l`.
3. Run `node evals/comparator-synthesis/reference.mjs sky130`.

The designs run one after the other. A run takes some minutes for each PDK.

## Variants

A variant is the task with tighter limits. The limits derive from a hidden design point, the target, with a
factor f. The base limits are 1.3 times the worst values of the reference, and an agent can design to these
limits and stop there. In a variant, the agent must reach the target in each derived metric at the same time, with an
area not larger than f times the area of the target. Thus f is a difficulty control: f near 1 is the hardest
task.

The target and the reference are different concepts:

- The reference (`<pdk>/expected.json`) is the known answer of the base task. It sets the base limits. It does
  not change.
- The target (`<pdk>/target.json`) is the best known design point of the task on the PDK. Its `source` tells
  how the design was found: the reference role `reference`, or an arm run. A verified design of an arm run
  replaces the target when it is at least as good in every derived metric.

The derived limits are in `family.json`: the two delays (`upper`, step 0.1 ns), the supply current (`upper`, step
1 µA) and the area (`upper`, step 0.1 µm²). `voh_rel`, `vol_rel`, `vos_v` and `hyst_v` do not change. The
derivation, the refusals and the procedures are the same as in
[ota-synthesis](../ota-synthesis/README.md#variants). Use `evals/comparator-synthesis/<pdk>` as the task
directory.

The targets:

| PDK | Source | tpd_r | tpd_f | IDD | Area |
| --- | --- | --- | --- | --- | --- |
| sg13cmos5l | the reference | 2.70 ns | 4.31 ns | 60.6 µA | 20.39 µm² |
| sky130 | a verified run design (`source` in `target.json`) | 1.03 ns | 0.97 ns | 48.4 µA | 7.315 µm² |

On SKY130, the target is a verified run design. Compared with the reference, the delays are 0.24 and
0.25 of the reference, the supply current 0.90 and the area 0.33. It is an NMOS differential pair with a
PMOS current-mirror load, a PMOS common-source second stage and two inverters (12 MOS devices, no R and no C). Its
input current is 0 A. `test/synthesis-target.test.mjs` verifies the design of the run again in the container and
compares the results with `target.json`.

The committed variants, at f = 1.05 (base limit → variant limit, and the real margin of the target in parentheses):

| Variant | tpd_r | tpd_f | IDD | Area |
| --- | --- | --- | --- | --- |
| `sg13cmos5l-f1.05` | 6 → 2.9 ns (1.075) | 6 → 4.6 ns (1.068) | 80 → 64 µA (1.057) | 30 → 21.5 µm² (1.054) |
| `sky130-f1.05` | 6 → 1.1 ns (1.070) | 6 → 1.1 ns (1.137) | 70 → 51 µA (1.053) | 30 → 7.7 µm² (1.053) |

In both variants, the known fail and the input load fail the spec. On sg13cmos5l, the reference meets the spec. On
SKY130, the reference fails the variant: its area (22.45 µm²) is above the limit, and its delays fail at each
corner. `expected.json` of the variant records this.

## Run an arm

See [ota-corners](../ota-corners/README.md#run-an-arm) for the arms and the sandbox.

1. Build the environment image with `container/build.sh`.
2. Write `examples/ota-sg13g2/simra.local.json` for this image.
3. Put the key variable of the model in the environment or in `.env` in the repository root.
4. Run `node evals/run-arm.mjs evals/comparator-synthesis/<pdk> <arm> [--model <id>] --timeout-min 30`.
