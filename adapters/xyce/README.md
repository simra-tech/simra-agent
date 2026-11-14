# xyce adapter

The xyce adapter runs Xyce and gives typed results. It has three operations:

- `parse`: `Xyce -norun` on a deck and its model libraries. It reports the model gaps (devices that Xyce cannot
  simulate with the given model cards) and fidelity warnings, each with the file and line of the model card.
- `simulate`: one run of a deck (`.ac`, `.tran`, `.dc`, `.op`, `.lin`), with `.measure` results as measurements. A
  `.LIN` analysis writes a Touchstone file with the role `touchstone`.
- `hb`: harmonic balance, one Xyce process per sweep point. It gives the power per harmonic or mixing product,
  DC supply currents, and with a power sweep the gain and P1dB.

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

## Evaluation on two technologies

The tests in `test/xyce-pdk-container.test.mjs` run in an image with both PDKs (`SIMRA_TEST_IMAGE`).

| Technology | Model library | Result |
| --- | --- | --- |
| ihp-sg13g2 | the Xyce libraries of the kit | `parse`: 1 gap, the PSP 103 MOS card (Xyce rejects its parameters). The HBT card parses; Xyce ignores its safe-operating parameters (fidelity warnings). `hb` of a common-emitter npn13G2 stage at 61 GHz converges. |
| sky130A | the ngspice library (the kit has no Xyce library) | `parse`: no gap; Xyce replaces BSIM4 version 4.5 by 4.6.1 (fidelity warning). |

The known-answer tests (`test/xyce.test.mjs`) use decks with ideal devices: an RC low-pass with `params` and
`temp_c`, the refusals, a `.LIN` Touchstone output, model gaps, the harmonics of a cubic, and P1dB from a power sweep
against the closed form. `test_xyce_adapter.py` (12 tests) needs no Xyce: it uses excerpts of Xyce 7.10 logs in
`fixtures/`.
