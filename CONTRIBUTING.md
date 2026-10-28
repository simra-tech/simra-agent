# Contributing

Thank you for your interest. The project is at stage 0. The structure is still small.

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

## Adapter contract (draft)

**Draft. This contract can change until the first adapter (ngspice) is built and tested.**

An adapter connects one tool (for example a simulator) to Simra Agent. An adapter is an executable file in any
language. Python, Tcl, shell and TypeScript are all acceptable.

1. Simra Agent starts the adapter with one argument: the path to a request file (JSON).
2. The adapter reads the request, does the work, and writes a response file (JSON) to the path given in the
   request.
3. The adapter writes logs to stderr or to files in its work directory. It does not write results to stdout.
4. The exit code is 0 when the adapter wrote a valid response. The response then gives the result of the work.
   A non-zero exit code means that the adapter itself failed.

Request (draft):

```json
{
  "contract": "simra.adapter/0",
  "adapter": "ngspice",
  "operation": "simulate",
  "inputs": { "netlist": "ota.spice", "corner": "tt" },
  "work_dir": "runs/2026-10-28-001",
  "response_path": "runs/2026-10-28-001/response.json"
}
```

Response (draft):

```json
{
  "contract": "simra.adapter/0",
  "status": "completed",
  "outputs": { "raw": "runs/2026-10-28-001/ota.raw" },
  "measurements": { "gain_db": 62.1 },
  "tool": { "name": "ngspice", "version": "46" },
  "diagnostics": []
}
```

- `status` is the execution status: `completed`, `failed` or `not_run`. It is not a verdict. A completed run
  can still fail a specification.
- All paths are relative to the design repository.
- `tool` records the exact tool and version, so a result can be traced.
- `diagnostics` lists warnings and errors from the tool in a structured form.

Open points for stage 1: the full schema, units, how a measurement is defined, and how inputs are hashed for
provenance.
