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
- A run can be detached: `run_experiment` with `detached: true` (pi) or `simra run --detach` (CLI) starts the run in
  a supervisor process and returns at once. The tool `wait_experiments` (pi) and the command `simra wait` (CLI)
  wait for one or more runs in one call. The summary of a run gives the runtimes of the earlier runs of the same
  kind.
- Each run writes a record to `simra/experiments/<id>/` in the design root: the request, the environment
  (container image ID, CPU pinning), the git state of the design, the hash of every input file (including the
  PDK model files), the tool version, the measurements, the logs and the hashed outputs.
- The tool `check_requirements` (pi extension) and the command `simra check` (plain CLI) check the design
  against `requirements.json`. They run the experiments that the requirements need and write a verdict to
  `simra/checks/<id>/verdict.json`. Each row of the verdict names the experiment that gave its value.
- The tool `design_record` (pi extension) and the command `simra record` (plain CLI) show, for each file of record
  (for example a layout or a netlist), which checks ran on the current file and which are stale.
- The ngspice adapter has four operations: `simulate`, `operating_point`, `lint` and `check_design`.
- The klayout adapter has five operations: `drc`, `lvs`, `query`, `diff` and `render`. `drc` and `lvs` run the stock
  KLayout decks of the PDK and give typed verdicts. A check that did not complete gives "not run", not a pass. `query`
  answers questions about a layout (layers, cells, shapes, instances, texts, distances) in one recorded run. `diff`
  compares two layouts (a file or a git ref), and optionally the DRC markers of two runs, in one recorded run. `render`
  draws a region or a DRC marker as a picture that the agent sees in the result.
- The commands `simra pack init` and `simra pack check` add a PDK to a site: an adapter proposes a technology pack
  from the kit, the user confirms it, and the adapter checks it (see "Add a PDK").
- One example design exists: a two-stage OTA for the open IHP SG13G2 PDK.

## Install

On Linux with glibc (x64 or arm64) or on macOS 13 or later, run as your user (not as root):

```sh
curl -fsSL https://github.com/simra-tech/simra-agent/releases/latest/download/install.sh | sh
```

The installer needs curl or wget, tar, and sha256sum, shasum or openssl. It needs no Node.js and no npm.

1. It downloads the `simra` release for the machine and checks its SHA-256 hash against the hash in the installer.
2. It unpacks the release to `~/.local/share/simra/releases/<version>` and links `~/.local/bin/simra` to it.
3. If `~/.local/bin` is not on the `PATH`, it asks before it adds a marked block to your shell profile (zsh, bash or
   fish). Without a terminal, or with `CI` or `SIMRA_NO_MODIFY_PATH=1`, it prints the line instead.

It changes nothing else. Then run `simra` in a design folder.

- `simra update` installs the latest release. It keeps the previous release.
- `SIMRA_VERSION=<version>` installs that release. `SIMRA_HOME=<dir>` installs to `<dir>`, for example a scratch disk.
- `simra uninstall` removes the releases, the link and the profile block. Settings and logins stay in
  `~/.config/simra`.

The machine also needs the EDA tools that the adapters run (for example ngspice, KLayout and Python 3).

## Development

Requirements: Node.js 22.19 or later, and npm.

1. Clone the repository.
2. Run `npm ci`.
3. Run `npm test`.

The tests need no model, no API key and no network access after `npm ci`. The adapter tests need Python 3.6
or later. The integration test with ngspice runs only if `ngspice` is on the PATH; otherwise it is reported as
skipped. The tests of the klayout operations `query`, `diff` and `render` run only if the KLayout Python module is installed
(`pip install klayout`); otherwise they are reported as skipped. To also test a container image, set
`SIMRA_TEST_IMAGE` to an image with ngspice and Python, and `SIMRA_TEST_ENGINE` to `podman` (the default) or `docker`.

## The simra binary

