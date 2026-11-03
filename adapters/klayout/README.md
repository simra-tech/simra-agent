# klayout adapter

The klayout adapter runs the stock KLayout DRC and LVS decks of a PDK and gives typed verdicts. It also answers
questions about a layout (operation `query`), compares two layouts (operation `diff`) and draws a region or a DRC
marker as a picture (operation `render`) with the KLayout Python modules `klayout.db` and `klayout.lay`. It follows the
JSON-in / JSON-out contract `simra.adapter/0` (see [CONTRIBUTING.md](../../CONTRIBUTING.md)). It is written in
Python and has no PDK facts. The deck commands, the report paths, the log texts and the exit codes come from the
`klayout` section of the technology pack (see [technologies/README.md](../../technologies/README.md)).

| File | Contents |
| --- | --- |
| `adapter.json` | the manifest: the command and the operations `drc`, `lvs`, `query`, `diff` and `render` |
| `klayout_adapter.py` | the adapter |
| `layout_read.py` | the questions of `query`: it reads a layout with `klayout.db` and the layer names from the layer properties file of the PDK |
| `layout_diff.py` | the comparison of `diff`: layers, cell tree and DRC markers |
| `layout_render.py` | the pictures of `render`: a box or a DRC marker, drawn with `klayout.lay` in the colours of the layer properties file |
| `lvsdb_probe.py` | reads an LVS database with `klayout.db.LayoutVsSchematic` and writes its compare result as JSON |
| `test_klayout_adapter.py` | host tests on the fixtures; the tests of `query` and `diff` need `klayout.db`, the tests of `render` also `klayout.lay`; they are skipped without the module |
| `fixtures/` | marker databases, LVS logs and probe outputs from runs in the container image, and a small layer properties file with colours |

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

## Operation `query`

`query` answers questions about a layout in one run. It does not run a deck. It reads the layout with the KLayout
Python module `klayout.db` (the pip package `klayout`; the image has it). Use it instead of a Python script to read
a layout, for example to look at a DRC marker box.

Inputs:

| Input | Contents |
| --- | --- |
| `gds` | the layout, relative to the design root |
| `cell` | the top cell |
| `technology` | optional; the pack (as for `drc`). The default is the pack that lists `$PDK` |
| `queries` | the questions: a list of objects, each with a `kind` and its arguments |

Boxes and points are in µm, in the coordinates of the top cell. A box is `[x1, y1, x2, y2]`. A point `[x, y]` is
a box of zero size. A layer is a name of the layer properties file of the PDK or `layer/datatype` (for example
`8/0`).

| Kind | Arguments | Answer |
| --- | --- | --- |
| `layers` | none | each layer with shapes: name, layer/datatype, flat shape count, area in µm² |
| `cells` | `depth` (default 2) | the cell tree below the top cell, with the flat instance count, the bbox (in the coordinates of the cell) and the count of own shapes; the cells below `depth` are counted in one row |
| `shapes` | `layer`, `box`, `max` (default 20) | the total count and the merged area in the box, then the flat shapes that touch the box, largest overlap first, each with its cell path |
| `instances` | `box`, `max` (default 20) | the instances that touch the box: cell, cell path, placement in the top cell, bbox |
| `at` | `box`, `max` (default 20) | per layer the shape count and the merged area in the box, the deepest instances that touch it (up to `max`), and the texts in it (up to `max`) |
| `bbox` | `layer` (optional), `cell` (optional) | the bbox of the top cell, of one layer, or of a cell (in its own coordinates) |
| `texts` | `layer` (optional), `box` (optional), `max` (default 20) | the texts, with layer, position and cell path |
| `distance` | `layer`, `box_a`, `box_b` | the smallest distance between the shapes of the layer in the two boxes, with the two closest edges |

The answers are rows in the field `report` of the response (see [CONTRIBUTING.md](../../CONTRIBUTING.md)). The
summary of the experiment prints them after the measurements. Each question gives a header line `[i] <kind> ...`
and then its rows, indented by two spaces. The rows are short and fixed:

- lengths in µm with 3 decimals, areas in µm² with 3 decimals;
- a box is `(x1,y1;x2,y2)` and a point is `(x,y)`;
- a placement is `(x,y) r<angle>`, then `mx` for a mirror and `mag=<m>` for a magnification;
- a cell path is the cell names from the top cell down, for example `bias/arr16x24/unit[3,1]`; `[a,b]` is the index
  of the member of an array, in the order of the array in the file. A shape of the top cell has the path of the
  top cell.

