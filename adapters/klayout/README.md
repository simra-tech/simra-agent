# klayout adapter

The klayout adapter runs the stock KLayout DRC and LVS decks of a PDK and gives typed verdicts. It follows the
JSON-in / JSON-out contract `simra.adapter/0` (see [CONTRIBUTING.md](../../CONTRIBUTING.md)). It is written in
Python and has no PDK facts. The deck commands, the report paths, the log texts and the exit codes come from the
`klayout` section of the technology pack (see [technologies/README.md](../../technologies/README.md)).

| File | Contents |
| --- | --- |
| `adapter.json` | the manifest: the command and the operations `drc` and `lvs` |
| `klayout_adapter.py` | the adapter |
| `lvsdb_probe.py` | reads an LVS database with `klayout.db.LayoutVsSchematic` and writes its compare result as JSON |
| `test_klayout_adapter.py` | host tests on the fixtures (no KLayout needed) |
| `fixtures/` | marker databases, LVS logs and probe outputs from runs in the container image |

## KLayout

The adapter finds the KLayout binary in this order:

1. `klayout` on `PATH`.
2. The path in the environment variable `SIMRA_KLAYOUT`. Set it in the `env` of the environment in
   `simra.config.json`, for example `"SIMRA_KLAYOUT": "/foss/tools/klayout/klayout"` for the IIC-OSIC-TOOLS image.

The adapter uses the first binary that runs `klayout -v`. If no binary runs, the response is failed, with an error
diagnostic. The adapter puts the directory of the binary at the start of `PATH` for the deck.

The environment must also give `PDK` and `PDK_ROOT`. The adapter uses the pack that lists `$PDK` (or the pack of
the input `technology`), and the facts of `klayout.<$PDK>`.

## Operation `drc`

| Input | Contents |
| --- | --- |
| `gds` | the layout, relative to the design root |
| `cell` | the top cell |
| `rule_set` | optional: a rule set of the pack (IHP SG13G2: `full`, `main`; SKY130: `main`, `feol`, `beol`). The default is the set with `default: true` (IHP SG13G2: `full`; SKY130: `main`) |
| `technology` | optional: the pack name (for example `sky130`) or one of its PDK names (for example `sky130A`). The default is the pack of `$PDK` |
| `max_examples` | optional: the number of marker boxes in each diagnostic (default 8) |

The adapter runs the deck in `work/drc/`. It reads the marker database (`.lyrdb`) and reconciles the result with
the exit code of the deck:

1. The log must not have an `incomplete_texts` text of the pack (for example `generated an exception`).
2. The marker database must exist, end with `</report-database>` and parse.
3. Exit code 0 is a completed run when the pack has `exit_code_violations: null`, or when the report has no
   markers. Exit code `exit_code_violations` is a completed run when the report has markers.

Else the run is **not run**: `markers` and `rules_violated` are failed with the value `null`, the response is
failed, and one error diagnostic starts with `not run:`. It gives the reason and the last lines of the deck log.
A deck that printed a summary but did not write a complete report is not run.

| Measurement | Contents |
| --- | --- |
| `markers` | the count of all markers |
| `rules_violated` | the count of rules with markers |
| `runtime_s` | the runtime of the deck |

Each violated rule gives one error diagnostic, largest count first. It has the rule name, the count, the
description of the deck and the marker boxes in µm, in the coordinates of the cell, grouped by cell:

1. A rule with `max_examples` markers or fewer gives all its boxes, for example
   `X.1: 4 markers. Boxes (µm, cell coordinates): unit: (0,0;1,1) (0.5,0;1.5,1)  idac: (2,2;3,3) (4,4;5,5)`.
2. A rule with more markers gives the marker count of each cell, the first `max_examples` boxes and the number of
   the other boxes. With `max_examples` 3, the same rule gives
   `X.1: 4 markers. Cells: unit (2), idac (2). Boxes (µm, cell coordinates): unit: (0,0;1,1) (0.5,0;1.5,1)  idac: (2,2;3,3) ... 1 more in work/drc.json`.

After the rules, one warning diagnostic gives the paths of the full table and of the marker database, relative to
the design root, as the summary shows them: `Full table: simra/experiments/<id>/work/drc.json (all markers of each
rule, by cell). Marker database: simra/experiments/<id>/work/drc/<cell>.lyrdb`. A run without markers does not give
this line. `work/drc.json` has each rule with its description, its count, the count of each cell and all boxes,
each with its cell. The outputs have the marker database, the deck log and `work/drc.json`.

