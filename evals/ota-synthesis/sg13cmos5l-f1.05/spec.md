# OTA specification

Design an operational transconductance amplifier (OTA) for the IHP SG13CMOS5L PDK. The topology is free.

## Conditions

- Supply: VDD as given for the corner. VSS = 0 V.
- Input common-mode voltage: VCM from 0.40 V to 0.70 V. Each requirement applies at each VCM in this range.
- Bias: a 10 uA current flows into `ibias`.
- Load: CL = 2 pF from `out` to ground.
- Models: `$PDK_ROOT/ihp-sg13cmos5l/libs.tech/ngspice/models/cornerMOSlv.lib`, with the section of the corner.

## Corners

| Corner | Model section | VDD | Temperature |
| --- | --- | --- | --- |
| tt | `mos_tt` | 1.20 V | 27 °C |
| ss | `mos_ss` | 1.08 V | 125 °C |
| ff | `mos_ff` | 1.32 V | -40 °C |

## Requirements

This specification is a variant of ota-synthesis-sg13cmos5l with the limits at factor 1.05 of a hidden design point.

Each requirement applies at every corner and at each VCM in the range.

| Requirement | Id | Limit |
| --- | --- | --- |
| DC open-loop gain, at 1 Hz | `gain_db` | >= 51 dB |
| Unity-gain frequency | `ugf_hz` | >= 18.5 MHz |
| Phase margin | `pm_deg` | >= 60 ° |
| Supply current, into `vdd` | `idd_a` | <= 82 uA |
| Input current: the larger magnitude of the DC current into `inp` and into `inn` | `iin_a` | <= 2 nA |

## Design

- The OTA is the subcircuit `ota` in `ota.spice`, with the pins `inp inn out vdd vss ibias`, in this order.
  You write `ota.spice`.
- `inp` is the non-inverting input and `inn` is the inverting input. `vdd` and `vss` are the supplies. The bias
  current flows into `ibias` from the bench. The OTA connects to the bench only through its pins.
- Use only these elements:
  1. MOS devices of the model library of the corner: `sg13_lv_nmos`, `sg13_lv_pmos`. Write each device as an
     X line: `X<name> d g s b <model> w=<W> l=<L> ng=<fingers> m=<multiplier>`. `ng` and `m` are optional.
  2. Ideal resistors (R): each resistor is <= 1 MΩ.
  3. Ideal capacitors (C): each capacitor is <= 2 pF.
- Do not use other elements. Do not use a source (V, I, E, F, G, H, B), an M line, `.model`, `.option`,
  `.include`, `.lib` or `.param` in `ota.spice`. You can define more `.subckt` blocks in `ota.spice` and use
  them in `ota`.
- Give each size and each value as a plain number. Do not use an expression or a parameter. The sizes are in
  metres with a scale suffix: `w=2u l=0.5u`.
- Obey the minimum sizes of the PDK: W / ng >= 0.15 µm and L >= 0.13 µm.
- Area: the gate area plus the area of the R and C is <= 496 µm². Each instance of a block counts.
  1. Gate area: the sum of W × L over the MOS devices. W is the total width of all fingers. The multiplier m
     counts.
  2. A resistor R counts as the high-resistance poly resistor `rhigh` of the PDK at its minimum width:
     R × (0.5 µm)² / 1360 Ω (1360 Ω/sq). For example, 10 kΩ counts as 1.84 µm².
  3. A capacitor C counts as the MOM capacitor `cap_cmomf` of the PDK (Metal1 to Metal4; the PDK has no MIM
     capacitor): C / (1.287 fF/µm²). For example, 1 pF counts as 777 µm².

## Bench

`verify.spice` is the bench of this specification. It connects VDD, VSS = 0 V, 10 uA into `ibias` and
CL = 2 pF. It connects `out` to `inn` with unity feedback for the DC operating point, and opens the loop for the
AC analysis. It sweeps VCM over the range. It measures `idd_a` and `iin_a` at the DC operating point: `iin_a`
is the current of the source that drives `inp` and of the feedback path that drives `inn`.
