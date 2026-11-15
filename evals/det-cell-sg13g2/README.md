# Pilot task: recreate a detector cell from its specification rows

**This is a pilot task: one block, one public reference design, one run per arm. It is not a decision benchmark.**
It checks that an agent in the harness can recreate one block of a real chip from the rows of the chip's interface
specification, with requirements that the kernel checks.

The block is the 122.5 GHz power detector cell of a public 122 GHz radar design in IHP SG13G2 (revision A of its
detector block). The agent gets the rows of the interface specification that apply to the cell, the pins, the PDK
devices, a bench and the requirements. It gets no netlist and no result of the reference design.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `spec.md` | the specification rows, the pins, the devices, the corners and the requirements |
| `verify.spice` | the bench: a 50 Ω line with the cell, DC point, AC loss at 122.5 GHz, output noise, and a transient with the RF off, at −10 dBm and at 0 dBm |
| `requirements.json` | five corners, six requirements, the assumption ids |
| `score.mjs` | scorer: device rules, then the check of `requirements.json` on the final design through the kernel |
| `reference.mjs` | reference run: the reference design through the same bench, writes `expected.json` |
| `expected.json` | reference values per corner and requirement, with provenance |

## Reference

`reference.mjs` runs the reference cell (not in this repository; the path is an argument) through `verify.spice` at
the five corners. At tt the bench gives 0.960 mV at −10 dBm, 8.99 mV at 0 dBm, 2.23 µV rms of noise and 105 µA
(simulated, ngspice 46). The reference design records 0.95 mV and 8.89 mV (Xyce harmonic balance) and 2.23 µV rms,
and 0.209 mA for two cells, so the bench and the reference agree.

## Scoring

- design (2): the subcircuit, the pin order and the device rules of `spec.md`.
- requirements (30): each corner and requirement whose verified value passes. Only with the design points.
- claim (4): `meets_spec` is the same as the verification.
- values (30): each reported value is within the tolerance of the verified value (`TOLERANCE` in `score.mjs`).
- Diagnostics, no points: the reference value of each row and the verified value over it, the rows closed and
  missed, `supported`, and the reported largest V<sub>CE</sub> (the bench does not check it).
