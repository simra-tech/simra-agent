# OTA specification

The OTA is the subcircuit `ota` in `ota.spice`.

## Conditions

- Supply: VDD as given for the corner. VSS = 0 V.
- Input common-mode voltage: VCM = VDD / 2.
- Bias: a 10 uA current flows into `ibias`.
- Load: CL = 2 pF from `out` to ground.

## Corners

| Corner | MOS model section (`cornerMOSlv.lib`) | VDD | Temperature |
| --- | --- | --- | --- |
| tt | `mos_tt` | 1.20 V | 27 °C |
| ss | `mos_ss` | 1.08 V | 125 °C |
| ff | `mos_ff` | 1.32 V | -40 °C |

## Requirements

Each requirement applies at every corner.

| Requirement | Id | Limit |
| --- | --- | --- |
| DC open-loop gain, at 1 Hz | `gain_db` | >= 51 dB |
| Unity-gain frequency | `ugf_hz` | >= 18 MHz |
| Phase margin | `pm_deg` | >= 60 ° |
