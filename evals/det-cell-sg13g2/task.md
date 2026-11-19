Design the power detector cell of `spec.md` for the IHP SG13G2 PDK.

1. Write the cell as the subcircuit `det_cell` in `det_cell.spice`, with the pins of `spec.md` in the given order.
   The topology is free. Use only the devices of `spec.md`.
2. Verify it with the bench `verify.spice` at every corner of `requirements.json`. Do not change `verify.spice` or
   `requirements.json`.
3. Write `answer.json`:

```json
{
  "meets_spec": true,
  "rows": [ { "corner": "tt", "requirement": "idd_a", "value": 1.0e-4, "pass": true } ],
  "vce_max_v": 1.2,
  "notes": "one short paragraph: the topology, and each row that does not pass"
}
```

`rows` has one entry for each corner and each requirement of `requirements.json` (30 entries), with the value of your
final design. `vce_max_v` is the largest DC V<sub>CE</sub> of any HBT at any corner. `meets_spec` is true only when
every row passes.
