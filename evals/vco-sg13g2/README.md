# Pilot task: a 61 GHz VCO core with an EM tank, from its specification rows

**This is a pilot task: one block, one public reference design, one run per arm. It is not a decision benchmark.**
It checks that an agent in the harness can design an oscillator with an EM tank against rows that the kernel checks by
transient runs at three corners: tuning range, amplitude, start-up, a part of the phase noise (ISF), and the
operating-limit gate in the steady state.

The block is the core of the VCO of a public 122 GHz radar design in IHP SG13G2 (revision A core: a single-turn
TopMetal2 tank, a varactor bank with three coarse bits and two fine sections, a cross-coupled npn13G2 Nx 2 pair, an HBT
tail). The agent gets the rows of the interface specification that apply to the core, the pins, the PDK devices, the
bench and the requirements. It gets no netlist and no result of the reference design.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `spec.md` | the specification rows, the pins, the devices, the corners, the requirements and the phase-noise method |
| `osc.spice` | transient bench of the `oscillator` operation: supply and bias ramp, differential kick, divider and doubler loads |
| `requirements.json` | three corners, five requirements (14 rows), the operating-limit gate, the netlist gate (the fit-band gate adds its rows) |
| `score.mjs` | scorer (`evals/rf-score.mjs`) |
| `reference.mjs` | reference run (`evals/rf-reference.mjs`): the reference core through the same bench and gates, writes `expected.json` |
| `expected.json` | reference value of each row, with provenance |
| `expected_nqs0.json` | the step 8 reference values, with `sw_nqs=0` and the phase-noise run after 8 ns (comparison only, not used by the scorer) |

## Deviations from the reference design

1. The tank is a `fit_to_spice` output of the 5-port EM data of the design, fitted from 0 Hz to 130 GHz (order 6,
   max |dS| 0.0058). The design uses an EM-calibrated lumped model. A fit to 260 GHz (order 12, max |dS| 0.0114) gives a
   differential Q of 13.7 at 61 GHz against 15.8 in the data; the 130 GHz fit gives 15.45.
2. The resistors above 50 Ω are PDK `rppd` and `rhigh` devices sized at tt, 27 °C (the design has ideal resistors); the
   1 pF filter capacitor is a MIM; the bias sources are pins; the current monitors are removed. `selft=0` on the HBTs, as
   in the design.
3. Loads: the divider tap of the design, and the doubler as its small-signal input at 61 GHz (14.6 fF in series with
   18 Ω, from an ngspice AC run of the doubler input of the design: 18.2 − j179 Ω). The large-signal input of the doubler
   is not modelled.
4. Corners: three (tt; HBT, MIM and resistor wcs with MOS ss at 125 °C; bcs with ff at −40 °C), 1.8 V supply.

## Bench lessons

Three faults of the first bench, each of which made the reference "not oscillate" with no simulator error:

1. A doubler model of 40 fF in series with 50 Ω loads each side with about 134 Ω at 61 GHz; the tank alone is about
   690 Ω differential.
2. The core starts only when its base bias has settled (a 2 kΩ / 1 pF filter): about 5 ns. A run of 2.5 ns ends before
   the start. A kick into one output is mostly common mode, and a kick before the bias settles decays.
3. The 260 GHz tank fit (see deviation 1).

## Phase noise

See `spec.md`, section "Phase noise": ISF of the oscillator operation, 16 phases, the collector and base shot noise and
the base flicker noise of `xq1`, times 2; the flicker term is the larger of the ISF term and the quasi-static term
(since step 10, see "Phase-noise method check"). The row is a partial sum: for the oscillator of the reference design the
other sources (tank loss, HBT parasitic resistances) add 2.7 dB at 1 MHz. The ISF method against a transient-noise
run on that oscillator: −88.6 dBc/Hz against −87.8 ± 0.2 dBc/Hz at 1 MHz.

## Reference

