# Low-noise amplifier at 122.5 GHz, IHP SG13G2

## Function

The amplifier is the first stage of the receiver of a 122 GHz radar. It amplifies the signal from the receive
antenna and drives the mixer. In this task both ports are 50 Ω.

## Rows of the interface specification of the chip (the source of this task)

1. LNA gain 13 dB to 15 dB from 122 GHz to 123 GHz (revision 0.1 of the interface rows).
2. LNA noise figure ≤ 6 dB at tt (revision 0.1).
3. `LNAOUT` S22 ≤ −10 dB.
4. Stable: μ > 1 from 1 GHz to 300 GHz at every corner.
5. Current budget of the LNA: 25 mA from VCC18.
6. Bias: three PTAT reference currents from the bias block, 0.863 mA, 0.912 mA and 1.330 mA at 27 °C.
7. HBT limits: V<sub>CE</sub> ≤ 1.6 V for each device at every corner (DC value); collector current ≤ 3 mA per
   emitter (`Nx`).

## Interface

The amplifier is the subcircuit `lna` in `lna.spice`, with the pins `rfin rfout vcc18 iref1 iref2 iref3`, in this
order.

| Pin | Function |
| --- | --- |
| `rfin` | RF input (50 Ω source through a DC block of the bench) |
| `rfout` | RF output (50 Ω load through a DC block of the bench) |
| `vcc18` | supply, 1.8 V ± 5 % |
| `iref1`, `iref2`, `iref3` | bias references: the bias block drives a current into each pin from VCC18 (row 6) |

Ground is node `0`. The bench puts 1 GΩ from `rfin` and from `rfout` to ground, so a series capacitor at a port is
allowed.

## Devices

1. HBT: `npn13G2` (subcircuit of the PDK HBT library; parameter `Nx` for the number of emitters).
2. MIM capacitor: `cap_cmim` (parameters `w`, `l`).
3. Resistors: `rppd`, `rsil`, `rhigh` (parameters `w`, `l`).
4. TopMetal2 lines of `lines.spice`: `tm2_w6`, `tm2_w13`, `tm2_w23`, each with `len` ≤ 1 mm (in metres). Do not
   change `lines.spice`.
5. EM passives: a passive structure that you draw (GDS, IHP SG13G2 layers), simulate with `em_sparameters` on the PDK
   stackup and fit with `fit_to_spice`. Copy the fitted subcircuit into `lna.spice`. It counts only when the records
   of the workspace show the EM run and the fit (the scorer finds the fit output by its content). The design must
   have at least one EM passive in the signal path (a matching network, a transformer, an inductor or a line
   section).
6. Ideal R, L and C only as a model of wiring (each ideal C ≤ 50 fF, each ideal L ≤ 50 pH, each ideal R ≤ 50 Ω),
   and K couplings between the ideal L.
7. No ideal sources in the amplifier, except inside an EM passive from `fit_to_spice`.

## Verification

`sp.spice` (S-parameters and the supply current) and `noise.spice` (noise figure and gain) are the benches.
`requirements.json` gives the corners, the benches and the requirements:

| Corner | HBT, MIM and rppd corner | VCC18 | Temperature | ptat |
| --- | --- | --- | --- | --- |
| `tt` | typ | 1.80 V | 27 °C | 1.000 |
| `slow_hot` | wcs | 1.71 V | 125 °C | 1.326 |
| `slow_cold` | wcs | 1.71 V | −40 °C | 0.777 |
| `fast_hot` | bcs | 1.89 V | 125 °C | 1.326 |
| `fast_cold` | bcs | 1.89 V | −40 °C | 0.777 |

| Requirement | Corners | Limit | Source |
| --- | --- | --- | --- |
| `gain`: S21, 122 GHz to 123 GHz | tt | 13 dB to 15 dB | row 1 |
| `nf_db`: noise figure, worst of 122, 122.5 and 123 GHz | tt | ≤ 6 dB | row 2 |
| `s22`: S22, 122 GHz to 123 GHz | tt | ≤ −10 dB | row 3 |
| `mu`: stability factor μ, 1 GHz to 300 GHz | all | ≥ 1 | row 4 |
| `idd_a`: current from VCC18, the reference currents included | all | ≤ 25 mA | row 5 |
| gate `limits`: the operating limits of each HBT at the DC point | all | the PDK pack, and `ic_per_emitter` ≤ 3 mA | row 7 |

The stability gate (`gates.stability`) and the operating-limit gate (`gates.limits`) of `requirements.json` add
their rows to the check. Only the S-parameter bench `sp` is checked by the limit gate.
