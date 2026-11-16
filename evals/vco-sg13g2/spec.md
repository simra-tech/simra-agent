# 61 GHz voltage-controlled oscillator core, IHP SG13G2

## Function

The oscillator is the core of the frequency generation of a 122 GHz radar. A push-push doubler after it gives the
122 GHz local oscillator, and a divider taps it for the frequency control loop. This task covers the core only: the
oscillator with its tank, its tuning and band bits and its bias, into the stated loads.

## Rows of the interface specification of the chip (the source of this task)

1. Tuning: the 122.0 GHz to 123.0 GHz band at the doubler output is inside the tuning range at every corner (here:
   core frequency ≤ 60.5 GHz at the lowest setting and ≥ 62.0 GHz at the highest setting, 0.5 GHz of margin on each
   side of 61.0 GHz to 61.5 GHz).
2. Phase noise at 122 GHz ≤ −80 dBc/Hz at 1 MHz offset (core: ≤ −86 dBc/Hz at 61 GHz). This task checks a part of it
   (row `pn_dev`; see "Phase noise").
3. HBT limits: V<sub>CE</sub> ≤ 1.6 V as the mean over the cycle and collector current ≤ 3 mA per emitter (`Nx`) for
   each device at every corner. The peak V<sub>CE</sub> over the cycle may be above 1.6 V in the oscillator core; this
   task bounds it at 2.5 V (an assumption of the task, not a PDK limit).
4. Amplitude: the doubler and the divider need a differential tank amplitude of at least 0.6 V (0.3 V per side).
5. Start-up: the oscillator starts at every corner after the supply ramp.
6. Bias from the bias block: tail reference 0.6 mA into `iref`, replica reference 0.5 mA into `irep`, varactor gate
   biases 0.8 V (`vbvar`) and 1.8 V (`vbvar2`), band bits 0 V or 3.3 V.

## Interface

The core is the subcircuit `vco` in `vco.spice`, with the pins
`outp outn vtune vcc18 iref irep vbvar vbvar2 b0 b1 b2`, in this order.

| Pin | Function |
| --- | --- |
| `outp`, `outn` | tank outputs (differential); `osc.spice` loads each with the divider tap and a doubler input model (14.6 fF in series with 18 Ω) |
| `vtune` | tuning voltage, 0.3 V to 2.8 V |
| `vcc18` | supply, 1.8 V, through 0.2 Ω and 20 pH in `osc.spice` |
| `iref` | tail reference current, 0.6 mA from VCC18 into this pin |
| `irep` | replica (base bias) reference current, 0.5 mA from VCC18 into this pin |
| `vbvar`, `vbvar2` | varactor gate bias voltages, 0.8 V and 1.8 V |
| `b0`, `b1`, `b2` | band bits, 0 V or 3.3 V |

Ground is node `0`.

## Devices

1. HBT: `npn13G2` (parameter `Nx`; `selft` 0 or 1 is allowed in this task: the thermal time constant is much longer
   than the transients).
   Write `sw_nqs=1` on every `npn13G2` instance: it turns on the excess phase of the HBT model, which the ngspice
   model has off by default. The netlist gate requires it; another value is a rule error.
2. MIM capacitor `cap_cmim`, varactor `sg13_hv_svaricap`, resistors `rppd`, `rsil`, `rhigh`.
3. EM passives: a structure that you draw (GDS, IHP SG13G2 layers), simulate with `em_sparameters` on the PDK stackup
   and fit with `fit_to_spice`. Copy the fitted subcircuit into `vco.spice` unchanged. The design must have at least
   one EM passive (normally the tank inductor). The fit-band gate checks the DC point of the transient: give `fit_to_spice`
   `uses.dc` true. A small |dS| over a wide band can still change the tank loss by more than 10 %. For this reason
   the netlist gate requires that at least one fitted model of the core comes from a fit with a Q check: give
   `fit_to_spice` the input `checks`, for example
   `[{"name": "tank_q", "kind": "q", "ports": [1, 2], "band_hz": [58e9, 64e9], "tol_rel": 0.05}]` (the Q between
   ports 1 and 2 of your structure; `short` lists ports at AC ground). The band must overlap 58 GHz to 64 GHz and
   the tolerance must be 0.05 or less. A fit that fails the check is refused; fit a narrower band (`fit_band_hz`).
4. Ideal R, L and C only as a model of wiring (each ideal C ≤ 50 fF, each ideal L ≤ 50 pH, each ideal R ≤ 50 Ω).
5. No ideal sources in the core, except inside an EM passive from `fit_to_spice`.

## Verification

