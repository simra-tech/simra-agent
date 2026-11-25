# Pilot task: a 122.5 GHz PA output stage with Xyce harmonic balance

**This is a pilot task: one block, one public reference design, one run per arm. It is not a decision benchmark.**
It checks that an agent in the harness can design a large-signal RF stage against rows that the kernel checks by
harmonic balance at five corners, with the stability gate and the operating-limit gate under the drive.

The block is the output stage of the transmit amplifier of a public 122 GHz radar design in IHP SG13G2 (revision B2a:
a common-emitter npn13G2 Nx 8 on a trimmed rail, EM interstage and output networks). The agent gets the rows of the
interface specification that apply to the stage, the pins, the PDK devices, two benches and the requirements. It gets
no netlist and no result of the reference design.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `spec.md` | the specification rows, the pins, the devices, the corners and the requirements |
| `hb.spice` | Xyce harmonic-balance bench: 50 Ω source with +3 dBm available power at 122.5 GHz, 50 Ω load, `VCCPA` current |
| `sp.spice` | ngspice S-parameter bench: `pa_stage.s2p`, 1 GHz to 300 GHz, for μ |
| `requirements.json` | five corners, four requirements (15 rows), the stability gate, the operating-limit gate on `hb`, the netlist gate, the device-check gate (the fit-band gate adds its rows) |
| `score.mjs` | scorer (`evals/rf-score.mjs`): device rules, the EM passive in the records, the check of `requirements.json` through the kernel |
| `reference.mjs` | reference run (`evals/rf-reference.mjs`): the reference stage through the same benches and gates, writes `expected.json` |
| `expected.json` | reference value of each row, with provenance |
| `expected_nqs0.json` | the step 8 reference values, with `sw_nqs=0` and without the device-check gate (comparison only) |

## Deviations from the reference design

1. Source and load are 50 Ω. In the reference, the driver feeds the stage and the antenna is the load. The stage is
   matched for its driver, so its small-signal gain into 50 Ω is only 2.8 dB at tt; the drive (+3 dBm) is set so that
   the reference meets the tt row with about 0.9 dB of margin (assumption `drive`).
2. `VCCPA` is 0.90 V at tt and at the slow corners and 0.80 V at the fast corners (assumption `rail_trim`). In the
   reference, a detector loop trims the rail per die. With 0.90 V at the fast corners the reference fails the peak
   V<sub>CE</sub> row: 1.654 V at fast, −40 °C (limit 1.6 V; the design record reports the same failure, 1.75 V with the
   driver and +5 % supply).
3. The reference netlist passes the netlist gate without a wrapper file: the fitted networks are `fit_to_spice` outputs
   of the EM data with an added 0 Hz point (a resistive star, 0.25 Ω arms: an assumption, the data has no DC point), and
   the 100 Ω base resistor is ideal (allowed: ≤ 100 Ω).

## Temperature in Xyce

With the global temperature (`.options device temp=`) the Xyce harmonic balance of the reference fails at −40 °C and
125 °C, also with the typical models (the DC point fails; with no start-up periods the HB Newton fails). The hb
experiment therefore uses `temperature_method: "dtemp_tf"` of the xyce adapter: a global 27 °C, `dtemp` = T − 27 on
each HBT, and the transit time of the HBT corner section scaled to T (registry entry `xyce-sg13g2-hbt-dtemp`). The MIM
capacitors stay at 27 °C in the harmonic balance. The S-parameter bench (ngspice) uses the global temperature.

## Excess phase of the HBT model (sw_nqs)

The two simulators do not use the same default of the HBT model. The ngspice HBT subcircuit of the PDK has
`sw_nqs=0` by default, so the excess phase is off. The Xyce card always has it on (registry entry
`ngspice-sg13g2-hbt-sw-nqs`). Since step 9:

1. The netlist gate requires `sw_nqs=1` on every `npn13G2` instance. The S-parameter bench (ngspice) then has the
   excess phase, as the harmonic balance (Xyce) has. Xyce accepts the parameter on the instance.
2. The gate `device_check` runs one `npn13G2` Nx 8 in both simulators at each corner (V<sub>BE</sub> 0.88 V,
   V<sub>CE</sub> 0.9 V, 122.5 GHz and 245 GHz). It fails when a DC current or a y-parameter differs by more than
   2 % at 27 °C. The reference: 0 findings at every corner (largest y difference at 27 °C: 1.4 % typical, 1.0 %
   slow, 1.8 % fast).