The report has at most 200 lines. A longer report ends with the line `... <n> more rows in work/query.json`.
`work/query.json` has the full answer of each question: the rows and the values as numbers.

A bad question (an unknown kind, an unknown argument, a missing argument, an unknown layer or cell) gives an error
diagnostic for that question, and an error line in the report. The other questions are still answered. The
response is completed when at least one question was answered. It is failed when no question was answered, or
when the layout or the top cell is not there.

Measurements: `queries` (the number of questions), `rows` (the rows of all answers, before the report is
shortened) and `runtime_s`. The input files are the layout (role `layout`), the layer properties file (role
`layer_properties`) and the pack (role `technology`). The response has no `commands`: the adapter runs no
external command.

### Layer names

The layer names come from the layer properties file (`.lyp`) of the PDK. The pack gives its path in
`klayout.<pdk>.layer_properties` (see [technologies/README.md](../../technologies/README.md)). The adapter has no
layer names. It reads `<name>` and `<source>` of each `<properties>` entry, and normalises each name:

1. It removes a suffix ` - <layer>/<datatype>` (SKY130 has `met1.drawing - 68/20`).
2. It removes the purpose `.drawing` (IHP SG13G2 has `Metal1.drawing`). Other purposes stay (`Metal1.pin`,
   `met1.pin`).

A question can give the name with or without `.drawing`, in any case when only one layer has that name, or
`layer/datatype`. A layer that the file does not name is reported as `layer/datatype`. An unknown name gives an
error with the close names of the file. When the pack names no file, or the file is not there, the response has a
warning, and the questions must use `layer/datatype`.

### Example

The question `at` on the box of an `M3.d` marker of the seeded block of `evals/layout-block-fix/sg13g2/` (top cell
`idac`), then `distance` on Metal3 to the next shape, and a question with a wrong layer name:

```json
{"gds": "block-seeded.gds", "cell": "idac", "queries": [
  {"kind": "at", "box": [-10.185, -7.035, -9.815, -6.665]},
  {"kind": "distance", "layer": "Metal3", "box_a": [-10.185, -7.035, -9.815, -6.665], "box_b": [-9.5, -8, -8.5, -6]},
  {"kind": "shapes", "layer": "Metl3", "box": [0, 0, 1, 1]}]}
```

The report:

```text
[1] at (-10.185,-7.035;-9.815,-6.665): 4 layers, 1 instances (deepest), 0 texts (area: merged, in the box)
  layer Metal1.filler 8/22  shapes=1  area=0.068
  layer Metal2 10/0  shapes=1  area=0.137
  layer Via2 29/0  shapes=1  area=0.036
  layer Metal3 30/0  shapes=1  area=0.137
  inst Met1_M_FILL_CELL  Met1_M_FILL_CELL[19,20]  (-10.000,-10.000) r0  bbox=(-10.000,-10.000;-6.500,-6.500)
[2] distance Metal3 30/0 between (-10.185,-7.035;-9.815,-6.665) and (-9.500,-8.000;-8.500,-6.000): 0.630
  edge a (-9.815,-6.665;-9.815,-7.035)
  edge b (-9.185,-7.035;-9.185,-6.665)
[3] shapes: error: unknown layer 'Metl3' (close names: Metal3, Metal5, Metal4, Metal2); give a name of the layer properties file or layer/datatype
```

### Runtime

`query` reads the layout once for all questions. For a hierarchical layout (more than twice as many flat shapes as
stored shapes), the areas use the deep (hierarchical) mode of `klayout.db`; for a flat layout, they use the flat
mode. Runtimes of the adapter (`runtime_s`) for `layers`, `cells` and one more question (`at` or `bbox`) in one run:

| Layout | Flat shapes | Cells | IHP SG13G2 | SKY130 |
| --- | --- | --- | --- | --- |
| seeded block of `evals/layout-block-fix/` (hierarchical) | 487826 (IHP), 356882 (SKY130) | 30 (IHP), 16 (SKY130) | 0.6 s | 0.4 s |
| `flat-seeded.gds` of `evals/layout-long-job/` (flat, 21487 devices) | 944557 (IHP), 739544 (SKY130) | 1 | 5.0 s | 3.8 s |

