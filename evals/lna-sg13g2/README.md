# Pilot task: a 122.5 GHz LNA with an EM passive, from its specification rows

**This is a pilot task: one block, one public reference design, one run per arm. It is not a decision benchmark.**
It checks that an agent in the harness can design an active RF stage with an EM passive, against rows that the
kernel checks at five corners, with the stability gate and the operating-limit gate.

The block is the LNA of a public 122 GHz radar design in IHP SG13G2 (phase 1: three common-emitter stages, Nx 4, EM
matching networks fitted to SPICE). The agent gets the rows of the interface specification that apply to the LNA,
the pins, the PDK devices, line models, two benches and the requirements. It gets no netlist and no result of the
reference design.

Why an LNA and not the output network of the doubler: the rows that the first pilot could not see (noise figure,
current, the operating limits of the devices, stability at every corner) apply only to an active stage. A passive
network has S-parameters only.

| File | Contents |
| --- | --- |
| `task.md` | the prompt |
| `spec.md` | the specification rows, the pins, the devices, the corners and the requirements |
| `sp.spice` | S-parameter bench: two 50 Ω ports, the DC point (`idd_a`) and `lna.s2p`, 1 GHz to 300 GHz |
| `noise.spice` | noise bench: noise figure with a noiseless 50 Ω source and load at 122, 122.5 and 123 GHz, gain at 122.5 GHz |
| `lines.spice` | TopMetal2 line models (6, 13 and 23 µm) from the line table of the reference design (openEMS) |
| `requirements.json` | five corners, five requirements (13 rows), the stability gate, the operating-limit gate and the netlist gate (the fit-band gate adds its rows) |
| `score.mjs` | scorer: device rules, the EM passive in the records, then the check of `requirements.json` through the kernel |
| `reference.mjs` | reference run: the reference design through the same benches and gates, writes `expected.json` |
| `expected.json` | reference value of each row, with provenance |

## Deviations from the reference design

1. Both ports are 50 Ω (assumption `ports_50ohm`). The reference matches its input to a fitted antenna model.
2. The gain row is the 13 dB to 15 dB row of revision 0.1 of the interface rows, at tt only. The later rows of the
   chip (a gain setting per corner) need the steering circuit of the later revisions.
3. The reference value of the noise figure (4.99 dB) leaves out the loss noise of the EM passives: the reference
   run used noiseless fits. The reference record uses port noise sources with the Twiss correlation and gives
   5.13 dB to 5.22 dB. Since step 7, `fit_to_spice` writes these port noise sources when the fit has
   `uses.noise_band_hz`, and the fit-band gate fails a noise bench whose fitted model has no port noise. The
   reference circuit with such fits of its four EM networks gives 5.181 dB at tt (simulated, ngspice 46); the
   reference value of `expected.json` was not computed again.

## Reference

`reference.mjs` runs the reference amplifier (not in this repository; the path is an argument) through both benches
at the five corners. Every row passes (simulated, ngspice 46):

| Row | Reference |
| --- | --- |
| gain (tt) | 13.62 dB (the reference record: 13.34 dB to 13.81 dB with the antenna source) |
| noise figure (tt) | 4.99 dB |
| S22 (tt) | −10.20 dB |
| μ minimum, 1 GHz to 300 GHz | 1.087 (fast_cold) to 1.117 (the record: ≥ 1.079) |
| current | 12.3 mA (slow_cold) to 21.0 mA (fast_hot), the 3.1 mA of reference currents included (the record: 12.71 mA without them) |
| largest V<sub>CE</sub> | 1.376 V (fast_cold) |
| largest current per emitter | 1.76 mA (fast_hot) |

The fitted EM networks of the reference had internal resistors. The reference run uses copies in which each such
resistor is a self-controlled G source (the same subcircuit as the `fit_to_spice` output now writes); with the
resistors, the noise bench gave 275 dB.

## Scoring

