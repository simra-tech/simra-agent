# Contributing

Thank you for your interest. The project is at stage 1. The structure is still small.

## Rules

- Add one capability at a time. Each capability comes with a test.
- Do not add directories for future work. A directory appears when it has content.
- Only `packages/pi-extension` and `packages/launcher` (the `simra` binary) import pi. Other code must work without
  pi, from a plain command line.
- Do not commit credentials, data under NDA, foundry data outside a public PDK, or large simulation outputs.
- Report a check that did not run as **not run**. Do not omit it.

## Development

1. Install Node.js 22.22 or later.
2. Run `npm ci`.
3. Run `npm test`.

## Release

A tag `v<version>` starts `.github/workflows/release.yml`.

1. Set the version in the root `package.json`. Commit the change.
2. Run `git tag v<version>` and `git push origin v<version>`. The tag must be the version of `package.json`.
3. Check the release on GitHub when the workflow ends.

A tag with a suffix, for example `v0.2.0-rc.1`, gives a pre-release, which the install line does not use.

Turn on release immutability in the repository settings once. Then the files of a published release cannot change.

## Analytics

Use `telemetry` from `@simra-tech/kernel/telemetry` for analytics in the CLI and extensions. The kernel has no
pi dependency. The runner captures adapter activity for both entry points. Adapters must not send their request
or response JSON to an analytics service. Plugins use the same API and opt-out policy; do not create another SDK
client or enable automatic logs, exception capture or LLM wrappers that collect content.

The shared boundary requires explicit saved opt-in in `analytics.json`. Never infer consent from an API key,
an analytics identifier or another setting. The launcher asks before setup events and defaults to off.
Headless runs never ask. `simra analytics on/off/status` manages the preference without sending events.
Environment opt-outs always win, and the transport checks consent again before sending queued batches.

1. Add a named event and its property rules in `packages/kernel/src/telemetry.ts`.
2. Review every property for design content, identifiers, paths, secrets and arbitrary strings. Prefer fixed
   categories, booleans and counts. Unrecognized fields are dropped at runtime. Custom names become `custom`.
3. Add a payload test that includes private content and verifies it cannot leave the boundary.
4. Call `telemetry.capture(...)` with selected metadata. Do not spread an event, model object or record.
5. Await `telemetry.shutdown()` at a standalone process boundary. Do not flush after each tool call.

The pi extension registers only the shipped public model catalog with `registerPublicModels`. Never register
user model configuration or a live provider catalog. Usage counts come from finalized assistant messages,
including failed/aborted responses when pi emits them. pi excludes cache tokens from input counts, so native
PostHog generation events set `$ai_cache_reporting_exclusive=true`. Costs come from pi; `cost_is_estimate`
distinguishes catalog estimates from provider-reported totals. These are usage metrics, not billing records.
Requests outside pi's assistant lifecycle are not automatically instrumented.

For releases, set the GitHub repository variables `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. Use a public
project ingestion token, never a personal API key. The release workflow passes these to the Bun build, which
embeds them in the binary. Local builds use the same environment variables. Empty settings produce a binary
with analytics inactive unless the user supplies runtime settings. Every build also requires the user's saved
opt-in before sending any events. CI and release tests set
`SIMRA_NO_ANALYTICS=1`; this opt-out is checked at runtime and is not baked into the binary. The eval runner
also forces the opt-out inside each container, after caller-supplied environment values.

Run `npm test` to check filtering, model/token events, trace linkage, opt-out behavior and real HTTP delivery to
a local capture server. Tests use a dummy ingestion token and do not send test events to PostHog.

## The pi dependency

pi is a pinned npm dependency: `@earendil-works/pi-coding-agent` at an exact version in the root
`package.json`. We do not fork pi and we do not copy its code.

The extension package follows the pi package rules: it declares pi as a peer dependency with the range `*`
and does not bundle it. pi supplies its own copy at run time.

Current pin: **1.5.0**. The pin is exact, so every install and every evaluation uses the same agent loop.

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
  a technology pack in the directories that `SIMRA_TECHNOLOGY_DIR` gives, a list separated by `:` that the
  adapter searches in order (see [technologies/README.md](technologies/README.md)). The runner sets this
  variable from `technology_dirs` of the configuration and the built-in directory, and a container environment
  mounts each directory read-only. The adapter adds the pack file to `input_files` with the role
  `technology`.

Optional operations for PDK onboarding (`simra pack init` and `simra pack check` run them):

- `pack_propose` inspects a PDK kit and proposes a technology pack. Inputs: `pdk` (the PDK name of the pack),
  `pdk_root` (optional; the kit directory), and inputs of the adapter. Response fields:
  - `tool.pack`: the proposed pack (a `simra.technology/0` object), or null when the adapter proposes none. The
    response status is then `failed`.
  - `tool.questions`: a list of strings, the open questions for the user. Empty when there are none.
  - `tool.facts` (optional): a list of `{ key, value, source: { file, line, read }, confidence, note }`. `read` is
    `surface` (file names, directory layout, section and header lines) or `inside` (the content of a kit file).
    `confidence` is `sure`, `guess` or `todo`.
  - `tool.read_inside` (optional): a list of `{ file, why }`, one entry for each read inside a kit file.
  - `outputs`: the pack file in `work_dir`, with the role `technology`.
  - `report`: the facts and the questions as short lines.
  The adapter writes nothing outside `work_dir`. It puts only names, sections, units, paths and device names into
  the pack: no model text and no parameter values of the kit. The kernel writes the pack after the user confirms.
- `pack_check` checks a pack on the kit. Inputs: `pack` (the path of the pack file), `pdk`, and inputs of the
  adapter. Response field `tool.check`: `{ pack, items }`. Each item has `name`, `status` (`pass`, `fail` or
  `not run`), and optionally `class` (the failure class of a `fail`), `reason` (for `fail` and `not run`) and
  `value`. A check that did not run is an item with `not run`, never left out. The response status is `failed`
  when an item fails.
