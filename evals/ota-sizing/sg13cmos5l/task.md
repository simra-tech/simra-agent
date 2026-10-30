This directory holds a two-stage Miller OTA for the IHP SG13CMOS5L PDK:

- `ota.spice`: the OTA subcircuit.
- `spec.md`: the specification. It gives the conditions, the corners, the requirements and the design limits.
- `verify.spice`: the verification bench of `spec.md`. It sweeps VCM over the range and prints one `ROW` line
  per VCM with the four values. It has no model library line.
- `requirements.json`: the corners (model library section, VDD, temperature) and the limits of `spec.md`.

ngspice and the IHP SG13CMOS5L PDK are available through `./sim.sh <deck>`. It runs `ngspice -b <deck>`.
The PDK is at `$PDK_ROOT/ihp-sg13cmos5l`.

The score verifies the final `ota.spice` with `verify.spice` at each corner of `requirements.json`. To run the
bench with `./sim.sh`, write a top deck for the corner: the `.lib` line, `.include "verify.spice"`, and then
`.param vdd=<VDD>` and `.temp <temperature>` (after the include, so that they replace the values in the bench).

The OTA does not meet `spec.md`. Change the sizes in `ota.spice` so that the OTA meets `spec.md` at every
corner and at each VCM in the range. Obey the design limits of `spec.md`.

When you are done, write `answer.json` in this directory, in the format below. The rows are for the final
`ota.spice`. Give one row for each corner (tt, ss, ff) and each requirement (gain_db, ugf_hz, pm_deg, idd_a):
12 rows. In each row, give the worst value over the input common-mode range of the spec, and the VCM in V where
it occurs. Give the gain in dB, the unity-gain frequency in Hz, the phase margin in degrees and the supply
current in A. If you cannot meet the spec, give the best design that you found and set `meets_spec` to false.

```json
{
  "meets_spec": true,
  "area_um2": 0,
  "rows": [
    { "corner": "tt", "requirement": "gain_db", "value": 0, "vcm": 0, "pass": true, "evidence": "<a file in this directory, or a run id>" }
  ]
}
```

Use only numbers that a simulation of the final `ota.spice` gave. Do not estimate.
