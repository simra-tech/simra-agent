# openems adapter

The openems adapter gives the S-parameters of a layout cell with openEMS (FDTD). It has two operations:

- `simulate`: a GDS cell, an openEMS stackup XML and lumped ports in. It writes the S-parameter column of each excited
  port (`columns.json`), and a Touchstone file when every port is excited in the run.
- `merge`: the `columns.json` files of several `simulate` runs in, one Touchstone file out.

The kernel command `simra em` runs one `simulate` job per port and then `merge` (see the main README, "EM
S-parameters"). The inputs, measurements and outputs are in [adapter.json](adapter.json).

The adapter has no PDK facts. The stackup comes from the caller (input `stackup`; `$PDK_ROOT` is expanded). For IHP
SG13G2 it is `$PDK_ROOT/ihp-sg13g2/libs.tech/openems/openems_ihp_sg13g2/workflow/SG13G2_200um.xml`.

`simulate` needs Python 3 with numpy, gdstk, CSXCAD and openEMS (tested with openEMS 0.37 and gdstk 1.0.1). `merge`
needs only the standard library.

## Model

| Item | Model |
| --- | --- |
| metal layer | a conducting sheet at one face of the layer (input `faces`, default the bottom face Zmin), with the conductivity and the thickness of the stackup |
| via layer | a solid conductor from the sheet of the nearest metal below to the sheet of the nearest metal above |
| slits | with `cut`, the openings drawn on another GDS datatype (for example `{"Metal1": [24]}`, the slits of IHP SG13G2) are removed from the metal; without it the metal is the drawing (datatype 0) only |
| via array | with `merge_um`, the vias become blocks (grow by half the distance, unite, shrink back); the block conductivity is the via conductivity times the via area over the block area (measurement `via_fill_<layer>`); input `via_fill` (`{layer: factor}`, 0 < factor <= 1) sets that factor instead, for example to match another model |
| dielectric | a box over the domain, or over the die only (input `die`; air outside), with the permittivity and the conductivity of the stackup |
| slab | input `slabs`: a homogenised anisotropic layer (in-plane and z permittivity, in-plane magnetic conductivity) over rectangles or the die, between two layer faces; for example metal fill |
| port | a z-directed lumped port with a resistance (default 50 ohm), from the sheet of the layer `from` to the sheet of the layer `to`, or from the bottom of the domain (`bottom`); `x` and `y` are a point or a span `[a, b]` |
| domain | the layout (or the die) plus `margin_um` (default 200 um) on each side; from the bottom of the substrate to the top of the air |
| boundaries | default PML_8 on the four sides and the top, PEC at the bottom |
| excitation | a Gaussian pulse, by default from 0 Hz to f_hi of `band_hz` (`excite_f0_hz`, `excite_fc_hz`) |

The mesh has lines at the polygon edges, at +-`fine_um` (default 3 um) around each vertex, at the metal sheets, at the
ports (four lines along each port) and at the dielectric interfaces. A dielectric interface nearer than
`dielectric_snap_um` (default 2 um) to another line has no line of its own: a 0.4 um passivation layer would otherwise
set the time step of the whole run. An x or y line nearer than `min_cell_um` (default 1 um) to a kept line is dropped:
the geometry snaps to the nearest line (merged via blocks have small steps at their edges). Port lines are kept.
Between fixed lines, the cells grow from the smaller neighbour cell by a factor of 1.4 up to `max_cell_um`.
`mesh_scale` scales all cell sizes. `dry_run` builds the model and the mesh only, and reports the cell count and the
smallest cells: use it to size a run before you start it.

## De-embedding

Input `deembed` moves the reference plane of a port along a uniform line: `S'ij = Sij exp(gamma (li + lj))`, with
`gamma = alpha + j beta`, `beta = 2 pi f sqrt(eps_eff) / c` and `alpha` from `loss_db_per_mm` (not a function of
frequency). A positive `length_um` moves the plane into the structure (it removes that length of line). A negative one
adds line. The Touchstone file has the moved planes and says so in a comment. The column files keep the port planes, so
`merge` can apply another shift without a new EM run. The values `eps_eff` and `loss_db_per_mm` come from the caller, for
example from two runs of the same line with two lengths.

The container test runs a 300 um and a 600 um line. It takes `eps_eff` and the loss from the two runs. With 150 um removed
at each port, the 600 um line must equal the 300 um line.

## Convergence

openEMS stops when the field energy falls by `end_criteria_db` (default -40 dB) or at `max_timesteps`. A run that stops
at `max_timesteps` did not converge, and its S-parameters can be wrong. The adapter reads the openEMS log
(`work/openems_p<k>.log`) and reports per excited port:

- `end_criteria_reached_p<k>`: 1 or 0;
- `energy_end_db_p<k>`: the last energy value of the log;
- `timesteps_p<k>`, `cells_p<k>`, `solve_s_p<k>`.

A run that did not converge is failed and has no Touchstone file. With `allow_unconverged` it is a warning.

First-order MUR boundaries do not absorb the quasi-static field of an on-chip line. A microstrip on the IHP SG13G2
stackup then stays at an energy plateau of -13 dB to -18 dB. The S-parameters of such a run looked correct, but the run
never reached the end criterion. With PML on the sides and the top, the same line reaches -40 dB in about 17000 time
steps.

## Headless operation

The adapter never opens a viewer (AppCSXCAD). The solver runs in a child process (`openems_adapter.py --solve
plan.json`) with one thread per CPU of the job. Its output goes to the log file. The simulation paths are absolute,
because openEMS 0.37 stops when the working directory differs from the simulation path.

## Fixtures

- `fixtures/line.gds` and `fixtures/line600.gds`: a TopMetal2 line (300 um or 600 um x 18 um, GDS 134/0) over a Metal1
  ground (120 um wide, GDS 8/0), cell `line`. `fixtures/make_line.py` makes them (gdstk, fixed time stamp).
- `fixtures/stackup-small.xml`: a small synthetic stackup for the unit tests. It is not a process stackup.
- `fixtures/log-pml-converged.log` and `fixtures/log-mur-maxts.log`: the end of two openEMS 0.37 logs of the line, with
  PML (converged) and with MUR (stopped at max_timesteps).
