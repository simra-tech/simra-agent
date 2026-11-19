# xyce adapter

The xyce adapter runs Xyce and gives typed results. It has three operations:

- `parse`: `Xyce -norun` on a deck and its model libraries. It reports the model gaps (devices that Xyce cannot
  simulate with the given model cards) and fidelity warnings, each with the file and line of the model card.
- `simulate`: one run of a deck (`.ac`, `.tran`, `.dc`, `.op`, `.lin`), with `.measure` results as measurements. A
  `.LIN` analysis writes a Touchstone file with the role `touchstone`.
- `hb`: harmonic balance, one Xyce process per sweep point. It gives the power per harmonic or mixing product,
  DC supply currents, and with a power sweep the gain and P1dB.
- `hb_limits`: the hb run of an experiment with the terminal voltages and lead currents of each HBT, and the operating
  limits of the technology pack on the cycle means and on the peak voltages over one period (the gate `limits` of a
  check on an hb experiment). It reads the limits and the HBT cells from the pack section of the ngspice adapter
  (`ngspice.limits.<pdk>`) and needs the ngspice adapter directory next to this one. Instantaneous conduction
  currents are not checked (registry entry `xyce-sg13g2-hb-terminal-currents`).

The inputs, measurements and outputs are in [adapter.json](adapter.json). The adapter needs Python 3.6 or later
(standard library only) and Xyce 7.

The adapter has no PDK facts. The model libraries come from the caller (input `libs`).

## Guards

Xyce accepts some inputs with only a warning, or with no message, and then gives a wrong result. The adapter
refuses or reports these cases:

| Xyce behaviour (7.10) | Guard |
| --- | --- |
| `.temp` is ignored; the run is at 27 C | refused; use `temp_c` |
| the first `.param` and the first temperature win; a later one is ignored | `params` and `temp_c` are written before the deck; runs use `-redefined_params usefirst` |
| a YLIN device is an open circuit outside HB, with no message | refused with `.ac`, `.tran`, `.lin`, `.dc` and `.op`; use the touchstone adapter |
| a model card with parameters for another simulator | `parse`: model gap (error) |
| a parameter of a model is dropped | `parse`: fidelity warning |
| an older model version is replaced | `parse`: fidelity warning |
| HB of a circuit without a drive converges to the DC state | warning: no port has signal (Xyce HB has no oscillator mode) |
| an HB point exits with 0 but without the output | point status `missing`, never a value |
| the HB output spectrum is two-sided | power from 2 &#124;X&#124;; tested against a closed form |
| an MPI start failure | retried two times |
| HB of an HBT circuit fails at a global −40 C or 125 C (DC point failed, or no HB Newton convergence) where 27 C converges | `temperature_method: "dtemp_tf"` (hb, hb_limits): a global 27 C, `dtemp` = T − 27 on every npn13G2 instance of the deck and its includes, `vbic_tf` of the cornerHBT.lib section scaled by ((T + 273) / 300)^0.7; other devices (MIM) stay at 27 C. A PA output stage: global fails at 4 of 4 cases, dtemp_tf converges at 4 of 4 |

## Cross-simulator device check

Operation `device_crosscheck`: one device of a named model in ngspice and in Xyce at the same bias and frequencies.
It compares the DC port currents and the y-parameters (see the docstring of `device_crosscheck.py` for the inputs
and the method). A difference above the tolerance (default 2 %) is a finding. The operation does not say which
simulator is right.

Result on ihp-sg13g2, `npn13G2` Nx 4, V<sub>BE</sub> 0.88 V, V<sub>CE</sub> 1.2 V, 27 °C (simulated, ngspice 46 and
Xyce 7.10):

| ngspice setting | DC difference | Largest y difference at 61 GHz and 122.5 GHz | Findings |
| --- | --- | --- | --- |
| default (`sw_nqs=0`) | 0.02 % | 13.7 % (y21 at 122.5 GHz: 60.9 mS at −37.3° against 62.97 mS at −45.1°) | y21 at both frequencies, y11 and y22 at 122.5 GHz |
| `sw_nqs=1` | 0.02 % | 1.2 % (y21 at 122.5 GHz) | none |

With `sw_nqs=1` and a frequency list that includes 1 GHz, one finding stays: y22 at 1 GHz is 0.114 mS in ngspice
and 0.068 mS in Xyce (3.5 % of the largest y). Its cause is not known; both cards have self-heating on.

## Evaluation on two technologies

The tests in `test/xyce-pdk-container.test.mjs` run in an image with both PDKs (`SIMRA_TEST_IMAGE`).

| Technology | Model library | Result |
| --- | --- | --- |
| ihp-sg13g2 | the Xyce libraries of the kit | `parse`: 1 gap, the PSP 103 MOS card (Xyce rejects its parameters). The HBT card parses; Xyce ignores its safe-operating parameters (fidelity warnings). `hb` of a common-emitter npn13G2 stage at 61 GHz converges. |
| sky130A | the ngspice library (the kit has no Xyce library) | `parse`: no gap; Xyce replaces BSIM4 version 4.5 by 4.6.1 (fidelity warning). |

The operation `probe_devices` runs one deck per device class of the technology pack (see "Device-class probe" in the
main README). On IHP SG13G2 it adds two gaps to the table above: the r3_cmc resistor cards (rsil, rppd, rhigh) and
the HV varactor (no subcircuit in the Xyce library). A subcircuit that the library does not define is the finding
class `subcircuit missing` (a gap).

The known-answer tests (`test/xyce.test.mjs`) use decks with ideal devices: an RC low-pass with `params` and
`temp_c`, the refusals, a `.LIN` Touchstone output, model gaps, the harmonics of a cubic, and P1dB from a power sweep
against the closed form. `test_xyce_adapter.py` (12 tests) needs no Xyce: it uses excerpts of Xyce 7.10 logs in
`fixtures/`.
