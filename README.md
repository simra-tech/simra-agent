# Simra Agent

Simra Agent is an agent harness for chip design. It is built on [pi](https://github.com/earendil-works/pi).

pi runs the agent loop. Simra Agent adds what a chip designer needs and a coding agent does not have:

- long jobs (simulation, extraction, place and route) that continue after the session stops
- evidence: which experiment used which inputs, gave which result, and what that result can claim
- design state and decisions, kept as plain files in the design repository
- domain tools (simulator, layout tool, PDK) through tested adapters

The first targets are analog and mixed-signal design with an open PDK and open-source EDA tools.

## Status

**Stage 0. Nothing is usable yet.**

This repository holds only the foundation: a pinned pi release, an empty pi extension, and one smoke test.
The extension registers one command, `/simra-version`. It has no chip-design function yet.

## Requirements

- Node.js 22.19 or later
- npm

## Install and test

1. Clone the repository.
2. Run `npm ci`.
3. Run `npm test`.

The smoke test starts pi in RPC mode with only the Simra extension loaded. It needs no model, no API key and
no network access after `npm ci`.

## Try the command in pi

1. Run `npx pi -e ./packages/pi-extension`.
2. Type `/simra-version`.

pi shows the Simra Agent version and the pi version.

## Layout

| Path | Contents |
| --- | --- |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `test/` | smoke test |

## Licence

Apache-2.0. See [LICENSE](LICENSE). See [NOTICE](NOTICE) for the credit to pi (MIT).
