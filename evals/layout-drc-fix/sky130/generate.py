# Write the GDS of the layout task cell on SkyWater SKY130 (sky130A; see ../cell.py for the floor plan and the
# variants). The MOS devices are the PCell nfet of the PDK library skywater130 (libs.tech/klayout/python/cells),
# made with klayout.db in batch. Run in the environment image:
#   python3 generate.py --variant <clean|seeded|cheat> --out cell.gds   (prints the SHA-256 of the GDS)

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(os.environ.get("PDK_ROOT", "/foss/pdks"), "sky130A/libs.tech/klayout/python"))

# gdsfactory (used by the PCells) asks for the user name; a container user without a passwd entry has none.
os.environ.setdefault("USER", "designer")

import klayout.db as db

import cells  # the PCell library of the PDK

import cell


def library(name):
    for i in db.Library.library_ids():
        lib = db.Library.library_by_id(i)
        if lib.name() == name:
            return lib
    raise RuntimeError(f"library {name} not found")


class SKY130:
    CELL = "diffpair"
    # layer: (layer, datatype)
    LAYERS = {
        "tap": (65, 44),
        "psdm": (94, 20),
        "licon": (66, 44),
        "li": (67, 20),
        "mcon": (67, 44),
        "m1": (68, 20),
        "m1_pin": (68, 16),
        "m1_label": (68, 5),
        "via1": (68, 44),
        "m2": (69, 20),
        "m2_pin": (69, 16),
        "m2_label": (69, 5),
    }
    W = 1000  # channel width (nm); L = 500 nm
    PITCH = 3000
    LINE_W = 230  # met1 line width (the width of the source and drain strips of the PCell)
    VIA = 150  # via.1a
    M1_PAD = 390
    PIN_PAD = 400
    BUS_H = 350
    BUS_PITCH = 700
    TAP_X = 1500
    # Seeds: m1.1 0.14 um, m2.2 0.14 um, via.4a 0.055 um, 5 nm grid.
    NARROW = 120
    SPACE_SEEDED = 120
    VIA_SHIFT = 100
    OFFGRID = 1

    def __init__(self):
        self.keep = cells.sky130()  # registers the library skywater130
        self.lib = library("skywater130")

    def device(self, ly, top, x0, name):
        """A PCell nfet (W 1 um, L 0.5 um, 1 finger) at x0 with its gate contact on top."""
        pid = self.lib.layout().pcell_id("nfet")
        ci = ly.add_pcell_variant(self.lib, pid, {"w": 1.0, "l": 0.5, "nf": 1, "gate_con_pos": "top"})
        top.insert(db.CellInstArray(ci, db.Trans(db.Point(x0, 0))))
        m1 = sorted((s.bbox() for s in ly.cell(ci).shapes(ly.layer(68, 20)).each()), key=lambda b: (b.bottom, b.left))
        strips = sorted((b for b in m1 if b.top < self.W), key=lambda b: b.left)
        g = max(m1, key=lambda b: b.top)
        s, d = strips[0], strips[-1]
        return {"s": (x0 + s.left, x0 + s.right, s.bottom, s.top), "d": (x0 + d.left, x0 + d.right, d.bottom, d.top), "g": (x0 + g.left, g.bottom, x0 + g.right, g.top)}

    def tap(self, ly, top, x, y):
        """A substrate tap: tap in psdm with one licon, li, one mcon and met1."""
        L = {k: ly.layer(*v) for k, v in self.LAYERS.items()}
        cell.box(top, L["tap"], x, y, x + 530, y + 530)
        cell.box(top, L["psdm"], x - 125, y - 125, x + 655, y + 655)
        cell.box(top, L["licon"], x + 180, y + 180, x + 350, y + 350)
        cell.box(top, L["li"], x + 100, y + 100, x + 430, y + 430)
        cell.box(top, L["mcon"], x + 180, y + 180, x + 350, y + 350)
        m1 = (x + 100, y + 100, x + 430, y + 430)
        cell.box(top, L["m1"], *m1)
        return m1


if __name__ == "__main__":
    cell.main(SKY130(), sys.argv[1:])
