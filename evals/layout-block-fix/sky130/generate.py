# Write the GDS (or the reference netlist) of the block of the layout block tasks on SkyWater SKY130 (sky130A). See
# ../block.py for the floor plan, the seeds and the variants. The device and the substrate tap are the ones of the
# layout-drc-fix cell (../../layout-drc-fix/sky130/generate.py: the PCell nfet of the PDK library skywater130). The
# stock DRC deck of this PDK has no density rules, so the block has no fill and no frame. Run in the environment
# image:
#   python3 generate.py --variant <clean|seeded|cheat> --out block.gds   (prints the SHA-256 of the GDS)
#   python3 generate.py --spice --out block.spice
#   python3 generate.py --info   (prints the facts of the block: devices, cells, size, seeds)

import importlib.util
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, ".."))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cellgen = _load("drcfix_sky130", os.path.join(here, "../../layout-drc-fix/sky130/generate.py"))

import block  # noqa: E402


class SKY130Block(cellgen.SKY130):
    CELL = "idac"
    LAYERS = {
        **cellgen.SKY130.LAYERS,
        "via2": (69, 44),
        "m3": (70, 20),
        "m3_pin": (70, 16),
        "m3_label": (70, 5),
    }
    # The arrays (rows, columns): the branches are the base shapes times SCALE.
    SCALE = (6, 6)
    BIAS = (16, 24)
    PAIR = (8, 16)
    TAIL = (8, 24)
    # The unit (nm): width, row pitch, x of the device; the rails (y ranges) and the tap.
    UNIT_W = 3000
    ROW_H = 3600
    UX = 900
    S_RAIL = (-300, 0)
    B_RAIL = (-900, -600)
    TAP_UX = 1100
    TAP_UY = -1000
    D_Y = 500
    D_RAIL_H = 350
    # Vias and pads: via.1a 0.15 um, via2.1a 0.2 um.
    VIA = 150
    VIA2 = 200
    M1_PAD = 390
    M2_PAD = 390
    M3_PAD = 400
    STACK_DX = 400
    # Straps, buses and pins. No frame: the deck has no density rules.
    STRAP_W = 400
    STRAP_PITCH = 1000
    STRAP_EXT = 500
    BUS_W = 2000
    BUS_GAP = 1000
    PIN_H = 1000
    PIN_EXT = 6000
    ARRAY_GAP = 1500
    GROUP_GAP = 10000
    LEFT = 12000
    FRAME = 0
    # Seeds: m1.1 / m1.2 / m2.1 / m2.2 0.14 um, m3.1 / m3.2 0.3 um, m3.6 0.24 um2, grid 5 nm.
    SPUR_W = 200
    BAD_M1_W = 100
    BAD_M1_S = 100
    BAD_M2_W = 100
    BAD_M2_S = 100
    BAD_M3_W = 200
    BAD_M3_S = 200
    COMB_W = 400
    COMB_L = 1000
    OFFGRID = 2
    JUMPER_IN = 600
    JUMPER_W = 1000
    PAD_PITCH = 1000
    SMALL_M3_PAD = 400
    NECK_ROWS = 2
    NECK_PINS = ("o2", "outp")
    COMB_PIN = "o7"

    def spice_device(self, name, d, g, s, b):
        return f"{name} {d} {g} {s} {b} sky130_fd_pr__nfet_01v8 L=0.5u W=1u"


if __name__ == "__main__":
    block.main(SKY130Block(), sys.argv[1:])
