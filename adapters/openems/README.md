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
| metal layer | a conducting sheet at the bottom face (Zmin) of the layer, with the conductivity and the thickness of the stackup |
| via layer | a solid conductor from the sheet of the metal below to the top of the via |
| dielectric | a box over the whole domain, with the permittivity and the conductivity of the stackup |
| port | a z-directed lumped port with a resistance (default 50 ohm), from the sheet of the layer `from` to the sheet of the layer `to`, or from the bottom of the domain (`bottom`) |
| domain | the layout plus `margin_um` (default 200 um) on each side; from the bottom of the substrate to the top of the air |
| boundaries | default PML_8 on the four sides and the top, PEC at the bottom |
| excitation | a Gaussian pulse from 0 Hz to f_hi of `band_hz` |

The mesh has lines at the polygon edges, at +-`fine_um` (default 3 um) around each vertex, at the metal sheets, at the
ports (four lines along each port) and at the dielectric interfaces. A dielectric interface nearer than
`dielectric_snap_um` (default 2 um) to another line has no line of its own: a 0.4 um passivation layer would otherwise
set the time step of the whole run. Between fixed lines, the cells grow from the smaller neighbour cell by a factor of
1.4 up to `max_cell_um`. `mesh_scale` scales all cell sizes.

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

- `fixtures/line.gds`: a TopMetal2 line (300 um x 18 um, GDS 134/0) over a Metal1 ground (300 um x 120 um, GDS 8/0),
  cell `line`. `fixtures/make_line.py` makes it (gdstk, fixed time stamp).
- `fixtures/stackup-small.xml`: a small synthetic stackup for the unit tests. It is not a process stackup.
- `fixtures/log-pml-converged.log` and `fixtures/log-mur-maxts.log`: the end of two openEMS 0.37 logs of the line, with
  PML (converged) and with MUR (stopped at max_timesteps).
