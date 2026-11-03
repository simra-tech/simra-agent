# Layout specification: idac (SkyWater SKY130)

The cell is the top cell `idac` in `block.gds`, with the pins `o0 o1 o2 o3 o4 o5 o6 o7 inp inn outp outn ibias vss`, in this order.
The reference netlist is the subcircuit `idac` in `block.spice`.

## Circuit

A binary-weighted NMOS current-source array with eight branches, the diode of its current mirror, and an NMOS
differential pair with a tail current source. All devices are `sky130_fd_pr__nfet_01v8` with W = 1 µm, L = 0.5 µm and one
finger: 21487 devices.

| Part | Devices | Drain | Gate | Source | Bulk |
| --- | --- | --- | --- | --- | --- |
| branch k of the array (k = 0 to 7) | 81 × 2^k | o<k> | ibias | vss | vss |
| diode of the mirror | 384 | ibias | ibias | vss | vss |
| input device, left | 128 | outn | inp | tail | vss |
| input device, right | 128 | outp | inn | tail | vss |
| tail current source | 192 | tail | ibias | vss | vss |

The bulk is the p-substrate. A substrate tap in each unit cell connects it to `vss`. The net `tail` is internal.

## Layout

The layout is flat: the top cell `idac` holds every shape and has no instances. The floor plan has these parts:

| Part | Contents |
| --- | --- |
| unit | one device with its rails: gate, source and bulk on met1, drain on met2 |
| array | rows and columns of units, with vertical met3 straps for the gate, the bulk, the source and the drain |
| current-source array, diode, input pair and tail | the arrays, with met2 buses |
| top level | the bus links, the lines to the pins, and the pins on the block boundary |

The reference netlist is flat too: one subcircuit `idac` with one device line for each device.

## Pins

| Pin | Layer of the pin | Position | Function |
| --- | --- | --- | --- |
| o0 to o7 | met3 | top edge | outputs of the branches (drain currents) |
| inp, inn | met3 | top edge | inputs |
| outp, outn | met3 | top edge | outputs of the pair (drain currents) |
| ibias | met2 | left edge | bias current input |
| vss | met2 | left edge | ground and substrate |

A pin is a shape on the pin layer (met2.pin 69/16, met3.pin 70/16) and a label with the pin name on the label layer (met2.label 69/5, met3.label 70/5), on the metal of
the net. Keep the pins and their labels.

## Checks

1. DRC: `./drc.sh block.gds idac` runs the stock KLayout DRC deck of the PDK (`sky130A_mr.drc`) with the main
   rule set: the switches of the PDK macro `run_drc_full` (`feol`, `beol` and `offgrid`). The deck has no density
   rules. The block is DRC clean when the deck reports 0 markers.
2. LVS: `./lvs.sh block.gds idac` runs the stock KLayout LVS deck of the PDK (`sky130.lvs`). It compares the
   layout with `block.spice`. The block passes when the deck reports that the netlists match and the pins of the
   extracted netlist are the pins of this specification.