- design (2): the subcircuit, the pin order and the device rules of `spec.md`.
- em_passive (2): `lna` uses a subcircuit that is the output of a `fit_to_spice` record of the workspace, whose input
  Touchstone file is the output of an openEMS record (by SHA-256). The scorer does not repeat the EM run, and it does
  not check that the passive is in the signal path.
- requirements (53 and the gate rows of step 7): each verified row passes, the gate rows included. Step 7 adds the netlist gate row and one `fit_band` row for each bench and fitted model. Only with the design points.
- claim (4): `meets_spec` is the same as the verification (design, EM passive, every row).
- values (13): each reported value of a requirement row is within the tolerance of the verified value.

The device rules are the gate `netlist` of `requirements.json` (kernel `checkNetlist`; the scorer and
`check_requirements` use the same check). An X line of a PDK device may set only the instance parameters of the
`instance_params` class of the device in the technology pack (for the HBT: `Nx`, `Ny`, `m`; the line models: `len` from 1 nm to 1 mm). A parameter that changes
the device physics (for example `selft`, `dtemp`, `mm_ok`) is an error, unless the gate names it in `allow_params`.

## Limit sources

Each limit of `requirements.json` has `limit_source`: a row of the specification, a PDK document, a value set
from the reference design (the reference passes it by construction), or a choice of the task author.

| Limit | Value | Source | Reference |
| --- | --- | --- | --- |
| `gain` | 13 to 15 dB | specification | row 1: 13 dB to 15 dB, revision 0.1 of the interface rows |
| `nf_db` | <= 6 dB | specification | row 2: 6 dB at tt, revision 0.1 |
| `s22` | <= -10 dB | specification | row 3 |
| `mu` | >= 1 | specification | row 4 |
| `idd_a` | <= 0.025 A | specification | row 5 |
| gate `limits` `hbt_ic_per_emitter_3ma` | <= 0.003 | specification | row 7: 3 mA per emitter (the PDK process specification gives 3.5 mA) |
| gate `limits`, the other rows | the PDK limits of the pack | PDK document | each limit of the technology pack names its PDK source |

## Pilot runs (one run per model, 2026-11-15)

Two runs of the `simra` arm, image `simra-agent-env:82238a8`, 4 CPUs (shared with the hard detector pilot), 180 min
limit. One sample per model, not a rate.

| Item | Default model (`deepseek/deepseek-flash`) | Stronger configured model (`openai/gpt-6.1-sol`) |
| --- | --- | --- |
| Score | design 2/2, EM passive 2/2, requirements 43/53, claim 4/4, values 13/13 | design 2/2, EM passive 2/2, requirements 53/53, claim 4/4, values 13/13 (after the scorer fix below) |
| Wall time, model calls | 1836 s, 270 calls | 322 s, 52 calls |
| Tokens | 59.2 M prompt (59.1 M cached), 0.25 M completion (0.17 M reasoning) | 2.30 M prompt (2.24 M cached), 13.4 k completion (3.8 k reasoning) |
| Design | two CE stages (Nx 9 and 6), a drawn TopMetal2 inductor (EM, fit order 2) as the stage-2 collector load | three CE stages with emitter degeneration, damped inductive loads, a 30 µm TopMetal2 output line as the EM passive |
| Rows | gain 14.29 dB, NF 4.54 dB, S22 −15.6 dB, ≤ 23.9 mA; **μ fails at all 5 corners** (−0.93 at 57 GHz at tt) | gain 13.50 dB, NF 5.89 dB, S22 −13.6 dB, 11.5 mA to 20.0 mA, μ 1.0038 at 1 GHz at every corner |
| EM fit band | 60 GHz to 180 GHz, used by a bench from 1 GHz to 300 GHz (nothing checks this) | 1 GHz to 300 GHz |
| Tools | 188 bash (75 read the record JSON files), `workarounds` 1, `query_results` 0 | 12 bash, `query_results` 4, `workarounds` 1 |
| End | stopped after 31 min with μ failing; the notes say "in the time available" | all rows pass |