`osc.spice` is the transient bench of the `oscillator` operation (ngspice). It ramps the supply and the bias in
300 ps and gives a 0.2 mA differential kick at 0.35 ns. The run is 9 ns with a 0.1 ps step; the frequency and the
amplitude are read after 8 ns. `requirements.json` gives the corners, the settings and
the requirements:

| Corner | HBT, MIM, resistor corner | MOS corner (varactor) | Temperature |
| --- | --- | --- | --- |
| `tt` | typ | tt | 27 °C |
| `slow_hot` | wcs | ss | 125 °C |
| `fast_cold` | bcs | ff | −40 °C |

| Requirement | Setting | Corners | Limit | Source |
| --- | --- | --- | --- | --- |
| `f_low`: core frequency | `vtune` 0.3 V, bits 000 | all | ≤ 60.5 GHz | row 1 |
| `f_high`: core frequency | `vtune` 2.8 V, bits 111 | all | ≥ 62.0 GHz | row 1 |
| `amp_v`: differential amplitude (half peak-to-peak) | `vtune` 1.55 V, bits 001 (b2 high) | all | ≥ 0.6 V | row 4 |
| `t_start`: first cycle at 90 % of the steady amplitude | as `amp_v` | all | ≤ 7.5 ns | row 5 |
| `pn_dev`: phase noise at 1 MHz referred to 122 GHz, core-pair device noise (see "Phase noise") | as `amp_v` | `tt` (scored); `slow_hot` (reported, not scored: see below) | ≤ −83 dBc/Hz | row 2 |
| gate `limits` on the middle setting | as `amp_v`, 8.5 ns to 9.0 ns | all | the PDK pack on the cycle means (over 8.5 ns to 9.0 ns), the peak voltages with V<sub>CE</sub> ≤ 2.5 V, and `ic_per_emitter` ≤ 3 mA | row 3 |

## Phase noise

The row `pn_dev` comes from the `oscillator` operation by the impulse sensitivity function (ISF): for each source and
each of 16 phases of the period, two transient runs inject a small charge (+q and −q) and read the shift of the zero
crossings 35 to 45 periods later. The phase noise is L(Δf) = 1/2 (f0/Δf)² mean(ISF² S) per source, summed, plus the
flicker term, +6 dB for the doubler. The sources are the shot noise of the collector and base conduction currents of the
core transistor `xq1` (from a DC table of the device at the transient junction voltages of the corner and temperature;
the check compares the mean table collector current with the mean terminal current, 10 %) and its base flicker noise,
times 2 for `xq2`. The flicker term is the larger of two values: the DC part of the ISF, and a quasi-static term. The
quasi-static term comes from two more runs with a DC current of ±1 µA between the base and the emitter of `xq1`: they
give K = df0/dI, and L = 1/2 K² S_flicker / Δf². It covers the slow path of the base current through the base bias
resistors, which the ISF window reads only in part. The phase-noise run reads the oscillator after 14 ns (the other runs:
after 8 ns): the ISF needs a settled amplitude. At slow 125 °C the amplitude still drifts at 8 ns, and the row then
reads 2 dB worse.

The reported row: with this method the reference core gives −85.38 dBc/Hz at `tt` and −78.32 dBc/Hz at `slow_hot`
(simulated). It does not meet −83 dBc/Hz at `slow_hot`, so the row is not scored there. The limit does not change.
The check still measures the row at `slow_hot` and lists it as REPORTED. Give its value in `answer.json`; the
scorer compares it with the verified run.

Naming rule: the two cross-coupled core transistors are the instances `xq1` and `xq2` (npn13G2) of the subcircuit `vco`,
with the pins in the PDK order (collector, base, emitter, substrate). The check injects at the pins of `xq1`.

Limits of the method:

1. It is not a direct noise simulation: it uses transient runs and a linear time-variant model of the phase. For the
   oscillator of the reference design, a transient-noise run gave −87.8 ± 0.2 dBc/Hz at 1 MHz against −88.6 dBc/Hz by
   ISF.
2. The row is a partial sum. The loss noise of the tank, the thermal noise of the HBT parasitic resistances and the
   noise of the bias are not in it. For the reference they add 2.7 dB at 1 MHz (−91.3 to −88.6 dBc/Hz). The limit
   −83 dBc/Hz is row 2 minus 3 dB for them. A design can pass `pn_dev` and miss row 2.
3. The symmetry factor 2 assumes that `xq2` is the mirror of `xq1`.

## Rows that the checks do not cover

1. The full phase noise of row 2 (see "Phase noise", limit 2).
2. Continuous coverage: the task checks the two ends of the range, not the overlap of the bands between them.
3. Supply variation and the doubler load: the bench uses 1.8 V and a simple model of the doubler input.