The runtimes are from `test/klayout-read-container.test.mjs` in the container image (KLayout 0.30.12), with other
jobs on the machine. The run of the experiment (container start included) took 1.4 s to 1.9 s more. The questions
`at`, `shapes`, `instances`, `texts` and `distance` on a small box take less than 0.1 s on the hierarchical block.

## Operation `diff`

`diff` compares two layouts in one run, and optionally the DRC markers of two `drc` runs. It does not run a deck.
It reads both layouts with `klayout.db`. Use it to see what an edit or a commit changed, instead of a Python
script.

Inputs:

| Input | Contents |
| --- | --- |
| `gds` | the new layout, relative to the design root |
| `against` | the old layout: a path relative to the design root, or `git:<ref>`, or `git:<ref>:<path>` |
| `cell` | the top cell (the same name in both files) |
| `technology` | optional; the pack (as for `drc`) |
| `layers` | optional; a list of layer names or `layer/datatype`. The default is all layers of both files |
| `box` | optional; `[x1, y1, x2, y2]` in µm. The comparison is only in this box |
| `max` | optional, default 10: the polygons shown per layer and direction, and the markers shown per rule and direction |
| `drc`, `drc_against` | optional, together: the ids of two completed `klayout drc` experiments, of `gds` and of `against` |

For `git:<ref>`, the adapter runs `git show <ref>:./<path>` in the design root (the path is the path of `gds`,
or the path after the second colon). It writes the file to `work/against.gds` and its log to `work/git-show.log`.
The command is in `commands` of the response.

The answer has three parts, as rows in `report`:

1. **Layers.** The adapter makes an XOR of the merged shapes of each layer, for the whole tree of the top cell.
   Without `box`, it uses the deep (hierarchical) mode of `klayout.db`. With `box`, it uses the flat mode, in the
   box. Each changed
   layer has one row: the area added and removed in µm² and the polygon counts. Then come the largest polygons
   first, each with its bbox, its area and the cell path of the instance that holds it. The path is the top cell when
   the difference is not inside one instance. `+` is in `gds` and not in `against`. `-` is in `against` and not in
   `gds`. One row counts the layers with no difference. A text that is in only one file also changes a layer.
2. **Cells.** The cells only in one file, the cells whose flat instance count differs, and the cells whose child
   instances differ (an added, removed or moved placement, in µm). When the hierarchy is the same in both files,
   the adapter also compares the own shapes of each cell (in the coordinates of the cell). When the hierarchy
   differs, use the flat XOR of the layers.
3. **DRC markers.** Only with `drc` and `drc_against`. The adapter reads `work/drc.json` of each experiment. Per
   rule, it gives the new, fixed and unchanged markers. A marker is unchanged when the other run has a marker of the
   same cell with the same box within one database unit. When an experiment ran on another file than the layout of
   this run (another SHA-256), the response has a warning.

The report has at most 200 lines. A longer report ends with the line `... <n> more rows in work/diff.json`.
`work/diff.json` has the full answer.

Measurements: `layers_changed`, `area_added_um2`, `area_removed_um2`, `cells_changed`, `markers_new`,
`markers_fixed`, `markers_unchanged` and `runtime_s`. Without `drc` and `drc_against`, the marker counts are
`missing`. When only one of them is given, or an experiment cannot be read, the marker counts are `failed` and the
response has an error diagnostic; the layout comparison still runs. The response is failed when a layout, the top
cell or a layer is not there, or when `git show` fails. Then all measurements are `failed`.

The input files are both layouts (role `layout`), the layer properties file, the pack and the two marker tables
(role `drc`).

### Example

The commit of the colleague in `evals/layout-stale-state/` (`v2-seeded.gds`) against its input (the seeded block of
`evals/layout-block-fix/`), on SKY130, with one `drc` run on each file:

```json
{"gds": "block.gds", "against": "v1.gds", "cell": "idac", "drc": "20261103-062721-ec43e4",
 "drc_against": "20261103-062722-4f8e52", "max": 3}
```

The report:

