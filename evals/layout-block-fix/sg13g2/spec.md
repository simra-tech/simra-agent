# Layout specification: idac (IHP SG13G2)

The cell is the top cell `idac` in `block.gds`, with the pins `o0 o1 o2 o3 o4 o5 o6 o7 inp inn outp outn ibias vss`, in this order.
The reference netlist is the subcircuit `idac` in `block.spice`.

## Circuit

A binary-weighted NMOS current-source array with eight branches, the diode of its current mirror, and an NMOS
differential pair with a tail current source. All devices are `sg13_lv_nmos` with W = 1 µm, L = 0.5 µm and one
finger: 10012 devices.

| Part | Devices | Drain | Gate | Source | Bulk |
| --- | --- | --- | --- | --- | --- |
| branch k of the array (k = 0 to 7) | 36 × 2^k | o<k> | ibias | vss | vss |
| diode of the mirror | 384 | ibias | ibias | vss | vss |
| input device, left | 128 | outn | inp | tail | vss |
| input device, right | 128 | outp | inn | tail | vss |
| tail current source | 192 | tail | ibias | vss | vss |

The bulk is the p-substrate. A substrate tap in each unit cell connects it to `vss`. The net `tail` is internal.

## Hierarchy

The reference netlist has one subcircuit for each cell of the layout.

| Level | Cell | Contents |
| --- | --- | --- |
| 0 | `unit` | one device with its rails: gate, source and bulk on Metal1, drain on Metal2 |
| 1 | `arr<R>x<C>` | R rows and C columns of `unit`, with vertical Metal3 straps for the gate, the bulk, the source and the drain |
| 2 | `csarray`, `bias`, `diffpair` | the arrays of the current-source array, of the diode, and of the input pair and the tail, with Metal2 buses |
| 3 | `idac` | the three level-2 cells, the bus links, the lines to the pins, and the pins on the block boundary |

The frame around the core has fill shapes on Activ, GatPoly and the metals (the cells `*_FILL_CELL`). They are
not connected. Keep them: the density rules need them.

## Pins

| Pin | Layer of the pin | Position | Function |
| --- | --- | --- | --- |
| o0 to o7 | Metal3 | top edge | outputs of the branches (drain currents) |
| inp, inn | Metal3 | top edge | inputs |
| outp, outn | Metal3 | top edge | outputs of the pair (drain currents) |
| ibias | Metal2 | left edge | bias current input |
| vss | Metal2 | left edge | ground and substrate |

A pin is a shape on the pin layer (Metal2.pin 10/2, Metal3.pin 30/2) and a label with the pin name on the text layer (Metal2.text 10/25, Metal3.text 30/25), on the metal of
the net. Keep the pins and their labels.

## Checks

1. DRC: `./drc.sh block.gds idac` runs the stock KLayout DRC of the PDK (`run_drc.py`) with the full rule set:
   the main rules, the extra rules and the density rules (no switch that turns a rule group off). The block has
   fill (the stock filler of the PDK) in the frame around the core, so the density rules pass on the clean block.
   The block is DRC clean when the deck reports 0 markers.
2. LVS: `./lvs.sh block.gds idac` runs the stock KLayout LVS of the PDK (`run_lvs.py`). It compares the layout
   with `block.spice`. The block passes when the deck reports that the netlists match and the pins of the extracted
   netlist are the pins of this specification.
