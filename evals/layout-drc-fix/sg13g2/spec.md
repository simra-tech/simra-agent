# Layout specification: diffpair (IHP SG13G2)

The cell is the top cell `diffpair` in `cell.gds`, with the pins `inp inn outp outn ibias vss`, in this order.
The reference netlist is the subcircuit `diffpair` in `cell.spice`.

## Circuit

An NMOS differential pair with a tail current mirror and a dummy device at each end of the pair. All devices are
`sg13_lv_nmos` with W = 1 µm, L = 0.5 µm and one finger.

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
| inp, inn | Metal1 | inputs |
| outp, outn | Metal1 | outputs (drain currents) |
| ibias | Metal1 | bias current input |
| vss | Metal2 | ground and substrate |

A pin is a shape on the pin layer (Metal1.pin 8/2, Metal2.pin 10/2) and a label with the pin name on the text
layer (Metal1.text 8/25, Metal2.text 10/25), on the metal of the net. Keep the pins and their labels.

## Checks

1. DRC: `./drc.sh cell.gds diffpair` runs the stock KLayout DRC of the PDK (`run_drc.py`) with the main rule set:
   `--disable_extra_rules --no_density`. Density is a chip-level rule and is not part of the check of a cell.
   The cell is DRC clean when the deck reports 0 markers.
2. LVS: `./lvs.sh cell.gds diffpair` runs the stock KLayout LVS of the PDK (`run_lvs.py`). It compares the layout
   with `cell.spice`. The cell passes when the deck reports that the netlists match and the pins of the extracted
   netlist are the pins of this specification.
