# OTA specification

The OTA is the subcircuit `ota` in `ota.spice`.

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

## Design limits

- Keep the topology. Do not add, remove or rename a device. Do not change a net, a model or the names of the
  parameters of a device.
- Change only the sizes: W, L and the number of fingers of the MOS devices, and the values of Rz and Cc. Give
  each size as a number.
- Gate area: the sum of W × L over the MOS devices is <= 80 µm². W is the total width of all fingers.
- Cc is <= 2 pF.
