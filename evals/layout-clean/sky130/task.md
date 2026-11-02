This directory holds the layout of a small analog cell for the SkyWater SKY130 PDK:

- `cell.gds`: the layout. The top cell is `diffpair`.
- `cell.spice`: the reference netlist of the cell.
- `spec.md`: the specification: the circuit, the pins and their order, the layers of the pins, and the checks.
- `drc.sh`: runs the stock KLayout DRC of the PDK with the main rule set. `./drc.sh cell.gds diffpair` writes
  the results to `drc/` and prints the report file and the marker count of each rule.
- `lvs.sh`: runs the stock KLayout LVS of the PDK. `./lvs.sh cell.gds diffpair` compares the layout with
  `cell.spice`, writes the results to `lvs/` and prints the report file and the LVS status.

KLayout (`klayout -b`) and its Python module `klayout.db` are available. The PDK is at `$PDK_ROOT/sky130A`.

Verify `cell.gds`: run the DRC and the LVS. If a check finds a problem, fix it in `cell.gds`, and keep the circuit,
the devices and the pins. Do not change a layout that passes the checks. Do not change `cell.spice`, `drc.sh` or
`lvs.sh`.

When you are done, write `answer.json` in this directory, in the format below.

```json
{
  "drc_clean": true,
  "lvs_match": true,
  "checks": [
    { "check": "drc", "ran": true, "command": "./drc.sh cell.gds diffpair", "report": "drc/diffpair.lyrdb", "markers": 0 },
    { "check": "lvs", "ran": true, "command": "./lvs.sh cell.gds diffpair", "report": "lvs/diffpair.lvsdb", "status": "MATCH" }
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
- `fixed`: each rule that you fixed, with its marker count before the fix. If you fixed nothing, give an empty list.

Use only numbers that a run of the scripts on the final `cell.gds` gave. Do not estimate.