```text
layers: 3 changed, 15 unchanged (deep XOR, whole layout; + in block.gds, - in v1.gds; the first 3 polygons of each, largest first)
  met2 69/20  added=11.000 (1 polygons)  removed=2.400 (6 polygons)
    + box (-12.000,171.180;-1.000,172.180)  area=11.000  cell=idac
    - box (80.750,-5.400;81.150,-4.400)  area=0.400  cell=idac
    - box (81.250,-5.400;81.650,-4.400)  area=0.400  cell=idac
    - box (81.750,-5.400;82.150,-4.400)  area=0.400  cell=idac
    - ... 3 more removed
  via2 69/44  added=0.320 (8 polygons)  removed=0.000 (0 polygons)
    + box (78.940,-6.500;79.140,-6.300)  area=0.040  cell=idac
    + box (79.260,-6.500;79.460,-6.300)  area=0.040  cell=idac
    + box (80.940,-6.500;81.140,-6.300)  area=0.040  cell=idac
    + ... 5 more added
  met3 70/20  added=1.640 (4 polygons)  removed=2.000 (5 polygons)
    + box (78.790,-6.650;79.610,-6.150)  area=0.410  cell=idac
    + box (80.790,-6.650;81.610,-6.150)  area=0.410  cell=idac
    + box (82.790,-6.650;83.610,-6.150)  area=0.410  cell=idac
    + ... 1 more added
    - box (940.500,176.180;941.500,176.580)  area=0.400  cell=idac
    - box (940.500,176.780;941.500,177.180)  area=0.400  cell=idac
    - box (940.500,177.380;941.500,177.780)  area=0.400  cell=idac
    - ... 2 more removed
  unchanged: 15 layers
cells: 16 in block.gds, 16 in v1.gds; 1 changed; hierarchy the same (own shapes compared per cell)
  own shapes idac: met2 69/20 +11.000 -2.400; via2 69/44 +0.320 -0.000; met3 70/20 +1.640 -2.000
drc: 20261103-062721-ec43e4 against 20261103-062722-4f8e52: new=4 fixed=9 unchanged=24 (same cell and box within 0.001 µm)
  m2.2  new=0 fixed=5 unchanged=0
    fixed (82.650,-5.400;82.750,-4.400)  cell=idac
    fixed (82.150,-5.400;82.250,-4.400)  cell=idac
    fixed (81.650,-5.400;81.750,-4.400)  cell=idac
    fixed ... 2 more
  m3.2  new=0 fixed=4 unchanged=0
    fixed (940.500,178.380;941.500,178.580)  cell=idac
    fixed (940.500,177.780;941.500,177.980)  cell=idac
    fixed (940.500,177.180;941.500,177.380)  cell=idac
    fixed ... 1 more
  via2.2  new=4 fixed=0 unchanged=0
    new (79.140,-6.500;79.260,-6.300)  cell=idac
    new (81.140,-6.500;81.260,-6.300)  cell=idac
    new (83.140,-6.500;83.260,-6.300)  cell=idac
    new ... 1 more
  m1.1  new=0 fixed=0 unchanged=4
  m1.2  new=0 fixed=0 unchanged=1
  m2.1  new=0 fixed=0 unchanged=1
  m2_OFFGRID  new=0 fixed=0 unchanged=4
  m3.1  new=0 fixed=0 unchanged=2
  m3.4  new=0 fixed=0 unchanged=2
  m3.6  new=0 fixed=0 unchanged=8
  via.4a  new=0 fixed=0 unchanged=2
```

The kept box is the first `+` row of `met2`: the wider `ibias` stub. The rules `m2.2` and `m3.2` are fixed. The rule
`via2.2` is new.

### Runtime

Runtimes of the adapter (`runtime_s`) without DRC markers:

| Comparison | IHP SG13G2 | SKY130 |
| --- | --- | --- |
| `v2-seeded.gds` of `evals/layout-stale-state/` against the seeded block of `evals/layout-block-fix/` (hierarchical, 30 or 16 cells), with the marker delta | 0.9 s | 0.3 s |
| `flat-seeded.gds` of `evals/layout-long-job/` (flat, 21487 devices) against a copy with one Metal2 box added and five Metal2 shapes removed | 5.1 s | 3.6 s |

The runtimes are from `test/klayout-read-container.test.mjs` in the container image (KLayout 0.30.12), with other
jobs on the machine. The run of the experiment (container start included) took about 2 s more. Each layer gets one
XOR in one deep shape store; only a layer with a difference gets the two differences. The deep mode is also faster
than the flat mode on the flat block. A diff with `box` uses the flat mode in the box only.

