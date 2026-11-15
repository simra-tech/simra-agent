Design the power detector cell and its line tap of `spec.md` for the IHP SG13G2 PDK.

1. Write the cell as the subcircuit `det_cell` in `det_cell.spice`, with the pins of `spec.md` in the given order.
   The topology is free. Use only the devices of `spec.md`.
2. Draw the line tap as the cell `tap` in `tap.gds`, with the line and the port positions of `spec.md`.
3. Verify both with `check_requirements` (every corner of `requirements.json`, the Monte Carlo offset, the
   operating-limit gate and the EM rows of the tap). Do not change `verify.spice`, `offset.spice` or
   `requirements.json`.
4. Write `answer.json`:

```json
{
  "meets_spec": true,
  "rows": [
    { "corner": "tt", "requirement": "idd_a", "value": 1.0e-4, "pass": true },
    { "corner": null, "requirement": "tap_s31", "value": -20.0, "pass": true }
  ],
  "notes": "one short paragraph: the topology, the tap, and each row or gate row that does not pass"
}
```

`rows` has one entry for each corner and each requirement of `requirements.json` (35 entries for the cell, and one
entry with `"corner": null` for each tap row: 37 entries), with the value of your final design. `meets_spec` is
true only when every row and every gate row passes.
