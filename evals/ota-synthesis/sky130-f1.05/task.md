This directory holds the specification of an OTA for the SkyWater SKY130 PDK. The OTA does not exist yet:

- `spec.md`: the specification. It gives the conditions, the corners, the requirements and the design rules.
- `verify.spice`: the verification bench of `spec.md`. It sweeps VCM over the range and prints one `ROW` line
  per VCM with the five values. It has no model library line.
- `requirements.json`: the corners (model library section, VDD, temperature), the limits of `spec.md` and the
  design contract: the pins of `ota`, the permitted element kinds and the design limits.

ngspice and the SkyWater SKY130 PDK are available through `./sim.sh <deck>`. It runs `ngspice -b <deck>`.
The PDK is at `$PDK_ROOT/sky130A`.

Design the OTA. Write it as the subcircuit `ota` in `ota.spice` in this directory, with the pins of `spec.md`.
The topology is free. The OTA must meet `spec.md` at every corner and at each VCM in the range. Obey the design
rules of `spec.md`: the devices, the sizes, the minimum sizes and the area. Give W and L as plain
numbers in µm, for example `w=2 l=0.5` (the model library sets `.option scale=1.0u`).

The score checks the final `ota.spice` against the design contract of `requirements.json`. Then it verifies
`ota.spice` with `verify.spice` at each corner of `requirements.json`. To run the bench with `./sim.sh`, write a
top deck for the corner: the `.lib` line, `.include "verify.spice"`, and then `.param vdd=<VDD>` and
`.temp <temperature>` (after the include, so that they replace the values in the bench).

When you are done, write `answer.json` in this directory, in the format below. The rows are for the final
`ota.spice`. Give one row for each corner (tt, ss, ff) and each requirement (gain_db, ugf_hz, pm_deg, idd_a,
iin_a): 15 rows. In each row, give the worst value over the input common-mode range of the spec, and the VCM in V
where it occurs. Give the gain in dB, the unity-gain frequency in Hz, the phase margin in degrees, and the supply
current and the input current in A. Give the area of `ota.spice` in µm² in `area_um2` (the gate area plus the area
of the R and C). If you cannot meet the spec, give the best design that you found and set `meets_spec` to false.

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
