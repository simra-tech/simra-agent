Design the power-amplifier output stage of `spec.md` for the IHP SG13G2 PDK.

1. Write the stage as the subcircuit `pa_stage` in `pa_stage.spice`, with the pins of `spec.md` in the given order.
   The topology is free. Use only the devices of `spec.md`.
2. Draw at least one passive of the signal path as a layout, simulate it with `em_sparameters`, fit it with
   `fit_to_spice`, and copy the fitted subcircuit into `pa_stage.spice` without a change.
3. Verify the stage with `check_requirements` (the benches `hb.spice` and `sp.spice` at every corner of
   `requirements.json`, with the stability gate, the operating-limit gate under the drive, the netlist gate and the
   fit-band gate). Do not change `hb.spice`, `sp.spice` or `requirements.json`.
4. Write `answer.json`:

```json
{
  "meets_spec": true,
  "rows": [ { "corner": "tt", "requirement": "pout_tt", "value": 4.0, "pass": true } ],
  "em_passive": "the name of the fitted subcircuit, and the GDS file",
  "notes": "one short paragraph: the topology, and each row or gate row that does not pass"
}
```

`rows` has one entry for each corner and each requirement of `requirements.json` (15 entries), with the value of your
final design. `meets_spec` is true only when every row and every gate row passes and the design has an EM passive.
