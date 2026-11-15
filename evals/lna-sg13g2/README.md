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
| `requirements.json` | five corners, five requirements (13 rows), the stability gate and the operating-limit gate |
| `score.mjs` | scorer: device rules, the EM passive in the records, then the check of `requirements.json` through the kernel |
| `reference.mjs` | reference run: the reference design through the same benches and gates, writes `expected.json` |
| `expected.json` | reference value of each row, with provenance |

## Deviations from the reference design

1. Both ports are 50 Ω (assumption `ports_50ohm`). The reference matches its input to a fitted antenna model.
2. The gain row is the 13 dB to 15 dB row of revision 0.1 of the interface rows, at tt only. The later rows of the
   chip (a gain setting per corner) need the steering circuit of the later revisions.
3. The noise figure leaves out the loss noise of the EM passives. `fit_to_spice` writes a noiseless subcircuit
   (registry entry `fit-to-spice-noise`). The reference record uses port noise sources with the Twiss correlation
   and gives 5.13 dB to 5.22 dB; this bench gives 4.99 dB for the same circuit.

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
- requirements (53): each verified row passes, the gate rows included. Only with the design points.
- claim (4): `meets_spec` is the same as the verification (design, EM passive, every row).
- values (13): each reported value of a requirement row is within the tolerance of the verified value.
