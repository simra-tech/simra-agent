# Layout specification: diffpair (SkyWater SKY130)

The cell is the top cell `diffpair` in `cell.gds`, with the pins `inp inn outp outn ibias vss`, in this order.
The reference netlist is the subcircuit `diffpair` in `cell.spice`.

## Circuit

An NMOS differential pair with a tail current mirror and a dummy device at each end of the pair. All devices are
`sky130_fd_pr__nfet_01v8` with W = 1 µm, L = 0.5 µm and one finger.

| Device | Drain | Gate | Source | Bulk | Function |
| --- | --- | --- | --- | --- | --- |
| M1 | outn | inp | tail | vss | input pair |
| M2 | outp | inn | tail | vss | input pair |
| M3 | tail | ibias | vss | vss | tail current source |
| M4 | ibias | ibias | vss | vss | diode of the mirror |
| MD1, MD2 | vss | vss | vss | vss | dummy devices |

The bulk is the p-substrate. A substrate tap at the left of the row connects it to `vss`.

## Pins

| Pin | Layer of the pin | Function |
| --- | --- | --- |
| inp, inn | met1 | inputs |
| outp, outn | met1 | outputs (drain currents) |
| ibias | met1 | bias current input |
| vss | met2 | ground and substrate |

A pin is a shape on the pin layer (met1.pin 68/16, met2.pin 69/16) and a label with the pin name on the label
layer (met1.label 68/5, met2.label 69/5), on the metal of the net. Keep the pins and their labels.

## Checks

1. DRC: `./drc.sh cell.gds diffpair` runs the stock KLayout DRC deck of the PDK (`sky130A_mr.drc`) with the main
   rule set: the switches of the PDK macro `run_drc_full` (`feol`, `beol` and `offgrid`). The cell is DRC clean
   when the deck reports 0 markers.
2. LVS: `./lvs.sh cell.gds diffpair` runs the stock KLayout LVS deck of the PDK (`sky130.lvs`). It compares the
   layout with `cell.spice`. The cell passes when the deck reports that the netlists match and the pins of the
   extracted netlist are the pins of this specification.
