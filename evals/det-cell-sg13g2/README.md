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

## Pilot run (one run, 2026-11-15)

One run of the `simra` arm with the default model of the harness (`deepseek/deepseek-flash`), 4 CPUs, 180 min limit,
image `simra-agent-env:db92a2b`. This is one sample, not a rate.

| Item | Result |
| --- | --- |
| Score | design 2/2, requirements 30/30, claim 4/4, values 30/30; 30 of 30 values supported by a workspace file |
| Wall time, model calls | 1037 s, 50 calls |
| Tokens | 6.35 M prompt (6.29 M of them cached), 0.12 M completion (0.10 M reasoning) |
| Design | two common-emitter HBTs (detector and replica) with a bypassed emitter resistor, a 2.9 fF capacitive tap, a diode bias from `iref`; outputs at the emitters |
| Against the reference | at every corner: 0.54 to 0.70 of the reference current, 3.9 to 4.0 times the reference output at −10 dBm, 0.26 to 0.50 of the reference noise, 1.08 to 1.20 of the reference loss |
| Rows the bench does not check | reported largest DC V<sub>CE</sub> 1.419 V (fast_cold), found in the run records; band edges 122 GHz and 123 GHz checked by the agent with its own deck |
| Not checked by any gate | offset with device mismatch (the corner models have no mismatch, so `offset_v` is about 1e-14 V); HBT saturation (V<sub>CE</sub> 0.60 V at slow_hot); the tap and the line as a layout |

The image of the run did not have the workaround registry (the runtime list of `container/build.sh` did not have
`workarounds/`); the agent called the `workarounds` tool once and got no entries. Two of its jobs failed on an ngspice
parse error that is now the registry entry `ngspice-bsource-pwl-bare-param`.