The `simra` binary has the kernel CLI and pi with the Simra extension in one file, compiled with
[Bun](https://bun.com).

- `simra run`, `check`, `list`, `show`, `wait`, `record` and `pdf` are the commands of the kernel CLI.
- `simra update --extensions` and `simra update --models` update pi packages and model catalogs.
- All other arguments go to pi. `simra` without arguments starts the agent in the terminal.

Settings, logins and sessions are in `~/.config/simra` (`$XDG_CONFIG_HOME/simra`; set `SIMRA_CODING_AGENT_DIR` for
another folder). The settings of a project are in `.simra/` in the project.

The first start in a terminal, without a model login, shows a short welcome. Choose a model (DeepSeek V4.1 Flash:
low cost, reads images; or GPT-6.1 Sol: stronger) and paste its API key. To use another provider or a subscription,
type `/login` in simra. When a provider key is set in the environment (for example `DEEPSEEK_API_KEY`), there is no
welcome.

Once a day, `simra` checks for a newer release and shows `simra <version> is available: run simra update`. It does
not update itself. Set `SIMRA_NO_UPDATE_CHECK=1` to stop the check.

Behind a company proxy, set `HTTPS_PROXY`. `simra` and the installer trust the certificate authorities of the system.

### Build the binary

1. Run `npm ci`.
2. Run `sh packages/launcher/get-bun.sh <dir>`. It downloads the pinned Bun to `<dir>/bun` and checks its hash.
3. Run `BUN=<dir>/bun node packages/launcher/build.ts`. It writes the release folder `dist/simra-<os>-<cpu>/`. The
   binary reads its other files from this folder.
4. Run `SIMRA_BINARY=dist/simra-<os>-<cpu>/simra npm test`. Without `SIMRA_BINARY`, the binary tests are skipped.

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
3. Run `npx simra list` and `npx simra show <id>` to read the records. `simra show` prints the summary; add
   `--json` to print the records.

In pi:

1. Run `npx pi -e ./packages/pi-extension` in the design root.
2. Ask for a simulation. The agent calls `run_experiment` and cites the experiment id.

## Run a long job

A run that takes minutes (for example a DRC or LVS deck of a large layout) can run detached. The run continues in
a supervisor process, also after the tool call or the command ends. Two independent runs (for example DRC and LVS)
can run at the same time.

From a plain command line:

1. Run `npx simra run --detach run.json`. The command prints the experiment id and the status `running`, and
   returns at once.
2. Run `npx simra wait <id> [<id>...]`. The command waits until each run ends, and prints the summary of each run.
   Add `--timeout-s <n>` to stop the wait after `n` seconds (default 3600). A run that did not end is shown as
   `still running`; the run continues. The command exits with 0 only when every run completed.

In pi:

1. The agent calls `run_experiment` with `detached: true`. The tool gives the id and the status `running`.
2. The agent calls `wait_experiments` with the ids. The call blocks until the runs end (or `timeout_s`, default
   3600 s) and gives the same summary as a blocking `run_experiment`, one block per id. The model does not use
   tokens while the call waits.

The prompt rules tell the agent to use these tools for long or independent runs, and not to poll with `sleep`,
`tail` or log reads.

The runner writes `status.json` in the experiment directory: the status (`running`, then the result status), the
start time, and the pid and host of the process that runs the experiment. When the process is gone and there is
no `result.json`, the next wait writes `result.json` with the status `error`. The supervisor stops the adapter
at the timeout of the run (`timeout_s`, default 3600 s). On `SIGTERM`, it stops the adapter and records the run
as `cancelled`.

When an experiment starts, the summary gets one line with the runtimes of the earlier runs, for example
`estimate: earlier runs of klayout drc on this design took 391.8 to 427.7 s (2 runs)`. The line uses the
completed runs in `simra/experiments` of the design root with the same adapter, the same operation and the same
input `rule_set`, that ended before the new run started. It gives only the shortest runtime, the longest runtime
and the number of runs. When there is no such run, there is no line.

The `simulate` operation of the ngspice adapter takes two optional inputs for the condition of a run:

- `params`: an object `{name: value}`. Each entry becomes a `.param name=value` line after the deck. A number is
  written as a number. A string is written as is, for example `"2p"` or `"{vdd/2}"`.
- `temp_c`: a number. It becomes a `.temp` line after the deck.

ngspice uses the last `.param` line of a name and the last `.temp` line, so these lines replace the values in the
deck. The adapter does not use `.option temp=`, because it does not replace a `.temp` line of the deck.

The design root is the nearest directory upward with `simra.config.json`. It defines the execution
environments. Put machine-specific settings (image ID, CPU list) in `simra.local.json`, which git ignores.
See [examples/ota-sg13g2](examples/ota-sg13g2/README.md).

## Add a PDK

A technology pack holds the facts of one PDK for the adapters (see [technologies/README.md](technologies/README.md)).
A pack for a PDK that is not in this repository is site data: it fits the kit version of the site. An adapter that
has the operations `pack_propose` and `pack_check` (see [CONTRIBUTING.md](CONTRIBUTING.md)) makes the pack from the
kit. To add a PDK:

1. Run `npx simra pack init --pdk <name> --pdk-root <kit directory>` in the design root. Add `--adapter <name>` when
   more than one adapter has `pack_propose`. Add `--inputs '<json>'` for more inputs of the adapter, for example
   `'{"vdd_v": 0.8}'`.
2. Read the report. Each fact has its source and a confidence (`sure`, `guess` or `todo`). Answer the open
   questions. The run is a normal experiment record; `npx simra show <id>` prints it again.
3. Run the command again with `--write`. In a terminal, the command also asks before it writes. It writes the pack to
   `<dir>/<pdk>/technology.json`. `<dir>` is `--dir`, else the first entry of `technology_dirs`, else
   `${XDG_DATA_HOME:-~/.local/share}/simra/technologies`. It never overwrites a pack file.
4. When the command says so, add the directory to `technology_dirs` of `simra.config.json` or `simra.local.json`.
5. Edit the pack file for the answers of step 2.
6. Run `npx simra pack check --pdk <name>`. It prints `pass`, `fail` (with the failure class) or `not run` (with the
   reason) for each check of the adapter.

Two packs with the same PDK name or pack name in the technology directories are an error. `simra pack check`
names both files.

## Files of record

A verdict is about the file that it ran on. When the file changes after the run, the verdict is stale. The kernel
reads the hashes of the input files in the records back, and compares them with the files in the design root.

A file of record is an input file of an experiment in the design root, with a role other than `deck`,
`technology` and `model`. For the klayout adapter, these are the layout (`layout`) and the reference netlist
(`netlist`).

1. The summary of an experiment (`run_experiment`, `wait_experiments`, `simra run`, `simra wait`, `simra show`)
   gives one line after the input files for each file of record that changed after the run, for example
   `STALE: layout block.gds changed after this run (now sha256:3f2a9c01b7d4)`.
2. The design record gives one block per file of record: the path, the current sha256, the last git commit of the
   file (when git tracks it), then one line per experiment that used the file. Current experiments come first,
   the most recent first. A stale experiment has the note `(stale: ran on sha256:<hash>)`. A file without a
   current experiment has the line `no check on the current file`.
3. Run `npx simra record` to print the design record, or `npx simra record block.gds` for one file. In pi, the agent
   calls `design_record` (optional `paths`).

Example:

```
layout block.gds sha256:3f2a9c01b7d4
  git 8d1e5a7c2b90 block: widen the vdd bus
  20261103-101530-4be2c1 klayout drc [full] completed markers=0 rules_violated=0
  20261103-100212-a0f3d9 klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0 (stale: ran on sha256:91c04e6a2f18)
netlist block.spice sha256:c7b2e0d4a611
  git 1f0a3b6c9d22 block: first version
  20261103-100212-a0f3d9 klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0
```

The record shows at most 6 experiments per file, and one line with the count of the others. Each line gives the
first 3 measurements of the run, without the runtime. The record runs no tool. It reads `simra/experiments` and
hashes the files of record.

In pi, the prompt rules tell the agent to confirm with `design_record` that a check is current before it reports
the check, and to rerun a stale check. When a file of record changed under the agent (another commit, another
process), the agent reads the new version and applies its change to it. It does not overwrite the file with its own
earlier copy.

## System prompt

In pi, the extension replaces the first paragraph of pi's system prompt. pi's paragraph describes a coding
assistant. The extension's paragraph (`SIMRA_PREAMBLE` in `packages/pi-extension/index.ts`) describes a chip
design assistant that reports only simulated numbers. The extension keeps pi's list of tools and the rules of the
tools. It adds one rule for PDFs (see [PDF reader](#pdf-reader)). It removes pi's section about the pi documentation.

A system prompt that you give to pi (`--system-prompt` or `.pi/SYSTEM.md`) stays as it is.

## Netlist check

Some simulator options add elements to the circuit. For example, `.option rshunt=5e5` connects 500 kΩ from
each node to ground, and the gain decreases. The ngspice adapter gives a warning, with the file and the line,
for `rshunt`, `cshunt` and a `gmin` above 1e-12:

- in the response of each `simulate` run;
- from the operation `lint` (input `files`), which runs no simulation.

In pi, the extension adds these warnings to the result of a `read`, `write`, `edit` or `bash` call that names a
netlist. It adds each warning one time per session.

## PDF reader

In pi, the agent reads a PDF with `read`. Before the call, the extension extracts the text of the PDF into a cache
one time. Then `read` gives the text with a `[page N]` marker before each page. `offset` and `limit` work as for a
text file.

The cache is `$SIMRA_CACHE_DIR`, else `$XDG_CACHE_HOME/simra`, else `~/.cache/simra`. Each PDF has a folder
`pdf/<sha256>/` with these files:

- `document.md`: a short header, then the pages. The header gives the source, the page count, the outline (with the
  page and the line of each entry) and the warnings. Page N starts with the line `[page N]`. N is the page number in
  the file, not the printed page label.
- `meta.json`: the hash, the page count, the outline, the warnings and the line of each page marker.
- `page-N.png`: an image of page N, at about 150 dpi (at most 2000 pixels on the long side). It exists after the
  first read of the page as an image.

The cache is per user, and you can delete it. The reader does not write into the design repository or the PDK tree.

To see a figure, the agent reads the PDF path with `#page=N` at the end, for example `rules.pdf#page=12`. The
extension renders the page to `page-N.png` with PDFium (WebAssembly), if the cache does not have it, and points the
call at the image. Then `read` shows the image. If the model has no image input, the extension stops the read and
tells the agent to use the text of the page.

The extension finds the file of a `read` call as pi's `read` finds it, also with `@`, `~`, `file://` URLs and the
macOS file-name fallbacks of pi.

The system prompt has a rule for PDFs: look at the page before you copy a circuit, table or plot from a figure, and
check a netlist copied from a figure with a simulation.

A page without text, for example a scanned page, gets the warning "No text layer". The reader does no OCR. An
encrypted or broken PDF gives an error, and the reader writes nothing to the cache.

From a plain command line:

1. Run `npx simra pdf <file>` to print the header and all pages.
2. Add `--pages 12-14` to print the header and only these pages.
3. Add `--render 12` instead to render page 12 and print the path of its image.

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

## Read a layout

To read a layout, the agent calls `run_experiment` with the adapter `klayout`, the operation `query` and several
questions in one call: for example the layers, the cell tree, the shapes and instances at a DRC marker box, or the
distance between two shapes. The answers are short rows in µm, in the summary of the experiment, and the full
answer is in `work/query.json`. The run is recorded like a deck run, with the hash of the layout.

To see what an edit or a commit changed, the agent calls the operation `diff`: the new layout against a file or
against `git:<ref>`. The answer gives, per layer, the area added and removed and the largest polygons with their cell
path, then the changed cells. With the ids of two `drc` runs, it also gives the new, fixed and unchanged markers of
each rule. To see a region or a DRC marker, the agent calls the operation `render`: a box, or the id of a `drc` run
and a rule. The picture (PNG, in the colours of the PDK, the marker outlined in red) comes with the result of
`run_experiment` as an image, after the summary. The prompt rules tell the agent to ask for a picture when the marker
boxes and the shapes do not tell which edge to move, and to write Python only to change a layout. See
[adapters/klayout/README.md](adapters/klayout/README.md).

## Layout

| Path | Contents |
| --- | --- |
| `packages/kernel/` | runner, experiment records, environments, PDF reader, `simra` CLI (no pi dependency) |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `adapters/ngspice/` | ngspice adapter (Python) and its tests; `design_check.py` has the operation `check_design` |
| `adapters/klayout/` | klayout adapter (Python) and its tests: DRC and LVS with the stock KLayout decks of the PDK, with typed verdicts, questions about a layout (`query`), the comparison of two layouts (`diff`) and pictures of a region or a marker (`render`) |
| `technologies/` | technology packs: the PDK facts that adapters need |
| `examples/ota-sg13g2/` | two-stage OTA for IHP SG13G2 |
| `evals/` | demo evaluations for the inner development loop (not decision benchmarks): the OTA at 3 corners, the OTA against a PVT spec, OTA synthesis from a pin specification (`ota-synthesis`), comparator synthesis from a pin specification (`comparator-synthesis`), their scorers and an arm runner. `synthesis-family.mjs` makes variants of the two synthesis tasks with tighter limits, from a hidden target design and a difficulty factor |
| `evals/layout-drc-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a small analog cell, with the stock KLayout DRC and LVS decks, on IHP SG13G2 and SKY130 |
| `evals/layout-clean/` | demo layout task (not a decision benchmark): verify the same cell without violations, with no false alarm and no needless edit |
| `evals/layout-block-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a hierarchical analog block (10012 devices, four levels of cells), on IHP SG13G2 (full DRC rule set, density included) and SKY130 |
| `evals/layout-false-pass/` | demo layout task (not a decision benchmark): verify the clean block with an LVS script that prints a match and then crashes; the agent must report the LVS check as not run |
| `evals/layout-long-job/` | demo layout task (not a decision benchmark): the block of layout-block-fix, flat and larger (21487 devices), so that one deck run takes minutes; the score reports how the agent ran the long decks (background runs, waits, log reads) |
| `evals/layout-stale-state/` | demo layout task (not a decision benchmark): the task of layout-block-fix, and during the run a colleague, not announced in the prompt, commits a new `block.gds` (two rules fixed, one new violation, one change to keep); the score checks that every reported number comes from the final `block.gds` and that the change is kept |
| `container/` | environment image: Containerfile, build and check scripts |
| `test/` | smoke and integration tests |

## Licence

Apache-2.0. See [LICENSE](LICENSE). See [NOTICE](NOTICE) for the credit to pi (MIT).
