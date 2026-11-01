# Comparator specification

Design a continuous-time voltage comparator for the IHP SG13CMOS5L PDK. The topology is free.

## Conditions

- Supply: VDD as given for the corner. VSS = 0 V.
- Input common-mode voltage: VCM from 0.40 V to 0.70 V. Each requirement applies at each VCM in this range.
  The bench checks 5 points: 0.4, 0.475, 0.55, 0.625 and 0.7 V.
- Bias: a 10 uA current flows into `ibias`.
- Load: CL = 50 fF from `out` to ground.
- Models: `$PDK_ROOT/ihp-sg13cmos5l/libs.tech/ngspice/models/cornerMOSlv.lib`, with the section of the corner.

## Corners

| Corner | Model section | VDD | Temperature |
| --- | --- | --- | --- |
| tt | `mos_tt` | 1.20 V | 27 °C |
| ss | `mos_ss` | 1.08 V | 125 °C |
| ff | `mos_ff` | 1.32 V | -40 °C |

## Requirements

Each requirement applies at every corner and at each VCM in the range. Vd = v(inp) - v(inn) is the
differential input.

| Requirement | Id | Limit |
| --- | --- | --- |
| Rise delay: from Vd = 0 (step from -10 mV to +10 mV) to v(out) = VDD / 2 | `tpd_r_s` | <= 6 ns |
| Fall delay: from Vd = 0 (step from +10 mV to -10 mV) to v(out) = VDD / 2 | `tpd_f_s` | <= 6 ns |
| Output high level v(out) / VDD, at Vd = +10 mV | `voh_rel` | >= 0.9 |
| Output low level v(out) / VDD, at Vd = -10 mV | `vol_rel` | <= 0.1 |
| Input offset voltage: the mean of the two switching points of the slow ramp | `vos_v` | between -5 mV and 5 mV |
| Hysteresis: the rising switching point minus the falling switching point | `hyst_v` | between 0 mV and 20 mV |
| Supply current from the `vdd` source at Vd = -10 mV, with the 10 uA into `ibias` | `idd_a` | <= 80 uA |
| Input current at the DC operating point with Vd = -10 mV: the larger magnitude of the current into `inp` and into `inn` | `iin_a` | <= 2 nA |

## Design

- The comparator is the subcircuit `cmp` in `cmp.spice`, with the pins `inp inn out vdd vss ibias`, in this order.
  You write `cmp.spice`.
- `out` is high (near VDD) when v(inp) > v(inn), and low (near VSS) when v(inp) < v(inn). `vdd` and `vss` are
  the supplies. The bias current flows into `ibias` from the bench. The comparator connects to the bench only
  through its pins.
- Use only these elements:
  1. MOS devices of the model library of the corner: `sg13_lv_nmos`, `sg13_lv_pmos`. Write each device as an
     X line: `X<name> d g s b <model> w=<W> l=<L> ng=<fingers> m=<multiplier>`. `ng` and `m` are optional.
  2. Ideal resistors (R): each resistor is <= 1 MΩ.
  3. Ideal capacitors (C): each capacitor is <= 2 pF.
- Do not use other elements. Do not use a source (V, I, E, F, G, H, B), an M line, `.model`, `.option`,
  `.include`, `.lib` or `.param` in `cmp.spice`. You can define more `.subckt` blocks in `cmp.spice` and use
  them in `cmp`.
- Give each size and each value as a plain number. Do not use an expression or a parameter. The sizes are in
  metres with a scale suffix: `w=2u l=0.5u`.
- Obey the minimum sizes of the PDK: W / ng >= 0.15 µm and L >= 0.13 µm.
- Area: the gate area plus the area of the R and C is <= 30 µm². Each instance of a block counts.
  1. Gate area: the sum of W × L over the MOS devices. W is the total width of all fingers. The multiplier m
     counts.
  2. A resistor R counts as the high-resistance poly resistor `rhigh` of the PDK at its minimum width:
     R × (0.5 µm)² / 1360 Ω (1360 Ω/sq). For example, 10 kΩ counts as 1.84 µm².
  3. A capacitor C counts as the MOM capacitor `cap_cmomf` of the PDK (Metal1 to Metal4; the PDK has no MIM
     capacitor): C / (1.287 fF/µm²). For example, 1 pF counts as 777 µm².

## Bench

`verify.spice` is the bench of this specification. It connects VDD, VSS = 0 V, 10 uA into `ibias` and
CL = 50 fF. It sets VCM on `inn` and the differential input Vd from `inn` to `inp`. For each VCM point, it
calculates one DC operating point and runs one transient analysis:

1. The DC operating point with Vd = -10 mV: `iin_a` (the current of the sources that drive `inp` and `inn`).
   It has no capacitor current.
2. 0 to 100 ns: Vd = -10 mV. At 100 ns, Vd steps to +10 mV (`tpd_r_s`). At 590 ns: `voh_rel`.
3. At 600 ns, Vd steps to -10 mV (`tpd_f_s`). At 1.09 µs: `vol_rel` and `idd_a`.
4. 1.2 µs to 11.2 µs: Vd ramps from -50 mV to +50 mV (the rising switching point). 11.2 µs to 21.2 µs: Vd
   ramps back to -50 mV (the falling switching point). The ramp is 10 mV/µs.

A switching point is the value of Vd when v(out) crosses VDD / 2. If v(out) does not cross VDD / 2, the bench
gives no value for that point, and the requirement fails.
