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
- One adapter exists: ngspice.
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
2. Run `npx simra run run.json` in the design root.
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
  `between`), a `limit` and the `conditions`. The limit is one number, `[low, high]` for `between`, or one
  limit per condition.

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
or the row was not selected). The status is `pass` only when every row passes. A check of a part is never `pass`.

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

## Layout

| Path | Contents |
| --- | --- |
| `packages/kernel/` | runner, experiment records, environments, `simra` CLI (no pi dependency) |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `adapters/ngspice/` | ngspice adapter (Python) and its tests |
| `technologies/` | technology packs: the PDK facts that adapters need |
| `examples/ota-sg13g2/` | two-stage OTA for IHP SG13G2 |
| `evals/` | demo evaluations for the inner development loop (not decision benchmarks): the OTA at 3 corners, the OTA against a PVT spec, their scorers and an arm runner |
| `container/` | environment image: Containerfile, build and check scripts |
| `test/` | smoke and integration tests |

## Licence

Apache-2.0. See [LICENSE](LICENSE). See [NOTICE](NOTICE) for the credit to pi (MIT).
