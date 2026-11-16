Design the 61 GHz oscillator core of `spec.md` for the IHP SG13G2 PDK.

1. Write the core as the subcircuit `vco` in `vco.spice`, with the pins of `spec.md` in the given order. The topology
   is free. Use only the devices of `spec.md`. Name the two cross-coupled core transistors `xq1` and `xq2`.
2. Draw at least one passive (normally the tank inductor) as a layout, simulate it with `em_sparameters`, fit it with
   `fit_to_spice`, and copy the fitted subcircuit into `vco.spice` without a change.
3. Verify the core with `check_requirements` (the bench `osc.spice` at every corner and setting of
   `requirements.json`, with the operating-limit gate, the netlist gate and the fit-band gate). Do not change
   `osc.spice` or `requirements.json`.
4. Write `answer.json`:

```json
{
  "meets_spec": true,
  "rows": [ { "corner": "tt", "requirement": "f_low", "value": 59.0e9, "pass": true } ],
  "em_passive": "the name of the fitted subcircuit, and the GDS file",
  "notes": "one short paragraph: the topology, and each row or gate row that does not pass"
}
```

`rows` has one entry for each corner and each requirement of `requirements.json` (13 entries), with the value of your
final design. Add one entry for the reported row `pn_dev` at `slow_hot` (the check lists it as REPORTED; it is measured
and not scored, so its "pass" is null): 14 entries. `meets_spec` is true only when every row and every gate row passes
and the design has an EM passive; the reported row does not change it.
