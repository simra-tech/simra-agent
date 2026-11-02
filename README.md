# Simra Agent

Simra Agent is an agent harness for chip design. It is built on [pi](https://github.com/earendil-works/pi).

pi runs the agent loop. Simra Agent adds what a chip designer needs and a coding agent does not have:

- long jobs (simulation, extraction, place and route) that continue after the session stops
- evidence: which experiment used which inputs, gave which result, and what that result can claim
- design state and decisions, kept as plain files in the design repository
- domain tools (simulator, layout tool, PDK) through tested adapters

The first targets are analog and mixed-signal design with an open PDK and open-source EDA tools.

## Status

**Stage 1. One capability: recorded simulation runs.**

- The tool `run_experiment` (pi extension) and the command `simra run` (plain CLI) run one simulation through
  an adapter.
- Each run writes a record to `simra/experiments/<id>/` in the design root: the request, the environment
  (container image ID, CPU pinning), the git state of the design, the hash of every input file (including the
  PDK model files), the tool version, the measurements, the logs and the hashed outputs.
- The tool `check_requirements` (pi extension) and the command `simra check` (plain CLI) check the design
  against `requirements.json`. They run the experiments that the requirements need and write a verdict to
  `simra/checks/<id>/verdict.json`. Each row of the verdict names the experiment that gave its value.
- The ngspice adapter has four operations: `simulate`, `operating_point`, `lint` and `check_design`.
- The klayout adapter has two operations: `drc` and `lvs`. They run the stock KLayout decks of the PDK and give
  typed verdicts. A check that did not complete gives "not run", not a pass.
- One example design exists: a two-stage OTA for the open IHP SG13G2 PDK.

## Requirements

- Node.js 22.19 or later
- npm

## Install and test

1. Clone the repository.
2. Run `npm ci`.
3. Run `npm test`.

The tests need no model, no API key and no network access after `npm ci`. The adapter tests need Python 3.6
or later. The integration test with ngspice runs only if `ngspice` is on the PATH; otherwise it is reported as
skipped. To also test a container image, set `SIMRA_TEST_IMAGE` to an image with ngspice and Python, and
`SIMRA_TEST_ENGINE` to `podman` (the default) or `docker`.

## Environment image

`container/Containerfile` adds Node.js 22, pi (from the lockfile) and OpenCode to a pinned
[IIC-OSIC-TOOLS](https://github.com/iic-jku/iic-osic-tools) release, which has the open-source EDA tools and
PDKs. The agent and the tools can then run in one container on any machine with Docker or podman.

1. Pull the base image that `container/Containerfile` names.
2. Run `container/build.sh`. It builds the committed tree (HEAD) and prints the image tag.
3. Run `container/check.sh <tag>`. It prints the tool versions and runs `npm test` in the container.

Set `SIMRA_ENGINE=podman` to use podman instead of Docker.

## Run a simulation

From a plain command line:

1. Write a spec file, for example `run.json`:
   `{"adapter": "ngspice", "operation": "simulate", "purpose": "check the RC filter", "inputs": {"deck": "rc.spice"}}`
2. Run `npx simra run run.json` in the design root. It prints a summary: the records, the input files, the outputs
   (path and size), the measurements, and the errors and warnings.
3. Run `npx simra list` and `npx simra show <id>` to read the records.

In pi:

1. Run `npx pi -e ./packages/pi-extension` in the design root.
2. Ask for a simulation. The agent calls `run_experiment` and cites the experiment id.

The `simulate` operation of the ngspice adapter takes two optional inputs for the condition of a run:

- `params`: an object `{name: value}`. Each entry becomes a `.param name=value` line after the deck. A number is
  written as a number. A string is written as is, for example `"2p"` or `"{vdd/2}"`.
- `temp_c`: a number. It becomes a `.temp` line after the deck.

ngspice uses the last `.param` line of a name and the last `.temp` line, so these lines replace the values in the
deck. The adapter does not use `.option temp=`, because it does not replace a `.temp` line of the deck.

The design root is the nearest directory upward with `simra.config.json`. It defines the execution
environments. Put machine-specific settings (image ID, CPU list) in `simra.local.json`, which git ignores.
See [examples/ota-sg13g2](examples/ota-sg13g2/README.md).

## System prompt

In pi, the extension replaces the first paragraph of pi's system prompt. pi's paragraph describes a coding
assistant. The extension's paragraph (`SIMRA_PREAMBLE` in `packages/pi-extension/index.ts`) describes a chip
design assistant that reports only simulated numbers. The extension keeps pi's list of tools and the rules of the
tools. It removes pi's section about the pi documentation.

A system prompt that you give to pi (`--system-prompt` or `.pi/SYSTEM.md`) stays as it is.

## Netlist check

Some simulator options add elements to the circuit. For example, `.option rshunt=5e5` connects 500 kΩ from
each node to ground, and the gain decreases. The ngspice adapter gives a warning, with the file and the line,
for `rshunt`, `cshunt` and a `gmin` above 1e-12:

- in the response of each `simulate` run;
- from the operation `lint` (input `files`), which runs no simulation.

In pi, the extension adds these warnings to the result of a `read`, `write`, `edit` or `bash` call that names a
netlist. It adds each warning one time per session.

## Session time

Set `SIMRA_SESSION_DEADLINE` to an ISO 8601 time, for example `2026-10-30T15:00:00Z`, to give pi a time limit.
After 50 % and after 80 % of the time, the extension adds a note to the next tool result. The note gives the
time that is left and tells the agent to write its output files with the best result so far. The eval runner
`evals/run-arm.mjs` sets this variable from `--timeout-min`.

## Operating point

The operation `operating_point` of the ngspice adapter shows the DC operating point of each MOS device of a
testbench, and whether the device is in saturation. Use it to find why a design fails.

1. Give the inputs `deck` and `libs`, as for `simulate`. Set the DC values of the sources for the condition to
   check, for example one input common-mode voltage.
2. The adapter removes the `.control` blocks, the analyses and the `.meas` lines of the deck, and runs `op`.
3. The response has the measurements `<device>.vgs`, `.vth`, `.vds`, `.vdsat`, `.id`, `.gm`, `.gds`, `.vov`
   (|vgs| − |vth|) and `.sat_margin` (|vds| − |vdsat|) for each MOS device. It has a warning for each device
   in triode or in subthreshold.

The parameter names of the MOS models are different in each PDK. They are in the technology packs in
[technologies/](technologies/README.md). The adapter selects the pack for `$PDK`, or the pack in the input
`technology`. Packs exist for IHP SG13G2, IHP SG13CMOS5L and SKY130.

## Check requirements

`requirements.json` in the design root (schema `simra.requirements/0`) has three parts:

- `conditions`: named conditions, for example process corners. The `inputs` of a condition replace the
  experiment inputs of the same name.
- `experiments`: one template per measurement setup (`adapter`, `operation`, `inputs`). In each string input,
  `{condition}` is replaced with the condition name.
- `requirements`: each has an `id`, an `experiment`, a `measurement`, an optional `unit`, an `op` (`<=`, `>=` or
  `between`), a `limit` and optional `conditions`. The limit is one number, `[low, high]` for `between`, or one
  limit per condition. A requirement without `conditions` runs its experiment once, with the template inputs
  only. Its verdict row has the condition `null`.

Other top-level fields are errors. An older file with a top-level `design` section is an error too. The message
tells how to write the design check as an experiment (see [Design contract](#design-contract)).

Example:

```json
{
  "schema": "simra.requirements/0",
  "conditions": { "nominal": {} },
  "experiments": {
    "ac": { "adapter": "ngspice", "operation": "simulate", "inputs": { "deck": "rc.spice", "measurements": { "f3db_hz": "Hz" } } }
  },
  "requirements": [
    { "id": "bandwidth", "experiment": "ac", "measurement": "f3db_hz", "unit": "Hz", "op": "between", "limit": [150, 170], "conditions": ["nominal"] }
  ]
}
```

1. Write `requirements.json` in the design root.
2. Run `npx simra check`. To check a part, add `--only <id,...>` or `--conditions <name,...>`.
3. Read the verdict. The command exits with 0 only when the status is `pass`.

The check runs 4 experiments at the same time. To change this number, add `--parallel <n>`. With
`--parallel 1`, the experiments run one at a time.

A condition can give the verification bench its values: for ngspice, put `params` and `temp_c` in the `inputs`
of the condition (see [Run a simulation](#run-a-simulation)). The bench then comes from the requirements, not
from a testbench that the agent writes.

The check runs each experiment once per condition, also when more than one requirement reads it. Each row is
`pass`, `fail`, `not_measured` (no value, or a different unit) or `not_run` (the experiment did not complete,
or the row was not selected). The status is `pass` only when every row passes. A check of a part is never
`pass`.

The verdict has the diagnostics (errors and warnings, with file and line) of each experiment. When a row of an
experiment does not pass, the summary shows the diagnostics of that experiment before the rows.

### Sweeps

A sweep bench checks a requirement over an input range, for example the input common-mode voltage. Its
`.control` block prints one line per sweep point:

```
ROW <sweep>=<value> <name>=<value> ...
```

For example, `echo ROW vcm=$vcm gain_db=$&gain_db pm_deg=$&pm` in a `foreach` loop. The first key is the sweep
variable. A value is a number, optionally with a SPICE scale suffix such as `1k`. A value that is empty or not
a number means that the point has no value.

1. The ngspice adapter writes the table to `work/sweep.json`.
2. For each column `<name>`, it reports `<name>.min` and `<name>.max`. Each has `at`, the sweep point where the
   value occurs, for example `{"vcm": 0.4}`.
3. `<name>.min` and `<name>.max` are `measured` only when every sweep point has a value. Otherwise they are
   `failed`, with a warning. A missing point is never a pass.
4. A requirement on `<name>` uses the worst point: `.min` for `>=`, `.max` for `<=`, and both for `between`.
   The verdict row gives `at`, and the summary shows it, for example `@ vcm=0.4`.

When the result has `<name>.min` or `<name>.max`, the check uses them, also when the bench prints a
`<name> = value` line (for example from `meas` in the loop).

### Design contract

The operation `check_design` of the ngspice adapter tells what the design file can contain. It runs no
simulation. It reads the netlist in the ngspice form, with the `ngspice.*` facts of the technology pack. Put it in
`requirements.json` as an experiment, and put requirements without `conditions` on its measurements. Example:

```json
"experiments": {
  "design": {
    "adapter": "ngspice", "operation": "check_design", "environment": "eda",
    "inputs": {
      "file": "ota.spice", "subckt": "ota", "pins": ["inp", "inn", "out", "vdd", "vss", "ibias"],
      "elements": ["mos", "r", "c"], "devices": ["sg13_lv_nmos", "sg13_lv_pmos"],
      "limits": { "c_f": 2e-12 }, "technology": "ihp-sg13"
    }
  }
},
"requirements": [
  { "id": "design_errors", "experiment": "design", "measurement": "design_errors", "op": "<=", "limit": 0 },
  { "id": "area_um2", "experiment": "design", "measurement": "area_um2", "unit": "um2", "op": "<=", "limit": 1000 }
]
```

The inputs:

- `file`, `subckt` and `pins` are necessary. `pins` gives the pins of the subcircuit in their order.
- `elements` gives the permitted element kinds: `mos`, `r` and `c`. The default is all three.
- `devices` gives the devices of the technology pack that the design can instantiate. Without `devices`, the
  design can instantiate every device of the pack. A name that the pack does not have makes the run fail, so its
  rows are `not_run`.
- `limits` gives maximum values for each element: `r_ohm` for each resistor and `c_f` for each capacitor. An
  element above its limit is an error at its line.
- `technology` is the name of a technology pack, or one of the PDK names of a pack (for example `sky130A`). The
  default is the pack for `$PDK`.

The measurements:

- `design_errors`: the number of errors. Put the requirement `design_errors <= 0` on it.
- `mos_count`: the number of MOS devices, with each subcircuit instance counted.
- `gate_area_um2`: the sum of W × L × m over all MOS devices.
- `passive_area_um2`: the area of the R and C. A resistor counts as R × w_min² / R_sheet and a capacitor as
  C / density, with the facts of the technology pack for `$PDK` (`ngspice.passives`).
- `area_um2`: `gate_area_um2` plus `passive_area_um2`, that is, the MOS gate area plus the area of the ideal R and
  C from the facts of the pack. It is an estimate from the netlist, not a layout area.

When the pack has no passive facts for the R or C of the design, `passive_area_um2` and `area_um2` are not
measured, and the adapter gives a warning. A requirement on them is then `not_measured`.

The rules of the design file:

1. The file contains only `.subckt` blocks, blank lines, comments and `.end`.
2. The named block has the pins of `pins`, in the same order, and no parameters.
3. An `X` line instantiates a MOS device of the technology pack (only the `devices`, if given) or another block
   of the file. The sizes are plain numbers with an optional scale suffix, for example `w=2u`. Each size is at
   or above the minimum of the pack. The sizes follow the scale of the technology pack (`ngspice.size_unit_m`):
   with `ihp-sg13`, `w=2u` is 2 µm; the `sky130` library sets `.option scale=1.0u`, so `w=2` is 2 µm.
4. An `R` or `C` line has 4 fields and a positive value.
5. All other lines are errors: sources, `M` lines, `.model`, `.include`, `.lib`, `.param`, `.option` and
   expressions in `{}`. A block that instantiates itself is also an error.

Each error is a diagnostic with file and line. When a row of the design experiment does not pass, the summary
shows the errors before the rows.

## Layout

| Path | Contents |
| --- | --- |
| `packages/kernel/` | runner, experiment records, environments, `simra` CLI (no pi dependency) |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `adapters/ngspice/` | ngspice adapter (Python) and its tests; `design_check.py` has the operation `check_design` |
| `adapters/klayout/` | klayout adapter (Python) and its tests: DRC and LVS with the stock KLayout decks of the PDK, with typed verdicts |
| `technologies/` | technology packs: the PDK facts that adapters need |
| `examples/ota-sg13g2/` | two-stage OTA for IHP SG13G2 |
| `evals/` | demo evaluations for the inner development loop (not decision benchmarks): the OTA at 3 corners, the OTA against a PVT spec, OTA synthesis from a pin specification (`ota-synthesis`), comparator synthesis from a pin specification (`comparator-synthesis`), their scorers and an arm runner. `synthesis-family.mjs` makes variants of the two synthesis tasks with tighter limits, from a hidden target design and a difficulty factor |
| `evals/layout-drc-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a small analog cell, with the stock KLayout DRC and LVS decks, on IHP SG13G2 and SKY130 |
| `evals/layout-clean/` | demo layout task (not a decision benchmark): verify the same cell without violations, with no false alarm and no needless edit |
| `evals/layout-block-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a hierarchical analog block (10012 devices, four levels of cells), on IHP SG13G2 (full DRC rule set, density included) and SKY130 |
| `evals/layout-false-pass/` | demo layout task (not a decision benchmark): verify the clean block with an LVS script that prints a match and then crashes; the agent must report the LVS check as not run |
| `container/` | environment image: Containerfile, build and check scripts |
| `test/` | smoke and integration tests |

## Licence

Apache-2.0. See [LICENSE](LICENSE). See [NOTICE](NOTICE) for the credit to pi (MIT).