3. At −40 °C and 125 °C the gate also compares the corner temperature. A difference there is a temperature
   finding in the reason of the row, not a failure, because the 27 °C values agree (registry entry
   `xyce-sg13g2-hbt-temperature`). The reference rows (simulated, equal base voltage, Xyce against ngspice):

   | Corner | DC current | y21 at 122.5 GHz | y21 at 245 GHz | Temperature findings |
   | --- | --- | --- | --- | --- |
   | slow, 125 °C | 1.6 % | 9.1 % (110.8 mS at −64.3° against 116.3 mS at −60.0°) | 10.7 % | 8 |
   | fast, 125 °C | 2.1 % | 10.5 % (187.0 mS at −58.0° against 197.0 mS at −52.9°) | 13.6 % | 9 |
   | slow, −40 °C | 0.5 % | 4.3 % (57.79 mS at −49.2° against 57.28 mS at −51.6°) | 5.7 % | 4 |
   | fast, −40 °C | 0.8 % | 3.3 % (94.49 mS at −34.6° against 94.36 mS at −36.5°) | 5.4 % | 4 |

   So the hot and cold rows of this task carry a model uncertainty between the stability rows (ngspice) and the
   power rows (Xyce). Which simulator is closer to silicon is not known. The check uses the global temperature in
   both simulators; the `hb` experiment uses the `dtemp_tf` method (see "Temperature in Xyce"), which this check
   does not compare.
4. The reference values did not change by more than 1e-9 (`expected_nqs0.json` has the step 8 values): the smallest
   μ is at 1 GHz, the lower edge of the band, where the excess phase has no effect; at 122 GHz μ goes from 1.639 to
   1.687 (tt). A different design can have its μ minimum at a high frequency.

## Reference

Every row passes (simulated, Xyce 7.10 and ngspice 46, step 9):

| Row | tt | Worst corner |
| --- | --- | --- |
| output power at +3 dBm drive | 3.93 dBm | 2.07 dBm (slow, 125 °C) |
| `VCCPA` current | 14.6 mA | 13.9 mA (slow, 125 °C) to 14.6 mA (slow, −40 °C) |
| μ minimum, 1 GHz to 300 GHz | 1.0055 | 1.0045 (fast) |
| peak V<sub>CE</sub> over one period | 1.527 V | 1.383 V (slow, 125 °C) to 1.527 V (tt); fast, −40 °C: 1.503 V at 0.80 V |
| collector current per emitter (cycle mean) | 2.13 mA | 2.15 mA (fast, −40 °C) |
| gate netlist, gate fit_band (two networks) | 0 errors | |

The μ margin of the reference is small (0.0045). A design with the same topology and slightly different networks can
fail the stability gate.

## Rows that the checks do not cover

1. The instantaneous base current. At 122 GHz the terminal base current from the harmonic balance includes the charging
   current of the junctions, so its sign over the period says nothing about reverse conduction. The gate checks the
   cycle-mean base current only (registry entry `xyce-sg13g2-hb-terminal-currents`). A reliability check needs the
   conduction current, which Xyce does not print.
2. The driver and the interstage: the task has the output stage alone with a 50 Ω source.
3. Harmonics: 3 harmonics of 122.5 GHz. The design record used 3 to 5; the error of 3 against more harmonics is not
   run for this stage.
4. PDK poly resistors: Xyce does not simulate their model card (registry `xyce-sg13g2-r3cmc`), so the device list has
   no resistors and the reference uses an ideal 100 Ω resistor.

## Scoring

As `lna-sg13g2` (`evals/rf-score.mjs`): design (2), em_passive (2), requirements (each verified row and gate row),
claim (4), values (each reported value within tolerance: power ±0.2 dB, current and μ ±2 %).

## Pilot runs, step 8 (one run per model, 2026-11-16)

Image of commit `098eb5b`, 4 CPUs shared with other pilots, 180 min limit. **One run per model is not a rate.**

| Model | Score (design, EM, requirements, claim, values) | Missed rows | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- |
| default (`deepseek/deepseek-flash`) | 2, 2, 78/78, 4, 15/15 | none | 3231 s | 183 | 22.9 M |
| stronger (`openai/gpt-6.1-sol`) | 2, 2, 77/77, 4, 15/15 | none | 156 s | 27 | 1.0 M |

1. The scores are without the two `gate fit_band` rows of the reference networks, which the scorer counted by error
   (see `lna-sg13g2`, step 8, item 3); they are computed from the stored verified rows, with no new simulation.
2. The stronger model used one EM line, one fit and three full checks; it raised a base resistor from 5 Ω to 20 Ω
   for stability. Its smallest μ is 1.0018 (the reference: 1.0045). The default model: 1.0877.

## Pilot run, step 10 (answer-consistency end guard, 2026-11-17)

One run, default model (`deepseek/deepseek-flash`), alone on the 4 CPUs (image of commit 98dc11d). One run is not a
rate.

| Score (design, EM, requirements, claim, values) | Missed rows | End state | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- |
| 2, 2, 82/82, 4, 15/15 | none | consistent | 7545 s | 299 | 49.4 M |

Smallest μ of the design: 1.1259 (fast 125 °C). The session settled with no end-guard item.
