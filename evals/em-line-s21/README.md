# Demo evaluation: S21 of an on-chip line from an EM simulation

**This is a demo task for the inner development loop. It is not a decision benchmark.** Use it to check the openems
adapter and the tool `em_sparameters` from start to end, with a real model. Do not use its score to compare harnesses
or to make a release decision: one small public task cannot support that.

The task gives a layout only (`line.gds`: a TopMetal2 line, 600 um x 18 um, over a Metal1 ground, IHP SG13G2 layers).
The agent must run an EM simulation on the PDK stackup and state S21 at 60 GHz in dB and degrees.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `line.gds` | the layout (`adapters/openems/fixtures/make_line.py line.gds 600`) |
| `reference.mjs` | reference run: `emSParameters` (openems `simulate` per port, then `merge`), and the trap runs |
| `expected.json` | reference values, tolerance, trap values and provenance |
| `score.mjs` | scorer for one workspace |
| `task.json` | task manifest for `../run-arm.mjs` |

## Reference

`reference.mjs` runs the line with ports from Metal1 to TopMetal2 at both ends, 1 GHz to 70 GHz, PML boundaries and
the end criterion -40 dB. It reads S21 at 60 GHz from the Touchstone file. The values are in `expected.json`
(simulated, openEMS 0.37).

## Scoring

- Magnitude: 2 points when `s21_db` is within 0.05 dB of the reference.
- Phase: 2 points when `s21_deg` is within 3 degrees of the reference (modulo 360 degrees).
- Diagnostics, no points:
  - `supported`: both values are also in a file of the workspace other than `answer.json`.
  - `trap`: the magnitude and the phase are both near a known mistake. `oxide_tem` is an ideal TEM line in SiO2
    (permittivity 4.1): 0 dB, and a phase 1 degree from the reference, so only the magnitude separates it.
  - A run with first-order MUR boundaries (60000 time steps) gave the same S21 at 60 GHz within 0.001 dB and 0.1
    degree, so it is not a trap on this line.
  - `frequency`: `f_hz` is 60 GHz.
