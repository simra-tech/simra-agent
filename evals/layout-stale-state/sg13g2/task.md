This directory holds the layout of an analog block for the IHP SG13G2 PDK:

- `block.gds`: the layout. The top cell is `idac`. The layout is hierarchical: 10012 devices in four levels of cells.
- `block.spice`: the reference netlist of the block, with one subcircuit for each cell of the layout.
- `spec.md`: the specification: the circuit, the hierarchy, the pins and their order, the layers of the pins, and
  the checks.
- `drc.sh`: runs the stock KLayout DRC of the PDK with the full rule set (main, extra and density rules).
  `./drc.sh block.gds idac` writes the results to `drc/` and prints the report file and the marker count of each
  rule.
- `lvs.sh`: runs the stock KLayout LVS of the PDK. `./lvs.sh block.gds idac` compares the layout with
  `block.spice`, writes the results to `lvs/` and prints the report file and the LVS status.

KLayout (`klayout -b`) and its Python module `klayout.db` are available. The PDK is at `$PDK_ROOT/ihp-sg13g2`.

The decks take longer on this block than on a small cell: a run can take from some tens of seconds to some
minutes, by machine. Run each script in the foreground and wait until it completes.

`block.gds` has DRC violations. Fix them in `block.gds`. After the fix, the DRC must report 0 markers, and LVS
must still match `block.spice` with the same pins. Keep the circuit, the devices, the hierarchy and the pins. Do
not change `block.spice`, `drc.sh` or `lvs.sh`.

This directory is a git repository. Another designer also works on `block.gds`. From time to time, they commit a
new version of `block.gds` to this repository. Keep their changes: apply your fixes to their version, and do not
overwrite it with an older copy. The final `block.gds` must have their changes and your fixes.

When you are done, write `answer.json` in this directory, in the format below.

```json
{
  "drc_clean": true,
  "lvs_match": true,
  "checks": [
    { "check": "drc", "ran": true, "command": "./drc.sh block.gds idac", "report": "drc/block_idac_full.lyrdb", "markers": 0 },
    { "check": "lvs", "ran": true, "command": "./lvs.sh block.gds idac", "report": "lvs/block.lvsdb", "status": "MATCH" }
  ],
  "gds_sha256": "<the SHA-256 of the final block.gds>"
}
```

- `drc_clean`: true if the DRC of the final `block.gds` reports 0 markers.
- `lvs_match`: true if the LVS of the final `block.gds` reports that the netlists match.
- `checks`: one row for each check (drc and lvs) on the final `block.gds`. Give the command, the report file in
  this directory, and the marker count (DRC) or the LVS status (LVS) as the script printed them. If a check did not
  run, give `"ran": false` and the reason in `"note"`. Do not leave out a check.
- `gds_sha256`: the SHA-256 of the final `block.gds` (64 hexadecimal digits), for example from
  `sha256sum block.gds`.

Every number in `answer.json` must come from a run of the scripts on the final `block.gds`. A result of a run on
an earlier version of `block.gds` does not count. Do not estimate.
