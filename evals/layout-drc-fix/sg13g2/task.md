This directory holds the layout of a small analog cell for the IHP SG13G2 PDK:

- `cell.gds`: the layout. The top cell is `diffpair`.
- `cell.spice`: the reference netlist of the cell.
- `spec.md`: the specification: the circuit, the pins and their order, the layers of the pins, and the checks.
- `drc.sh`: runs the stock KLayout DRC of the PDK with the main rule set. `./drc.sh cell.gds diffpair` writes
  the results to `drc/` and prints the report file and the marker count of each rule.
- `lvs.sh`: runs the stock KLayout LVS of the PDK. `./lvs.sh cell.gds diffpair` compares the layout with
  `cell.spice`, writes the results to `lvs/` and prints the report file and the LVS status.

KLayout (`klayout -b`) and its Python module `klayout.db` are available. The PDK is at `$PDK_ROOT/ihp-sg13g2`.

`cell.gds` has DRC violations. Fix them in `cell.gds`. After the fix, the DRC must report 0 markers, and LVS must
still match `cell.spice` with the same pins. Keep the circuit, the devices and the pins. Do not change `cell.spice`,
`drc.sh` or `lvs.sh`.

When you are done, write `answer.json` in this directory, in the format below.

```json
{
  "drc_clean": true,
  "lvs_match": true,
  "checks": [
    { "check": "drc", "ran": true, "command": "./drc.sh cell.gds diffpair", "report": "drc/cell_diffpair_main.lyrdb", "markers": 0 },
    { "check": "lvs", "ran": true, "command": "./lvs.sh cell.gds diffpair", "report": "lvs/cell.lvsdb", "status": "MATCH" }
  ],
  "fixed": [
    { "rule": "<rule name as the DRC report gives it>", "markers_before": 0 }
  ]
}
```

- `drc_clean`: true if the DRC of the final `cell.gds` reports 0 markers.
- `lvs_match`: true if the LVS of the final `cell.gds` reports that the netlists match.
- `checks`: one row for each check (drc and lvs) on the final `cell.gds`. Give the command, the report file in
  this directory, and the marker count (DRC) or the LVS status (LVS) as the script printed them. If a check did not
  run, give `"ran": false` and the reason in `"note"`. Do not leave out a check.
- `fixed`: each rule that had markers in the original `cell.gds`, with its marker count before the fix.

Use only numbers that a run of the scripts on the final `cell.gds` gave. Do not estimate.