Every scored row passes. The reported row `pn_dev` at slow 125 °C does not meet its limit (see "Phase-noise method
check"). The table has the step 8 values (simulated, ngspice 46, `sw_nqs=0`); the values of record are in the sections
"Excess phase of the HBT model" (step 9) and "Phase-noise method check" (step 10, `pn_dev`) and in `expected.json`:

| Row | tt | slow, 125 °C | fast, −40 °C |
| --- | --- | --- | --- |
| `f_low` (≤ 60.5 GHz) | 58.28 GHz | 57.01 GHz | 59.09 GHz |
| `f_high` (≥ 62.0 GHz) | 64.99 GHz | 62.46 GHz | 66.68 GHz |
| `amp_v` (≥ 0.6 V) | 0.906 V | 0.788 V | 0.808 V |
| `t_start` (≤ 7.5 ns) | 5.12 ns | 7.11 ns | 4.06 ns |
| `pn_dev` (≤ −83 dBc/Hz) | -87.96 dBc/Hz | -83.97 dBc/Hz | not a row |
| cycle-mean V<sub>CE</sub>, largest (≤ 1.6 V) | 1.225 V | 1.324 V | 1.225 V |
| peak V<sub>CE</sub> (≤ 2.5 V, assumption) | 2.442 V | 2.380 V | 2.320 V |
| collector current per emitter (≤ 3 mA) | 1.28 mA | 1.17 mA | 1.21 mA |
| gate netlist | 0 errors | | |

Margins are small at slow 125 °C: start-up 0.39 ns, `pn_dev` 0.97 dB. The peak V<sub>CE</sub> limit of 2.5 V is a task
value; the reference passes it by 0.06 V. The fit-band gate gives no row here: a transient has no band, and the DC
point of the fitted tank is checked by `uses.dc`. The design record of the reference reports band margin 1.95 GHz
and −83.3 dBc/Hz (full ISF, all sources) at slow 125 °C; the values of this task differ by the bench (loads, kick,
fitted tank) and by the partial source list.

## Excess phase of the HBT model (sw_nqs)

The ngspice HBT subcircuit of the PDK has `sw_nqs=0` by default, so the excess phase is off. The Xyce card always has
it on (registry entry `ngspice-sg13g2-hbt-sw-nqs`). Since step 9 the task uses the model of record of the reference
design: the netlist gate requires `sw_nqs=1` on every `npn13G2` instance, and the reference has it.

With `sw_nqs=1` the reference of step 8 read −82.70 dBc/Hz for `pn_dev` at slow 125 °C (limit −83). The cause was
the bench, not the core: at that corner the start-up takes 7.0 ns, and the phase-noise run read the oscillator after
8 ns, when the amplitude still drifts (period spread 6.5e-4 against 5.6e-5 at tt). One change:

| Change | Before | After |
| --- | --- | --- |
| settle time of the phase-noise experiment `osc_pn` (`settle_s`, `ref_stop_s`) | 8 ns, 9 ns | 14 ns, 15 ns |

The core is not changed. Limit of the method that this shows: with the same core, `pn_dev` at tt reads −89.89 dBc/Hz
after 8 ns and −88.39 dBc/Hz after 14 ns, so a row margin below about 1.5 dB is not a safe margin.

| Row | step 8 (`sw_nqs=0`, `expected_nqs0.json`) | step 9 (`sw_nqs=1`) |
| --- | --- | --- |
| `f_low`, tt / slow 125 °C / fast −40 °C (≤ 60.5 GHz) | 58.28 / 57.01 / 59.09 GHz | 58.12 / 56.79 / 58.96 GHz |
| `f_high`, same order (≥ 62.0 GHz) | 64.99 / 62.46 / 66.68 GHz | 64.84 / 62.24 / 66.54 GHz |
| `amp_v`, same order (≥ 0.6 V) | 0.906 / 0.788 / 0.808 V | 0.935 / 0.810 / 0.826 V |
| `t_start`, same order (≤ 7.5 ns) | 5.12 / 7.11 / 4.06 ns | 5.11 / 7.04 / 4.07 ns |
| `pn_dev`, tt / slow 125 °C (≤ −83 dBc/Hz) | −87.96 / −83.97 dBc/Hz (after 8 ns) | −88.39 / −84.83 dBc/Hz (after 14 ns) |
| peak V<sub>CE</sub>, largest (≤ 2.5 V) | 2.442 V | 2.468 V |

The smallest margins of the reference: `f_high` at slow 125 °C 0.24 GHz, start-up at slow 125 °C 0.46 ns, peak
V<sub>CE</sub> 0.03 V.

## Phase-noise method check (step 10)

The phase-noise tool of the reference design had three faults (design record of 2026-11-16): (a) an injected source
term 20 dB low from a wrong unit, (b) noise sources at typical 27 °C conditions at every corner, (c) no term for the base
flicker current through the base bias resistors. This task, before step 10:

| Fault | In this task | Change |
| --- | --- | --- |
| (a) unit of an injected source | not present: a current source uses the charge step, a series source the flux step | each source record names its bound (2qI, 4kT/R, 4kTR); a test checks the terms against them |
| (b) sources at 27 °C | not present for the conduction table (the table deck has the corner libraries and the temperature) | a thermal source uses the run temperature; the check compares the mean table collector current with the terminal current (10 %) |
| (c) base flicker through the bias resistors | present: the core has base bias resistors from `vbc` and a filter resistor to the replica | quasi-static term (±1 µA between base and emitter of `xq1`); the flicker term is the larger of the ISF and quasi-static terms |

New values (simulated, ngspice 46, `sw_nqs=1`, at 1 MHz referred to 122 GHz):

| Term | tt | slow, 125 °C |
| --- | --- | --- |
| collector shot (×2) | −88.37 dBc/Hz | −85.63 dBc/Hz |
| base shot (×2) | −109.20 dBc/Hz | −99.44 dBc/Hz |
| base flicker, ISF | −130.16 dBc/Hz | −94.27 dBc/Hz |
| base flicker, quasi-static (used) | −88.44 dBc/Hz (K = +9.91 MHz/µA at 61 GHz) | −79.26 dBc/Hz (K = −10.46 MHz/µA) |
| `pn_dev` (before: step 9) | −85.38 dBc/Hz (−88.39) | −78.32 dBc/Hz (−84.83) |

**The reference core does not meet −83 dBc/Hz at slow 125 °C (−78.32 dBc/Hz).** For that reason the row `pn_dev` is
scored at `tt` only. At `slow_hot` it is a reported row: the check measures it, the agent gives its value, and the
scorer compares the value with the verified run (one value point, no requirement point; it does not change
`meets_spec`). The limit −83 dBc/Hz is not changed. The design record of the reference fails its own row at that
corner too. The row returns to scoring at `slow_hot` when a reference core passes it. `expected.json` has the value
under `reported` and the reason under `reported_notes`.

The start check of the `oscillator` operation (step 10) stops and resumes the reference run at settle/2 and
3 settle/4. This changes the other rows a little (simulated, against step 9): `t_start` at slow 125 °C 7.04 → 7.16 ns
(margin 0.34 ns), at tt 5.11 → 5.09 ns; the frequencies by 0.008 % or less; `amp_v` by 0.3 % or less.

## Tank fit

The fit of the tank carries a Q check (`fit_to_spice` input `checks`): the differential Q between the device ends
with the supply lead at AC ground, 58 GHz to 64 GHz, tolerance 5 %. The netlist gate requires such a check on at
least one fitted model of the core (`fit_checks`). The 130 GHz fit of the reference passes; the 260 GHz fit of
deviation 1 is refused by this check (test `TankFitAcceptance`, with the reference files).

## Rows that the checks do not cover

1. The full phase noise of row 2 (tank loss, parasitic resistances, bias noise): the task has no design-agnostic way to
   name these sources. A source list made from the design (each resistor, the port noise of each fitted network) is
   the missing tool.
2. Continuous coverage of the band between the two end settings.
3. Supply variation, the large-signal doubler load, and the doubler output (`LO122` power and the 61 GHz content).

## Scoring

As `lna-sg13g2` (`evals/rf-score.mjs`): design (2), em_passive (2), requirements (each verified row and gate row),
claim (4), values (frequency ±0.2 %, amplitude ±3 %, start-up ±10 %, phase noise ±0.5 dB).

## Pilot runs, step 8 (one run per model, 2026-11-16)

Image of commit `098eb5b`, 4 CPUs shared with other pilots, 180 min limit. **One run per model is not a rate.**

| Model | Score (design, EM, requirements, claim, values) | Missed rows | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- |
| default (`deepseek/deepseek-flash`) | 2, 2, 1/51, 0, 0/14 | all but the netlist gate: not run | 7635 s | 248 | 30.2 M |
| stronger (`openai/gpt-6.1-sol`) | 2, 2, 48/48, 4, 14/14 | none | 3239 s | 88 | 5.4 M |

1. Default model, cause class early end: the agent drew, simulated and fitted a tank, then tuned the core with its
   own transient script. At 127 min of 180 it wrote a summary of its work as a reply with no tool call, and the
   session ended. It wrote no `answer.json`, it ran `check_requirements` once, and the last `vco.spice` was not the
   tuned design: the transient of the scorer aborts on it (time step too small at 14 ps), so 17 rows are "not run".
   The last values of its own script were inside the frequency and amplitude rows at the three corners; no check
   confirms them.
2. Stronger model: every row passes, with 24 `check_requirements` calls. `pn_dev` −86.72 dBc/Hz at tt and
   −84.08 dBc/Hz at slow 125 °C; start-up 3.16 ns, 3.46 ns, 2.69 ns; peak V<sub>CE</sub> at most 2.10 V.

## Pilot runs, step 9 (reference with `sw_nqs=1`, tank Q check, end guard, 2026-11-16)

Image of commit `7e5a262`, 4 CPUs, 180 min limit. **One run per model and condition is not a rate.**

| Model | CPU load | Score (design, EM, requirements, claim, values) | Missed rows | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- | --- |
| default (`deepseek/deepseek-flash`) | shared with one pilot and a test run | 2, 2, 42/48, 4, 14/14 | `f_low` tt and fast −40 °C, `f_high` and `amp_v` slow 125 °C, `pn_dev` both corners | 10803 s (limit) | 393 | 83.5 M |
| stronger (`openai/gpt-6.1-sol`) | shared with one pilot and a test run | 2, 2, 46/48, 4, 0/14 | `f_low` fast −40 °C, `f_high` slow 125 °C | 10802 s (limit) | 68 | 3.7 M |
| stronger (`openai/gpt-6.1-sol`) | shared with one pilot | 2, 2, 48/48, 4, 14/14 | none | 2374 s | 58 | 2.7 M |
| default (`deepseek/deepseek-flash`) | alone | 2, 2, 43/48, 4, 1/14 | `f_low` fast −40 °C, `f_high` tt and slow 125 °C, `amp_v` and `pn_dev` slow 125 °C | 10803 s (limit) | 337 | 54.9 M |

1. The first two runs shared the 4 CPUs with each other and with a container test run of the harness. Their
   simulations were slow: in the run of the stronger model, 14 oscillator runs that did not start took 15214 s in
   total, and one check took more than 75 min. So the time limit of these two runs is not a fair measure. The run
   of the stronger model was repeated with one other pilot on the CPUs and passed every row in 2374 s. The run of
   the default model was repeated alone on the CPUs (item 7); it also reached the time limit, so the load is not
   the cause of its failure.
2. Default model: it wrote `answer.json` this time (step 8: no answer file), with `meets_spec` false and the 14
   values within tolerance, so the claim is right. The design misses 6 rows: the tuning range is too narrow
   (60.91 GHz to 62.43 GHz at tt; 57.81 GHz at the top at slow 125 °C), the amplitude at slow 125 °C is 0.375 V,
   and `pn_dev` is −76.7 dBc/Hz and −75.4 dBc/Hz. It ran 5 checks and 257 oscillator experiments of its own.
3. End guard, default model: the agent changed `vco.spice` 5 s after it wrote `answer.json` and ended the session.
   The guard sent one re-entry ("`vco.spice` changed after the last check"), with 8 min left. The agent started a
   check; the time limit stopped it. The score did not change by the re-entry: the values of `answer.json` agree
   with the scorer run of the final file. The step 8 failure (an end with no answer file) did not occur in this
   run, so the run does not show that the guard repairs it.
4. Tank Q check: in each run of the stronger model, `fit_to_spice` refused one fit on the Q check (model Q 108.9
   against 121.6 in the data in the first run; 110.7 against 144.6 in the second). The agent then made a fit that
   passes. No refusal on the Q check in the run of the default model (one accepted fit).
5. Stronger model, loaded run: it wrote an `answer.json` with empty values 36 min before the limit, then changed
   the design; the time limit stopped its last check. The scorer finds 46 of 48 rows in the final file.
6. Stronger model, second run: 8 `check_requirements` calls. `pn_dev` −91.38 dBc/Hz at tt and −88.19 dBc/Hz at
   slow 125 °C; tuning 57.63 GHz to 65.83 GHz at tt; start-up 1.46 ns, 1.72 ns, 1.28 ns.
7. Default model, second run (alone on the CPUs): the claim is right (`meets_spec` false). The final design misses
   5 rows: the tuning range at tt is 58.87 GHz to 59.58 GHz (the row needs 62.0 GHz at the top), the amplitude at
   slow 125 °C is 0.554 V, and `pn_dev` at slow 125 °C is −82.88 dBc/Hz (limit −83). It ran 4 checks and 49
   oscillator experiments of its own.
8. End guard, second run of the default model: the agent wrote `answer.json` and ended with 22 min left. The guard
   sent one re-entry, because the last check had one run that did not complete. The agent then changed the design,
   ran one check (20 min), changed the design again, and the time limit stopped the session. It did not write
   `answer.json` again, so 13 of the 14 values are those of an older design. The re-entry message names the missing
   items; it does not say to keep the answer file equal to the final design. In this run the re-entry did not
   help, and it can be the cause of the lost value points (not proven: the state without the re-entry is not known).
   After this run the message got one more rule: no new design work in the re-entry turn, and a changed design file
   needs a new answer file. This text is not in the image of the pilots and is not tested in a pilot.

## Pilot runs, step 10 (quasi-static flicker term, `pn_dev` reported at slow 125 °C, start check, answer-consistency end guard, 2026-11-17)

One run per model, one pilot at a time on the 4 CPUs (image of commit 98dc11d). One run is not a rate.

| Model | Score (design, EM, requirements, claim, values) | Missed rows | End state | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- | --- |
| default (`deepseek/deepseek-flash`) | 2, 2, 44/47, 4, 14/14 | `f_low` fast −40 °C (62.63 GHz), `f_high` slow 125 °C (60.21 GHz), `pn_dev` tt (−69.86 dBc/Hz) | consistent | 10750 s | 404 | 83.2 M |
| stronger (`openai/gpt-6.1-sol`) | 2, 2, 47/47, 4, 14/14 | none | consistent | 1826 s | 67 | 3.6 M |

1. The values part has 14 points: 13 scored rows and the reported row `pn_dev` at slow 125 °C. Both runs gave the
   reported value within 0.5 dB of the verified run (default −82.12 dBc/Hz, stronger −85.88 dBc/Hz).
2. The design of the stronger model meets −83 dBc/Hz also at slow 125 °C (−85.88 dBc/Hz, reported row), where the
   reference core does not (−78.32 dBc/Hz). `pn_dev` at tt −88.23 dBc/Hz; start-up 0.62 ns to 0.84 ns.
3. Start check: in the default run, 21 of 164 oscillator experiments stopped early because the oscillator did not
   start (median 0.3 s each, 12 s in total; the completed runs had a median of 10.7 s). The stronger run had none.
4. End guard: both sessions settled with no item; the answer of each run belongs to the final design and its last
   check (end state consistent). Neither run had a re-entry.
