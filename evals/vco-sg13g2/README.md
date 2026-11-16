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
| `expected_nqs1.json` | the same reference with `sw_nqs=1` on every HBT (comparison only, not used by the scorer) |

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
the base flicker noise of `xq1`, times 2. The row is a partial sum: for the oscillator of the reference design the
other sources (tank loss, HBT parasitic resistances) add 2.7 dB at 1 MHz. The ISF method against a transient-noise
run on that oscillator: −88.6 dBc/Hz against −87.8 ± 0.2 dBc/Hz at 1 MHz.

## Reference

Every row passes (simulated, ngspice 46, step 8):

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
it on (registry entry `ngspice-sg13g2-hbt-sw-nqs`). The reference values of this task use the default. This is a
recorded assumption. The reference was run again with `sw_nqs=1` on every `npn13G2` instance (`expected_nqs1.json`,
comparison only; simulated, ngspice 46):

| Row | `sw_nqs=0` (of record) | `sw_nqs=1` |
| --- | --- | --- |
| `f_low`, tt / slow 125 °C / fast −40 °C | 58.28 / 57.01 / 59.09 GHz | 58.12 / 56.79 / 58.96 GHz |
| `f_high`, same order | 64.99 / 62.46 / 66.68 GHz | 64.84 / 62.24 / 66.54 GHz |
| `amp_v`, same order | 0.906 / 0.788 / 0.808 V | 0.935 / 0.810 / 0.826 V |
| `t_start`, same order | 5.12 / 7.11 / 4.06 ns | 5.11 / 7.04 / 4.07 ns |
| `pn_dev`, tt / slow 125 °C (≤ −83 dBc/Hz) | −87.96 / −83.97 dBc/Hz | −89.89 / −82.70 dBc/Hz, slow **fails** |
| peak V<sub>CE</sub>, largest (≤ 2.5 V) | 2.442 V | 2.468 V |

With the excess phase on, the `pn_dev` row at slow 125 °C fails by 0.30 dB, and the peak V<sub>CE</sub> margin falls
to 0.03 V. The task stays at the default until a reference passes with `sw_nqs=1`; that work is not done. The netlist
gate can require the setting (`require_params`) and allows it as a declared value only; other physics switches stay
errors.

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
