This directory holds the specification of a comparator for the IHP SG13CMOS5L PDK. The comparator does not exist
yet:

- `spec.md`: the specification. It gives the conditions, the corners, the requirements and the design rules.
- `verify.spice`: the verification bench of `spec.md`. It runs one transient analysis for each VCM point and
  prints one `ROW` line per point with the eight values. It has no model library line.
- `requirements.json`: the corners (model library section, VDD, temperature), the limits of `spec.md` and the
  design contract: the pins of `cmp`, the permitted element kinds and the design limits.

ngspice and the IHP SG13CMOS5L PDK are available through `./sim.sh <deck>`. It runs `ngspice -b <deck>`.
The PDK is at `$PDK_ROOT/ihp-sg13cmos5l`.

Design the comparator. Write it as the subcircuit `cmp` in `cmp.spice` in this directory, with the pins of
`spec.md`. The topology is free. The comparator must meet `spec.md` at every corner and at each VCM in the range.
Obey the design rules of `spec.md`: the devices, the sizes, the minimum sizes and the area. Give the sizes
in metres with a scale suffix, for example `w=2u l=0.5u`.

The score checks the final `cmp.spice` against the design contract of `requirements.json`. Then it verifies
`cmp.spice` with `verify.spice` at each corner of `requirements.json`. To run the bench with `./sim.sh`, write a
top deck for the corner: the `.lib` line, `.include "verify.spice"`, and then `.param vdd=<VDD>` and
`.temp <temperature>` (after the include, so that they replace the values in the bench).

When you are done, write `answer.json` in this directory, in the format below. The rows are for the final
`cmp.spice`. Give one row for each corner (tt, ss, ff) and each requirement (tpd_r_s, tpd_f_s, voh_rel, vol_rel,
vos_v, hyst_v, idd_a, iin_a): 24 rows. In each row, give the worst value over the VCM points of the bench, and the
VCM in V where it occurs. The worst value is the value nearest to the limit: for a limit "between", the value
nearest to one of the two ends. Give the delays in s, the offset and the hysteresis in V, the supply current and
the input current in A, and voh_rel and vol_rel as fractions of VDD. Give the area of `cmp.spice` in µm² in
`area_um2` (the gate area plus the area of the R and C). If you cannot meet the spec, give the best design that you
found and set `meets_spec` to false.

```json
{
  "meets_spec": true,
  "area_um2": 0,
  "rows": [
    { "corner": "tt", "requirement": "tpd_r_s", "value": 0, "vcm": 0, "pass": true, "evidence": "<a file in this directory, or a run id>" }
  ]
}
```

Use only numbers that a simulation of the final `cmp.spice` gave. Do not estimate.
