# Power-amplifier output stage at 122.5 GHz, IHP SG13G2

## Function

The stage is the output stage of the transmit amplifier of a 122 GHz radar. A driver stage feeds it, and it drives the
transmit antenna. In this task the source and the load are 50 Ω, and the drive is an available power of +3 dBm at 122.5 GHz.

## Rows of the interface specification of the chip (the source of this task)

1. `TXOUT` ≥ +3 dBm at tt and ≥ 0 dBm at every corner, at 122.5 GHz (here: the output power of the stage into 50 Ω at
   the +3 dBm drive).
2. Unconditional stability from 1 GHz to 300 GHz (50 Ω): μ > 1 at every corner.
3. HBT limits: V<sub>CE</sub> ≤ 1.6 V and collector current ≤ 3 mA per emitter (`Nx`) for each device at every corner.
4. `VCCPA` is a trimmed rail from 0.70 V to 1.10 V. A detector loop sets it per die. This task uses 0.90 V at tt and
   at the slow corners, and 0.80 V at the fast corners.
5. Bias: a reference current of 2.2 mA from VCC18 into the stage.
6. Current: the PA takes at most 45 mA in total; this task gives the stage 25 mA from `VCCPA` under the drive.

## Interface

The stage is the subcircuit `pa_stage` in `pa_stage.spice`, with the pins `rfin rfout vccpa vcc18 iref`, in this
order.

| Pin | Function |
| --- | --- |
| `rfin` | RF input: 50 Ω source with the available power of the drive (no DC block in `hb.spice`; a DC path to the source resistor is the design's choice) |
| `rfout` | RF output: 50 Ω load to ground (no DC block in `hb.spice`; the stage must block its DC at the output) |
| `vccpa` | the supply of the output device, 0.90 V or 0.80 V (row 4) |
| `vcc18` | supply, 1.8 V ± 5 % |
| `iref` | bias reference: 2.2 mA from VCC18 into this pin (row 5) |

Ground is node `0`.

## Devices

1. HBT: `npn13G2` (subcircuit of the PDK HBT library; parameter `Nx` for the number of emitters).
   Write `sw_nqs=1` on every `npn13G2` instance: it turns on the excess phase of the HBT model, which the ngspice
   model has off by default. The netlist gate requires it; another value is a rule error. Xyce accepts the parameter; its model has
   the excess phase always on.
2. MIM capacitor: `cap_cmim` (parameters `w`, `l`).
3. EM passives: a passive structure that you draw (GDS, IHP SG13G2 layers), simulate with `em_sparameters` on the PDK
   stackup and fit with `fit_to_spice`. Copy the fitted subcircuit into `pa_stage.spice`. It counts only when the
   records of the workspace show the EM run and the fit. The design must have at least one EM passive in the signal
   path. The fit-band gate checks each bench that uses a fitted model: give `fit_to_spice` the band of use
   `uses.band_hz` that covers the S-parameter sweep (1 GHz to 300 GHz) and the harmonics of the harmonic balance
   (122.5 GHz × 3 = 367.5 GHz), and `uses.dc` true.
4. Ideal R, L and C only as a model of wiring or bias (each ideal C ≤ 50 fF, each ideal L ≤ 50 pH, each ideal
   R ≤ 100 Ω), and K couplings between the ideal L. The PDK poly resistors are not in the device list: Xyce does not
   simulate their model card (workaround registry `xyce-sg13g2-r3cmc`).
5. No ideal sources in the stage, except inside an EM passive from `fit_to_spice`.
6. On the PDK devices, only the instance parameters of the technology pack (for the HBT: `Nx`, `Ny`, `m`). A
   parameter that changes the device physics (for example `selft`, `dtemp`, `mm_ok`) is a rule error.

## Verification

`hb.spice` (Xyce harmonic balance at 122.5 GHz, 3 harmonics: output power, `VCCPA` current) and `sp.spice` (ngspice
S-parameters for μ) are the benches. `requirements.json` gives the corners, the benches and the requirements:

| Corner | HBT and MIM corner | VCC18 | VCCPA | Temperature |
| --- | --- | --- | --- | --- |
| `tt` | typ | 1.80 V | 0.90 V | 27 °C |
| `slow_hot` | wcs | 1.71 V | 0.90 V | 125 °C |
| `slow_cold` | wcs | 1.71 V | 0.90 V | −40 °C |
| `fast_hot` | bcs | 1.89 V | 0.80 V | 125 °C |
| `fast_cold` | bcs | 1.89 V | 0.80 V | −40 °C |

| Requirement | Corners | Limit | Source |
| --- | --- | --- | --- |
| `pout_tt`: output power at 122.5 GHz into 50 Ω at the drive | tt | ≥ +3 dBm | row 1 |
| `pout`: the same | the other four | ≥ 0 dBm | row 1 |
| `ipa_a`: DC current from `VCCPA` under the drive | all | ≤ 25 mA | row 6 |
| `mu`: stability factor μ, 1 GHz to 300 GHz | all | ≥ 1 | row 2 |
| gate `limits` on `hb`: each HBT under the drive | all | the PDK pack on the cycle means and on the peak voltages, and `ic_per_emitter` ≤ 3 mA (cycle mean) | row 3 |

The gate `limits` runs the harmonic balance of `hb` again with the terminal voltages and currents of each HBT. It
checks the cycle-mean values (V<sub>CE</sub>, V<sub>BE</sub>, the collector current per emitter, a positive mean base
current) and the peak terminal voltages over one period (V<sub>CE</sub> ≤ 1.6 V at every instant). It does not check
the instantaneous base current: at 122 GHz the terminal current includes the charging current of the junctions.
