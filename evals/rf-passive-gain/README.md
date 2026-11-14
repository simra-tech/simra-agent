# Demo evaluation: amplifier gain with a Touchstone network

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check the
touchstone and xyce adapters from start to end, with a real model. Do not use its score to compare harnesses or to
make a release decision: one small public task cannot support that.

The task gives a matching network only as S-parameters (`match.s2p`) and an amplifier deck (`amp.cir`) that needs the
network as a subcircuit. The agent must make a circuit model of the data and simulate the deck with it.
All devices are ideal: the task needs no PDK.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `network.mjs` | the closed form of the network and the amplifier (nodal analysis, no simulator) |
| `generate.mjs` | writes `match.s2p` from `network.mjs` |
| `match.s2p`, `amp.cir` | the files of the task |
| `reference.mjs` | reference run: `touchstone` `fit_to_spice`, then `xyce` `simulate` through a requirements check |
| `expected.json` | reference value, tolerance, trap values and provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` |

## Reference

`reference.mjs` does these steps in `work/reference` (not tracked):

1. It fits `match.s2p` for the band of the deck (0.25 GHz to 30 GHz) with `fit_to_spice`. The adapter
   re-simulates the subcircuit in ngspice and in Xyce.
2. It runs a requirements check: |S21| at 10 GHz (kind `s_db`) and mu over the band (kind `mu`), from the
   Touchstone output of the Xyce `.LIN` analysis.
3. It compares |S21| at 10 GHz with the closed form. It stops when the difference is more than 0.05 dB.

Values of the reference run (`expected.json`, simulated):

| Quantity | Value |
| --- | --- |
| fit order, largest fit error | 4, 5.9e-4 (absolute, in S) |
| re-simulation error, ngspice and Xyce | 5.9e-4 each |
| gain at 10 GHz, Xyce with the fitted model | 14.923 dB |
| gain at 10 GHz, closed form | 14.928 dB |
| smallest mu in the band | 1.003 at 30 GHz |

## Scoring

- Gain: 4 points when `gain_db` is within 0.1 dB of the reference.
- Diagnostics, no points:
  - `supported`: the value is also in a file of the workspace other than `answer.json`.
  - `trap`: the wrong value is near a known mistake. `without_network` is the amplifier into 50 ohm (13.354 dB).
    `lossless_network` is the network with R = 0 (15.131 dB).
  - `frequency`: `f0_hz` is 10 GHz.

## Run

```
SIMRA_LOCAL_JSON=<machine file> node evals/rf-passive-gain/reference.mjs   # needs an eda image with Xyce and ngspice
node evals/rf-passive-gain/score.mjs <workspace>
```