## Operation `render`

`render` draws a region of a layout, or a DRC marker, as a PNG picture in one run. It does not run a deck. It
draws with the KLayout Python module `klayout.lay` (a layout view without a display) in the colours of the layer
properties file of the PDK. The pi extension adds the picture to the result of `run_experiment` as an image part
after the summary, so the agent sees it. Use it to look at a marker or a region before you choose the edit.

Inputs:

| Input | Contents |
| --- | --- |
| `gds` | the layout, relative to the design root |
| `cell` | the top cell |
| `technology` | optional; the pack (as for `drc`). The default is the pack that lists `$PDK` |
| `box` | the region: `[x1, y1, x2, y2]` in µm, in the coordinates of the top cell. A point `[x, y]` gives a view of 1 µm |
| `drc`, `rule` | instead of `box`: the id of a completed `drc` experiment and a rule name. The marker of that rule is drawn as a red outline, in the cell of the marker, with at least 3 µm around it |
| `index` | with `drc`: the marker to draw, in the order of `work/drc.json` (default 1) |
| `all`, `max` | with `drc`: `all` true draws one picture per marker, up to `max` (default 4, at most 8) |
| `layers` | optional; the layers to show: names of the layer properties file or `layer/datatype`. The default is all layers |
| `size` | optional; the longer side of the picture in pixels (default 1024, at most 2048). The other side follows the view |
| `labels` | optional; show the texts (default true) |
| `grid` | optional; show a scale bar, and a 1 µm grid when the view is 50 µm or less (default true) |
| `hierarchy` | optional; the levels of cells to draw: 0 is the top cell alone, 1 adds its instances. The default is all levels |

The view is the box plus a margin of 10 % on each side, at least 0.5 µm. For a marker the margin is at least 3 µm
and half of the longer side of the marker. The pictures are `work/render.png`, or `work/render-<n>.png` for several
markers, each an output with the role `image`. The scale bar is a ruler at the lower left with the length in µm and
the view box. The marker outline is drawn on a scratch layer in memory (9999/0, or the next free layer number); the
file is not changed.

The report has one line per picture:

```
[1] marker M3.d 1/8 cell=idac box=(12.000,4.000;12.500,4.500) view=(9.000,1.000;15.500,7.500) image=work/render.png 1024x1024 layers=Metal2,Via2,Metal3
```

The layers at the end are the visible layers with shapes in the view. `work/render.json` has the full answer (the
boxes as numbers, the file and the size of each picture, the layer properties file). Measurements: `images`,
`runtime_s`.

A bad input (no view, both views, an unknown layer or cell, a rule without markers, an index above the marker
count) gives a failed response with one error diagnostic and no picture. Without `klayout.lay` the response is
failed with the module name in the diagnostic.

A picture of 1024 x 1024 pixels of the block of `layout-block-fix` is about 100 kB and takes 0.2 s to draw in the
container image. The pi extension adds at most 4 pictures and at most 1 MB of pictures to one tool result; the
summary names every picture.

## The command in the response

The response of `drc` and of `lvs` has the field `commands` (see the adapter contract in
[CONTRIBUTING.md](../../CONTRIBUTING.md)). The first entry is the deck command as the adapter ran it, with the
placeholders filled, its exit code and its runtime. For `lvs`, a second entry is the read of the LVS database with
`lvsdb_probe.py`. For example:

```json
"commands": [{ "argv": ["klayout", "-b", "-r", "...", "-rd", "input=..."], "exit_code": 1, "runtime_s": 12.4 }]
```

The exit code is `null` when the deck did not start. The summary of the experiment gives each entry on one
`command:` line, after the `tool:` line. The `klayout -v` check is not in `commands`. The logs are in `work/`.

The response of `query` has no `commands`. The response of `diff` has `commands` only for `against` `git:<ref>`:
the `git show` command.

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
   `node --test test/klayout-container.test.mjs test/klayout-read-container.test.mjs test/klayout-render-container.test.mjs`.
3. The tests of `query`, `diff` and `render` need the KLayout Python module on the host. Install it with `pip install klayout`.
   Without it, they are reported as skipped. The tests of `render` check pixels of the pictures with the colours of
   `fixtures/query.lyp` (Metal1 solid blue, Via1 solid magenta).
