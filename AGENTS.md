# AGENTS.md

Orientation for coding agents (and humans) that work in this repository.

## What this is

Simra Agent is an agent harness for chip design, built on [pi](https://github.com/earendil-works/pi).
pi runs the agent loop. This repository adds chip-design capabilities as a pi extension and as tools that
also work without pi. See [README.md](README.md) for the status.

## Repository map

| Path | Contents |
| --- | --- |
| `packages/kernel/` | runner, experiment records, environments, `simra` CLI (no pi dependency) |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `adapters/` | tool adapters (JSON-in / JSON-out), one directory per tool |
| `examples/` | small public example designs |
| `evals/` | demo evaluation tasks for the inner development loop (not decision benchmarks) |
| `test/` | smoke and integration tests |
| `.github/workflows/` | CI |

## Build and test

1. Use Node.js 22.19 or later.
2. Run `npm ci`.
3. Run `npm test`.

## Rules

- pi is a pinned npm dependency. Do not fork, vendor or patch pi. Only `packages/pi-extension` may import pi.
- Other code (kernel, records, adapters) must work without pi, from a plain command line.
- Adapters follow the JSON-in / JSON-out contract in [CONTRIBUTING.md](CONTRIBUTING.md) and may be written in
  any language.
- Add one capability at a time, each with a test. Do not create directories for future work.
- A check that did not run is reported as **not run**, never omitted.
- Do not commit credentials, data under NDA, or large simulation outputs.

## Writing style

Documentation uses short sentences, active voice and numbered steps for procedures. Keep technical names exact.

## Commits

A commit message states what changed and what evidence supports it (for example, which test passed).
