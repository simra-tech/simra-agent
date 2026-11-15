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

The device rules of the design part are the gate `netlist` of `requirements.json` (kernel `checkNetlist`; the scorer and
`check_requirements` use the same check). An X line of a PDK device may set only the instance parameters of the
`instance_params` class of the device in the technology pack (for the HBT: `Nx`, `Ny`, `m`). A parameter that changes
the device physics (for example `selft`, `dtemp`, `mm_ok`) is an error, unless the gate names it in `allow_params`.

## Limit sources

Each limit of `requirements.json` has `limit_source`: a row of the specification, a PDK document, a value set
from the reference design (the reference passes it by construction), or a choice of the task author.

| Limit | Value | Source | Reference |
| --- | --- | --- | --- |
| `idd_a` | <= 0.00015 A | specification | row 2: 0.3 mA for two detector cells (assumption two_cells) |
| `loss_db` | <= 0.3 dB | specification | row 1: 0.3 dB reserved in the output line for the detector |
| `vout_m10_v` | >= 0.0005 V | specification | row 4: meter resolution about 50 uV, times 10 (assumption meter_resolution) |
| `ratio_0_m10` | >= 3 | task author | assumption rising_response: the output rises with power (a square-law detector gives 10, a peak detector about 3.2) |
| `noise_rms_v` | <= 1e-05 V | task author | assumption noise_vs_meter: one fifth of the meter resolution |
| `offset_v` | <= 0.02 V | task author | assumption zero_range: the RF-off zero removes the offset |

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

## Repeat pilot run (one run, 2026-11-15)

The same task and arm with the image `simra-agent-env:0bd3eca` (registry in the image; the tools `monte_carlo`,
`device_limits` and `query_results` present). Default model, 4 CPUs, 180 min limit. One sample, not a rate.

| Item | Result |
| --- | --- |
| Score | design 2/2, requirements 30/30, claim 4/4, values 30/30; 30 of 30 values supported |
| Wall time, model calls | 2286 s, 103 calls |
| Tokens | 23.5 M prompt (23.4 M of them cached), 0.27 M completion (0.22 M reasoning) |
| Design | a square-law HBT detector behind a 25 fF MIM and a resistive divider, an identical replica, and two degenerated inverting stages; largest DC V<sub>CE</sub> 1.503 V (reported) |
| Registry | the entries came to the agent with its first result (automatic, once per session); the agent did not call `workarounds` |
| B-source error of the first run | did not return: every B source of the agent has literal numbers in `pwl`, as in `verify.spice` |
| Failed jobs | 4 jobs with a duplicate instance name in the agent's deck (design netlist error); other errors inside completed runs: probes of devices that do not exist, a division by zero, `max` of more than two vectors in `.control` |
| Not used | `query_results` (22 of 72 bash calls read the record JSON files), `monte_carlo`, `device_limits` (the task has no row for them) |

What this run does not show: that the registry caused the missing B-source error. The agent copied the source form
of `verify.spice`, which has literal numbers, and it never cited the entry.
