Design the low-noise amplifier of `spec.md` for the IHP SG13G2 PDK.

1. Write the amplifier as the subcircuit `lna` in `lna.spice`, with the pins of `spec.md` in the given order. The
   topology is free. Use only the devices of `spec.md`.
2. Draw at least one passive of the signal path as a layout, simulate it with `em_sparameters`, fit it with
   `fit_to_spice`, and copy the fitted subcircuit into `lna.spice` without a change.
3. Verify the amplifier with `check_requirements` (the benches `sp.spice` and `noise.spice` at every corner of
   `requirements.json`, with the stability gate and the operating-limit gate). Do not change `sp.spice`,
   `noise.spice`, `lines.spice` or `requirements.json`.
4. Write `answer.json`:

```json
{
  "meets_spec": true,
  "rows": [ { "corner": "tt", "requirement": "gain", "value": 14.0, "pass": true } ],
  "em_passive": "the name of the fitted subcircuit, and the GDS file",
  "notes": "one short paragraph: the topology, and each row or gate row that does not pass"
}
```

`rows` has one entry for each corner and each requirement of `requirements.json` (13 entries), with the value of your
final design. `meets_spec` is true only when every row and every gate row passes and the design has an EM passive.