Cause of the failed rows of the default model: design error (a base-bias line resonates with the input capacitance:
negative input resistance at 54 GHz to 75 GHz, found by the agent) and model error (it stopped with 150 min left). A
possible tool gap: its EM inductor model is extrapolated below 60 GHz, where μ fails; the run does not separate the
two.

Scorer fix after the second run (task error): the device rules allowed `.param` lines but did not evaluate `{expr}`
values, so the design of the second run had 12 false errors (for example `len={lbias}` with `lbias=300u`) and got
design 0/2, requirements 0/53 and claim 0/4, although the check passed every row. `score.mjs` now evaluates
`{expr}` with the `.param` values; the second workspace was scored again with the fixed scorer (full verification).

## Pilot runs, step 7 (three runs per model, 2026-11-15)

Image `simra-agent-env:a9c3f12` (netlist gate, fit-band gate, port noise of fitted passives, stability diagnosis,
query steering), 4 CPUs shared with one hard-detector run, 180 min limit. Three samples per model: a count, not a
rate with a useful confidence interval.

| Run | Model | Score (design, EM, requirements, claim, values) | Missed rows | Wall time | Model calls | Prompt tokens |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | default (`deepseek/deepseek-flash`) | 2, 2, 55/55, 4, 13/13 (scored again, see below) | none | 1875 s | 222 | 46.2 M |
| 2 | default | 2, 2, 55/55, 4, 13/13 | none | 2832 s | 283 | 78.3 M |
| 3 | default | 2, 2, 53/55, 4, 13/13 | `tt gain` 6.42 dB, `tt nf_db` 8.17 dB | 1989 s | 244 | 56.4 M |
| 1 | stronger (`openai/gpt-6.1-sol`) | 2, 2, 55/55, 4, 13/13 (scored again, see below) | none | 399 s | 70 | 3.8 M |
| 2 | stronger | 2, 2, 55/55, 4, 13/13 | none | 370 s | 59 | 3.2 M |
| 3 | stronger | 2, 2, 55/55, 4, 13/13 | none | 641 s | 101 | 7.1 M |

Pass count (every row, claim right): default model 2 of 3, stronger model 3 of 3 (step 6: 0 of 1 and 1 of 1).

1. Default run 3, cause class design error: two cascode stages give about 3 dB each, and the input match for that
   gain is far from the noise optimum. The agent stopped after 33 min of 180 with `meets_spec` false and the two
   rows named; it put the cause on the gain limit of the device, which the reference (13.6 dB with three
   common-emitter stages) does not support.
2. Every run gave its fits `uses.band_hz` from 1 GHz to 300 GHz and `uses.noise_band_hz` around 122.5 GHz; the
   fit-band rows passed. No run used an instance parameter that changes the device physics. The netlist gate of
   the agent's own check failed once in four runs (a design without the EM passive yet; in one run also an ideal
   1 GΩ resistor), and each agent fixed it before its final check.
3. Task error in the scorer, found by default run 1 and stronger run 1: the scorer verified in a new root without
   the fit records of the workspace, so the netlist gate did not see the fitted model (71 false rule errors) and
   the fit-band rows were missing. The agent's own check of the same design passed both gates. `score.mjs` now
   copies the `fit_to_spice` and `openems` records into the verify root (`copyFitRecords`); the two runs were scored
   again with full verification.
4. Bash calls that read record JSON files (`result.json`, `verdict.json`, `experiment.json`): default model 0, 0, 0
   (step 6: 5 of 188); any path in the record tree, work logs included: 54, 75, 71 (step 6: 77). `query_results`
   calls: 1, 1, 1 (step 6: 0). The steering moved the reads of record JSON to zero, not the reads of work logs
   (`ngspice.log`, raw tables) with `cat` and Python, which the note does not cover.
5. Token use of the default model (46 M to 78 M prompt tokens, step 6 59 M): the context grows from 17 k to 369 k
   to 486 k tokens over 222 to 283 calls and each call sends all of it. In the final context, the reasoning of
   earlier turns is 55 % to 57 % of the characters, tool results 27 % to 30 %, tool-call arguments 12 % to 17 %.
