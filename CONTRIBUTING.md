# Contributing

Thank you for your interest. The project is at stage 1. The structure is still small.

## Rules

- Add one capability at a time. Each capability comes with a test.
- Do not add directories for future work. A directory appears when it has content.
- Only `packages/pi-extension` imports pi. Other code must work without pi, from a plain command line.
- Do not commit credentials, data under NDA, foundry data outside a public PDK, or large simulation outputs.
- Report a check that did not run as **not run**. Do not omit it.

## Development

1. Install Node.js 22.19 or later.
2. Run `npm ci`.
3. Run `npm test`.

## The pi dependency

pi is a pinned npm dependency: `@earendil-works/pi-coding-agent` at an exact version in the root
`package.json`. We do not fork pi and we do not copy its code.

The extension package follows the pi package rules: it declares pi as a peer dependency with the range `*`
and does not bundle it. pi supplies its own copy at run time.

Current pin: **1.4.0** (released 2026-10-21). It was the latest release when the project started. The pin is
exact, so every install and every evaluation uses the same agent loop. Its documented extension API covers
what stage 0 needs (`registerCommand`, RPC mode, `get_commands`).

To change the pin:

1. Read the pi changelog between the two versions.
2. Change the version in the root `package.json`.
3. Run `npm install` to update `package-lock.json`.
4. Run `npm test`.
5. In the commit message, state the old version, the new version and the reason.

## Adapter contract (`simra.adapter/0`)

An adapter connects one tool (for example a simulator) to Simra Agent. An adapter is a directory with a
manifest, `adapter.json`, and an executable in any language. The ngspice adapter in `adapters/ngspice/` is the
reference implementation.

Manifest:

```json
{
  "contract": "simra.adapter/0",
  "name": "ngspice",
  "version": "0.1.0",
  "command": ["python3", "{adapter_dir}/ngspice_adapter.py"],
  "operations": { "simulate": { "description": "..." } }
}
```

The runner (`packages/kernel`) does these steps for each experiment:

1. It makes the directory `simra/experiments/<id>/` in the design root, with a `work/` subdirectory.
2. It writes `experiment.json` (what was asked) and `request.json`.
3. It writes `status.json` with the status `running`, the start time, and the pid and host of the process that
   runs the experiment. For a detached run, this process is a supervisor (`simra run --detached-worker <dir>`).
   Its own stdout and stderr go to `supervisor.stdout.log` and `supervisor.stderr.log`, and the command line of
   the adapter is in `job.json`.
4. It starts `command` with the path of `request.json` as the last argument, in the selected environment
   (`local`, or `container` with the engine `podman` or `docker`, from `simra.config.json`).
5. It writes the stdout and stderr of the adapter to `adapter.stdout.log` and `adapter.stderr.log`.
6. It reads `response.json` and writes `result.json`. Then it sets the result status in `status.json`.

`result.json` is the source of truth: a run without `result.json` did not end. The status `running` is only in
`status.json`, never in `result.json`. When the process of `status.json` is gone and there is no `result.json`,
the next wait (`waitExperiments`, `simra wait`, `wait_experiments`) writes `result.json` with the status `error`.

Request (written by the runner):

```json
{
  "contract": "simra.adapter/0",
  "experiment": "20261028-190501-3fa2c1",
  "adapter": "ngspice",
  "operation": "simulate",
  "inputs": { "deck": "tb.spice", "libs": [{ "path": "models.lib", "section": "tt" }] },
  "root": "/abs/path/to/design",
  "work_dir": "/abs/path/to/design/simra/experiments/20261028-190501-3fa2c1/work",
  "response_path": "/abs/path/to/design/simra/experiments/20261028-190501-3fa2c1/response.json"
}
```

Response (written by the adapter):

```json
{
  "contract": "simra.adapter/0",
  "status": "completed",
  "tool": { "name": "ngspice", "version": "46" },
  "input_files": { "complete": true, "files": [{ "path": "tb.spice", "sha256": "...", "bytes": 512, "role": "deck" }] },
  "outputs": [{ "path": "simra/experiments/20261028-190501-3fa2c1/work/ngspice.log", "sha256": "...", "bytes": 4096 }],
  "measurements": { "gain_db": { "value": 52.1, "unit": "dB", "status": "measured", "source": "work/ngspice.log:41" } },
  "diagnostics": [{ "severity": "warning", "message": "...", "source": "work/ngspice.log:12" }]
}
```

Rules:

- The adapter exits with code 0 after it writes a valid response. A non-zero exit code means that the adapter
  itself failed.
- The response `status` is `completed` (the tool ran to the end) or `failed` (the tool or its input failed).
- The runner status in `result.json` is `completed`, `failed`, `error` (the adapter broke the contract),
  `timeout` or `cancelled`. All statuses are execution status only. A completed run can still fail a
  specification.
- `input_files` lists every file that the tool read, with its hash. If the adapter cannot find a file, it sets
  `complete` to `false` and adds a diagnostic.
- `outputs` lists the files that the tool wrote, with their hashes. An entry may have a `role`. The summary
  prints the role before the path. A PNG with the role `image` is a picture for the agent: the pi extension
  adds it to the tool result as an image (at most 4 pictures and 1 MB per result). The klayout operation
  `render` writes such outputs.
- A measurement that the tool did not give has status `failed` or `missing` and the value `null`. It is never
  omitted.
- A measurement can have the optional field `at`: the sweep point where a reduced value (for example a minimum
  over a sweep) occurs, such as `{"vcm": 0.4}`.
- `tool` records the exact tool and version, so that a result can be traced.
- `commands` is optional. It lists the external commands of the tool that the adapter ran, in order. Each entry
  has `argv` (the command line as it was run, one word per item), `exit_code` (an integer, or `null` when the
  command did not start) and `runtime_s` (a number, or `null`). The adapter can leave out helper commands, for
  example a version check. The summary of the experiment gives one `command:` line for each entry. The klayout
  adapter fills it; the ngspice adapter does not. Example:
  `"commands": [{ "argv": ["klayout", "-b", "-r", "drc.lydrc"], "exit_code": 0, "runtime_s": 12.4 }]`.
- `report` is optional. It is a list of text lines that answer the request, for example the rows of a layout
  query. The runner copies it into `result.json`. The summary of the experiment prints the lines as they are,
  after the measurements, under the line `report:`. Keep the lines short and fixed in form (numbers, boxes, names;
  no prose). Keep the list short: put a full answer in a file in `work_dir`, add the file to `outputs`, and end a
  shortened list with a line that names the file. The klayout operations `query`, `diff` and `render` fill it. Example:
  `"report": ["[1] bbox top all layers: (0.000,0.000;21.000,21.000)  w=21.000 h=21.000 (top cell)"]`.
- The adapter writes logs to files in `work_dir` or to stderr. It does not write results to stdout.
- The adapter does not contain PDK facts (for example the parameter names of a MOS model). It reads them from
  a technology pack in the directory that `SIMRA_TECHNOLOGY_DIR` gives (see
  [technologies/README.md](technologies/README.md)). The runner sets this variable, and a container
  environment mounts the directory read-only. The adapter adds the pack file to `input_files` with the role
  `technology`.