## Operation `lvs`

| Input | Contents |
| --- | --- |
| `gds` | the layout, relative to the design root |
| `cell` | the top cell |
| `netlist` | the reference netlist, relative to the design root, in the form of `klayout.<pdk>.lvs.netlist_format` |
| `pins` | optional: the pins of the top cell, in order |
| `technology` | optional: the pack name or one of its PDK names, as for `drc` |

The adapter runs the deck in `work/lvs/`. Then it reads the LVS database with `lvsdb_probe.py`, in the KLayout
that it found. The result is a match only when all of these conditions are true:

1. The deck log has the `match_text` of the pack.
2. The exit code is in `exit_codes.match` of the pack.
3. The LVS database exists and loads with `LayoutVsSchematic().read()`.
4. The compare status of each circuit pair in the database is a match.

A mismatch needs the `mismatch_text`, an exit code in `exit_codes.mismatch`, and a database that loads and shows
the mismatch. Any other result is **not run**: all counts are failed, the response is failed, and one error
diagnostic names the condition that failed. For example, a deck that prints a match and then leaves a truncated
database gives `not run: the LVS database does not load in KLayout`.

| Measurement | Contents |
| --- | --- |
| `match` | 1 for a match, 0 for a mismatch |
| `unmatched_devices` | the count of device pairs that do not match |
| `unmatched_nets` | the count of net pairs that do not match |
| `unmatched_pins` | the count of pins of `pins` with a problem (missing when `pins` is not given) |
| `runtime_s` | the runtime of the deck |

On a mismatch, error diagnostics give the circuits, the devices and the nets that do not match (up to 10 of each).
`work/lvs.json` has all of them. A pin of `pins` gives a warning, also on a match, when one of these is true:

1. It is not a pin of the extracted top circuit (the comparison ignores case).
2. It is not a pin of the reference circuit.
3. Its order is not the order of the reference circuit. KLayout sorts the pins of the extracted circuit by name,
   so the adapter compares the order with the reference netlist.

The outputs have the extracted netlist, the LVS database, the deck log and `work/lvs.json`.

## The command in the response

The response of `drc` and of `lvs` has the field `commands` (see the adapter contract in
[CONTRIBUTING.md](../../CONTRIBUTING.md)). It has one entry: the deck command as the adapter ran it, with the
placeholders filled, its exit code and its runtime. For example:

```json
"commands": [{ "argv": ["klayout", "-b", "-r", "...", "-rd", "input=..."], "exit_code": 1, "runtime_s": 12.4 }]
```

The exit code is `null` when the deck did not start. The summary of the experiment gives each entry on one
`command:` line, after the `tool:` line. The `klayout -v` check and the read of the LVS database with
`lvsdb_probe.py` are not in `commands`. Their logs are in `work/`.

## Size of the summary

The tool result of `run_experiment` (and the output of `simra run`) is the summary of the experiment. On the
seeded block of `evals/layout-block-fix/` (DRC, default rule set, default `max_examples` 8), the sizes are:

| PDK | Summary of `klayout drc` | Output of `drc.sh` |
| --- | --- | --- |
| IHP SG13G2 | 4677 bytes (38 markers, 11 rules) | 222 bytes |
| SKY130 | 3486 bytes (33 markers, 10 rules) | 194 bytes |

The output of `drc.sh` gives only the count of each rule. The summary also gives the deck command, the description
of each rule, all the marker boxes (no rule of this block has more than 8 markers), the outputs with their sizes, the
paths of the full table and the marker database, and the record of the run. The deck command has absolute paths, so
its length changes with the path of the design root (here a temporary directory of the test). The summary without the
deck command had 4312 bytes (IHP SG13G2) and 3024 bytes (SKY130). The earlier summary (3 boxes for each rule, no
outputs) had 3427 bytes and 2654 bytes.

## Tests

1. Run `python3 -m unittest discover -s adapters/klayout -p "test_*.py"` (part of `npm test`).
2. To test in the image, set `SIMRA_TEST_IMAGE` (and `SIMRA_TEST_ENGINE`), then run
   `node --test test/klayout-container.test.mjs`.
