# OTA specification

Design an operational transconductance amplifier (OTA) for the SkyWater SKY130 PDK. The topology is free.

## Conditions

- Supply: VDD as given for the corner. VSS = 0 V.
- Input common-mode voltage: VCM from 0.80 V to 1.20 V. Each requirement applies at each VCM in this range.
- Bias: a 10 uA current flows into `ibias`.
- Load: CL = 2 pF from `out` to ground.
- Models: `$PDK_ROOT/sky130A/libs.tech/ngspice/sky130.lib.spice`, with the section of the corner.

## Corners

| Corner | Model section | VDD | Temperature |
| --- | --- | --- | --- |
| tt | `tt` | 1.80 V | 27 °C |
| ss | `ss` | 1.62 V | 125 °C |
| ff | `ff` | 1.98 V | -40 °C |

## Requirements

Each requirement applies at every corner and at each VCM in the range.

| Requirement | Id | Limit |
| --- | --- | --- |
| DC open-loop gain, at 1 Hz | `gain_db` | >= 65 dB |
| Unity-gain frequency | `ugf_hz` | >= 15 MHz |
| Phase margin | `pm_deg` | >= 60 ° |
| Supply current, into `vdd` | `idd_a` | <= 80 uA |

## Design

- The OTA is the subcircuit `ota` in `ota.spice`, with the pins `inp inn out vdd vss ibias`, in this order.
  You write `ota.spice`.
- `inp` is the non-inverting input and `inn` is the inverting input. `vdd` and `vss` are the supplies. The bias
  current flows into `ibias` from the bench. The OTA connects to the bench only through its pins.
- Use only these elements:
  1. MOS devices of the model library of the corner: `sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8`,
     `sky130_fd_pr__nfet_01v8_lvt`, `sky130_fd_pr__pfet_01v8_lvt`, `sky130_fd_pr__pfet_01v8_hvt`. Write each
     device as an X line: `X<name> d g s b <model> w=<W> l=<L> nf=<fingers> m=<multiplier>`. `nf` and `m` are
     optional.
  2. Ideal resistors (R): each resistor is <= 1 MΩ.
  3. Ideal capacitors (C): each capacitor is <= 2 pF.
- Do not use other elements. Do not use a source (V, I, E, F, G, H, B), an M line, `.model`, `.option`,
  `.include`, `.lib` or `.param` in `ota.spice`. You can define more `.subckt` blocks in `ota.spice` and use
  them in `ota`.
- Give each size and each value as a plain number. Do not use an expression or a parameter. The model library
  sets `.option scale=1.0u`, thus W and L are plain numbers in µm without a suffix: `w=2 l=0.5`, not `w=2u`.
- Obey the minimum sizes of the PDK. W is the total width of all fingers.

  | Device | Minimum W | Minimum L |
  | --- | --- | --- |
  | `sky130_fd_pr__nfet_01v8` | 0.36 µm | 0.15 µm |
  | `sky130_fd_pr__pfet_01v8` | 0.42 µm | 0.15 µm |
  | `sky130_fd_pr__nfet_01v8_lvt` | 0.42 µm | 0.15 µm |
  | `sky130_fd_pr__pfet_01v8_lvt` | 0.42 µm | 0.35 µm |
  | `sky130_fd_pr__pfet_01v8_hvt` | 0.36 µm | 0.15 µm |

- Gate area: the sum of W × L over the MOS devices is <= 80 µm². W is the total width of all fingers. The
  multiplier m and each instance of a block count.

## Bench

`verify.spice` is the bench of this specification. It connects VDD, VSS = 0 V, 10 uA into `ibias` and
CL = 2 pF. It connects `out` to `inn` with unity feedback for the DC operating point, and opens the loop for the
AC analysis. It sweeps VCM over the range.
