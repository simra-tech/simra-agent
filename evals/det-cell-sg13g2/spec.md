# Power detector cell at 122.5 GHz, IHP SG13G2

## Function

The cell reads the RF power on a 50 Ω on-chip line (the transmitter output of a 122 GHz radar) and gives a
differential DC voltage. A replica path (the same circuit without the RF) gives the reference output, so that the
difference `outd - outr` is near zero without RF and rises with the RF power. An external meter reads the difference
through an analog mux and two pads.

## Rows of the interface specification of the chip (the source of this task)

1. Transmitter output detector: 0.3 dB of loss is reserved in the output line for the detector.
2. Current budget of the detector block: 0.3 mA from VCC18 for two detector cells.
3. Bias for the detector: 25 µA PTAT reference current from the bias block, for each cell.
4. Detector pads: differential DC; the external meter has ≥ 1 MΩ input and about 50 µV resolution.
5. HBT limits: V<sub>CE</sub> ≤ 1.6 V for each device at every corner (DC value).
6. The detector must work from 122 GHz to 123 GHz.

## Interface

The cell is the subcircuit `det_cell` in `det_cell.spice`, with the pins `lin vcc18 outd outr iref`, in this order.

| Pin | Function |
| --- | --- |
| `lin` | the RF line (the cell taps it; the line continues to a 50 Ω load) |
| `vcc18` | supply, 1.8 V ± 5 % |
| `outd` | detector output |
| `outr` | replica output |
| `iref` | bias reference: the bias block drives a current into this pin from VCC18 (25 µA PTAT) |

Ground is node `0`.

## Devices

1. HBT: `npn13G2` (subcircuit of the PDK HBT library; parameter `Nx` for the number of emitters).
2. MIM capacitor: `cap_cmim` (parameters `w`, `l`).
3. Resistors: `rppd`, `rsil`, `rhigh` (parameters `w`, `l`).
4. Ideal R, L and C only as a model of wiring (each ideal C ≤ 50 fF, each ideal L ≤ 50 pH, each ideal R ≤ 50 Ω),
   and K couplings between the ideal L.
5. No ideal sources in the cell.
6. On the PDK devices, only the instance parameters above (and `Ny`, `m`; `b` on the resistors). A parameter that
   changes the device physics (for example `selft`, `dtemp`, `mm_ok`) is a rule error. The netlist gate of
   `check_requirements` gives the rule errors.

## Verification

`verify.spice` is the bench. `requirements.json` gives the corners, the bench and the requirements. Each requirement
applies at each corner:

| Corner | HBT, MIM and rppd corner | VCC18 | Temperature | iref |
| --- | --- | --- | --- | --- |
| `tt` | typ | 1.80 V | 27 °C | 25.0 µA |
| `slow_hot` | wcs | 1.71 V | 125 °C | 33.2 µA |
| `slow_cold` | wcs | 1.71 V | −40 °C | 19.4 µA |
| `fast_hot` | bcs | 1.89 V | 125 °C | 33.2 µA |
| `fast_cold` | bcs | 1.89 V | −40 °C | 19.4 µA |

| Requirement | Limit | Source |
| --- | --- | --- |
| `idd_a`: current from VCC18, one cell, the iref current included | ≤ 150 µA | row 2 (assumption `two_cells`) |
| `loss_db`: loss that the cell adds to the line at 122.5 GHz | ≤ 0.3 dB | row 1 |
| `vout_m10_v`: output at −10 dBm line power, minus the output without RF | ≥ 0.5 mV | row 4 (assumption `meter_resolution`) |
| `ratio_0_m10`: output at 0 dBm over the output at −10 dBm | ≥ 3 | assumption `rising_response` |
| `noise_rms_v`: output noise, rms in 1 Hz to 10 kHz | ≤ 10 µV | assumption `noise_vs_meter` |
| `offset_v`: output without RF, magnitude | ≤ 20 mV | assumption `zero_range` |

The bench reads each power level 25 ns to 30 ns after the power step (assumption `settling_25ns`). It does not check
row 5 (V<sub>CE</sub>) and row 6 (the band edges); keep them in the design and report them.
