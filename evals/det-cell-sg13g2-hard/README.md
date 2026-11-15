# Pilot task: the detector cell with mismatch, operating limits and an EM tap (hard variant)

**This is a pilot task: one block, one public reference design, one run per arm. It is not a decision benchmark.**
It is `det-cell-sg13g2` with the rows that the first bench did not see. An agent can fail it for design reasons that
the first task could not show.

| Added row | Why the first task did not see it |
| --- | --- |
| `offset_3s`: \|mean\| + 3 σ of the offset over the PDK mismatch, 100 seeds per corner, ≤ 20 mV | the corner models have no mismatch: the first bench gave an offset of about 1e-14 V |
| gate `limits`: the PDK limits of each HBT at the DC point, and V<sub>CE</sub> ≥ 0.4 V at every corner | the first bench did not read the device voltages |
| `tap_s21`, `tap_s31`: the tap on the line as a layout, simulated with openEMS | the first bench modelled the tap as an ideal capacitor |

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `spec.md` | the rows of `det-cell-sg13g2`, and the mismatch, the limits and the tap |
| `verify.spice` | the bench of `det-cell-sg13g2` (unchanged) |
| `offset.spice` | DC bench without RF: the offset for the Monte Carlo experiment and the DC point for the limit gate |
| `requirements.json` | five corners, seven cell requirements, two tap rows without a corner, the operating-limit gate |
| `make_tap.py` | the reference tap layout (run it in the eda image: it needs gdstk) |
| `score.mjs` | scorer: device rules, then the check of `requirements.json` on the final cell and `tap.gds` |
| `reference.mjs` | reference run, writes `expected.json` |
| `expected.json` | reference value of each row (72 rows), with provenance |

## Reference

The reference is the detector cell of record of the public design and the tap of `make_tap.py` (a TopMetal2 spur,
a TopVia2, a 1.3 µm MIM of about 2.5 fF on a Metal5 plate). Every row passes (simulated, ngspice 46 and openEMS
0.37):

| Row | Reference |
| --- | --- |
| offset, \|mean\| + 3 σ | 9.6 mV (cold corners) to 16.9 mV (hot corners); 100 seeds each, every seed with a DC point |
| smallest V<sub>CE</sub> | 0.409 V (slow_cold); 0.536 V at slow_hot |
| largest V<sub>CE</sub> | 1.284 V (fast_cold) |
| tap S21, 122 GHz to 123 GHz | −0.205 dB |
| tap S31, 122 GHz to 123 GHz | −30.77 dB |

What the reference values do not prove:

1. The V<sub>CE</sub> minimum of 0.4 V is a stated task limit, not a PDK limit. It was set after the reference run:
   0.5 V fails the reference cell at slow_cold (0.409 V). The detector cell of the first pilot run (0.592 V at
   slow_hot) was not run at slow_cold.
2. The stated coupling (−30 dB ± 3 dB) is the coupling of a tap of about 2.5 fF, the tap capacitance of the reference
   cell. The public design has no EM record of its tap: the tap rows have no reference value from the design.
3. Two EM runs of the same tap gave S21 −0.2071 dB and −0.2046 dB (different CPU sets); the value tolerance is 0.05 dB.

## Scoring

- design (2): the subcircuit, the pin order and the device rules of `det-cell-sg13g2`.
- requirements (72): each verified row passes, the gate rows included. Only with the design points.
- claim (4): `meets_spec` is the same as the verification.
- values (37): each reported value of a requirement row is within the tolerance of the verified value.
