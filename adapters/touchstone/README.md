# touchstone adapter

The touchstone adapter makes a SPICE subcircuit from a Touchstone file. Use it when a passive part (a matching
network, a transmission line, a pad, a transformer) exists only as S-parameters, for example from an EM simulation,
and a circuit simulation needs it.

It has one operation: `fit_to_spice`. The inputs, measurements and outputs are in [adapter.json](adapter.json).
The adapter needs Python 3.6 or later and numpy. ngspice and Xyce are necessary only for the re-simulation
(`verify`).

## Method

1. Read the file (Touchstone version 1 or 2, S-parameters, any format and unit; version 2 matrix order and
   reference impedances).
2. Refuse the run before the fit when the data does not support the use (input `uses`):
   - the data band does not cover the frequencies of the simulation (an extrapolation);
   - the simulation solves a DC point (every SPICE analysis does) and the data has no 0 Hz point, unless
     `dc_policy` is `"model"`.
3. Fit a rational model with common poles (relaxed vector fitting, real arithmetic for complex pole pairs). The
   order is the lowest even order that meets `limits.max_abs_ds`, unless `order` is given.
4. Test passivity with the eigenvalues of the Hamiltonian matrix. When the test fails, limit D below 1, refit the
   residues, and change the residues by the smallest amount that removes the violation (residue perturbation).
   The change of the model at the data points is a measurement (`enforcement_max_abs_ds`).
5. Write the subcircuit. Each port is a Norton network (Z0 and a controlled current source); each pole is a
   state network of C and controlled sources. Only C, G, F and V elements occur, so one netlist works in ngspice
   and in Xyce. Each conductance is a G source controlled by its own voltage: the subcircuit is noiseless. A resistor
   of the realisation would add noise with no relation to the passive (an LNA with fitted matching networks gave a
   noise figure of 275 dB).
6. Port noise (input `uses.noise_band_hz`, at most 5 % wide around its centre f0): the subcircuit gets noise
   currents at the ports with the correlation matrix 4kT Re Y(f0) of the model (Twiss). Each eigenvector of Re Y
   gives one 1 Ω noise resistor; F and G sources (and a 1/(2π f0) H inductor for an imaginary weight) carry its
   noise to each port. The adapter checks the noise in ngspice: each port terminated in a noisy Z0 must give the
   thermal noise 4kT Re Z of the passive (`noise_verify_max_rel_error`, error diagnostic above 0.02). Outside the
   noise band the noise is that of f0. Without `uses.noise_band_hz` the subcircuit is noiseless, and the fit-band
   gate of `check_requirements` fails a noise analysis that uses it (registry entry `fit-to-spice-noise`).
7. Re-simulate the subcircuit with an AC run per port, in each simulator of `verify`. Compare with the model and
   with the data. A difference to the model above 1e-4 is an error: the subcircuit is not the model.
8. Report the error in the band of use: `use_max_abs_ds` (largest |S_model - S_data| at the data points in
   `uses`) and `use_max_abs_db` (largest dB error where |S| ≥ 0.1). These are the acceptance values of a fit; a
   higher order is not a better fit when these do not fall (registry entry `fit-acceptance-error-in-band`). Limits
   `limits.use_max_abs_ds` and `limits.use_max_abs_db` make the fit fail above them.
9. Write the band of use in the subcircuit header (`simra-fit: ... uses_band_hz=... noise_band_hz=...`) and in the
   record. The fit-band gate of `check_requirements` reads it from the record (registry entry `fit-band-of-use`).

## Guards

| Condition | Result |
| --- | --- |
| no `uses` | refused: the adapter cannot check the band |
| data band does not cover `uses` | refused, with the band of the data and the missing frequencies |
| `uses.dc` true, no 0 Hz point, no `dc_policy` | refused |
| fit error above the limit at `max_order` | failed, with the best error |
| model not passive after enforcement | failed |
| `uses.noise_band_hz` wider than 5 % of its centre | refused |
| error in the band of use above `limits.use_max_abs_ds` or `limits.use_max_abs_db` | failed |
| a band-of-use check (`checks`: Q or Re Z of a port or a port pair) above its `tol_rel` | failed |
| port noise differs from 4kT Re Z by more than 2 % | error diagnostic |
| subcircuit differs from the model in a simulator | error diagnostic for that simulator |

## Tests

- `test_touchstone_adapter.py` (8 tests, numpy only): parse and write, fit of a closed-form low-pass 2-port and a
  3-port star, passivity enforcement, the refusals, and the subcircuit solved with a small nodal solver.
- `test/touchstone-fit.test.mjs`: the adapter through the kernel runner, 2-port and 3-port, re-simulated in ngspice
  and Xyce. The local case needs ngspice, Xyce and numpy on the host; the container case needs `SIMRA_TEST_IMAGE`.
- `evals/rf-passive-gain`: a demo task that uses the subcircuit in a Xyce deck. In the reference run, the fit
  has order 4 and a largest error of 5.9e-4; the re-simulation error is the same in ngspice and Xyce.

## Band-of-use checks

The limit on max |dS| does not bound a derived quantity. Example: a 5-port tank fitted from 0 Hz to 260 GHz (order
12, max |dS| 0.0114) has a differential Q of 13.7 at 61 GHz against 15.8 in the data; the fit from 0 Hz to 130 GHz
(order 6, max |dS| 0.0058) has 15.45. An oscillator with the first model does not start.

Input `checks`, a list of:

| Field | Meaning |
| --- | --- |
| `name` | a name for the measurements |
| `kind` | `"q"`: \|Im Z\| / Re Z; `"re_z"`: Re Z |
| `ports` | `[i]`: the impedance at port i; `[i, j]`: the impedance between ports i and j (z_ii − z_ij − z_ji + z_jj) |
| `short` | optional: ports at AC ground; every other port is open |
| `band_hz` | `[f_lo, f_hi]`: the data points of this band are compared |
| `tol_rel` | the largest permitted relative error of the model against the data |

A check above its tolerance refuses the fit; the message gives both values and the frequency. Measurements:
`check_<name>_max_rel_error`, `check_<name>_data`, `check_<name>_model` (at the worst point). `fit.json` has the list.
