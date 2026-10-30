# OTA specification

The OTA is the subcircuit `ota` in `ota.spice`.

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

Each requirement applies at every corner and at each VCM in the range.

| Requirement | Id | Limit |
| --- | --- | --- |
| DC open-loop gain, at 1 Hz | `gain_db` | >= 48 dB |
| Unity-gain frequency | `ugf_hz` | >= 13 MHz |
| Phase margin | `pm_deg` | >= 60 ° |
| Supply current, into `vdd` | `idd_a` | <= 85 uA |

## Design limits

- Keep the topology. Do not add, remove or rename a device. Do not change a net, a model or the names of the
  parameters of a device.
- Change only the sizes: W, L and the number of fingers of the MOS devices, and the values of Rz and Cc. Give
  each size as a number.
- Gate area: the sum of W × L over the MOS devices is <= 60 µm². W is the total width of all fingers.
- Cc is <= 2 pF.
