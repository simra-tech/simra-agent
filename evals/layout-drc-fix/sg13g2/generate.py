# Write the GDS of the layout task cell on IHP SG13G2 (see ../cell.py for the floor plan and the variants).
# The MOS devices are the PCell nmos of the PDK library SG13_dev (sg13g2_pycell_lib), made with klayout.db in batch.
# Run in the environment image:
#   python3 generate.py --variant <clean|seeded|cheat> --out cell.gds   (prints the SHA-256 of the GDS)

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PY = os.path.join(os.environ.get("PDK_ROOT", "/foss/pdks"), "ihp-sg13g2/libs.tech/klayout/python")
sys.path[:0] = [PY, os.path.join(PY, "pycell4klayout-api/source/python")]

import contextlib
import io

import klayout.db as db

with contextlib.redirect_stdout(io.StringIO()):
    import sg13g2_pycell_lib  # noqa: F401  (registers the library SG13_dev; it prints a banner)

import cell


def library(name):
    for i in db.Library.library_ids():
        lib = db.Library.library_by_id(i)
        if lib.name() == name:
            return lib
    raise RuntimeError(f"library {name} not found")


class SG13G2:
    CELL = "diffpair"
    # layer: (layer, datatype)
    LAYERS = {
        "activ": (1, 0),
        "gatpoly": (5, 0),
        "cont": (6, 0),
        "psd": (14, 0),
        "m1": (8, 0),
        "m1_pin": (8, 2),
        "m1_label": (8, 25),
        "via1": (19, 0),
        "m2": (10, 0),
        "m2_pin": (10, 2),
        "m2_label": (10, 25),
    }
    W = 1000  # channel width (nm); L = 500 nm
    PITCH = 3000
    LINE_W = 160  # Metal1 line width (the width of the source and drain strips of the PCell)
    VIA = 190  # V1.a
    M1_PAD = 390
    PIN_PAD = 400
    BUS_H = 350
    BUS_PITCH = 700
    TAP_X = 1500
    # Seeds: M1.a 0.16 um, M2.b 0.21 um, V1.c 0.01 um, 5 nm grid.
    NARROW = 140
    SPACE_SEEDED = 180
    VIA_SHIFT = 95
    OFFGRID = 1

    def __init__(self):
        self.lib = library("SG13_dev")

    def device(self, ly, top, x0, name):
        """A PCell nmos (W 1 um, L 0.5 um, 1 finger) at x0 with a gate contact above the channel."""
        pid = self.lib.layout().pcell_id("nmos")
        ci = ly.add_pcell_variant(self.lib, pid, {"w": "1u", "l": "0.5u", "ng": "1"})
        top.insert(db.CellInstArray(ci, db.Trans(db.Point(x0, 0))))
        m1 = sorted((b for b in (s.bbox() for s in ly.cell(ci).shapes(ly.layer(8, 0)).each())), key=lambda b: b.left)
        s, d = m1[0], m1[-1]
        L = {k: ly.layer(*v) for k, v in self.LAYERS.items()}
        W = self.W
        # The gate poly goes up to a contact: Cnt.e (Cont on GatPoly 0.14 um from Activ), Cnt.d, M1 pad of 0.0918 um2.
        cell.box(top, L["gatpoly"], x0 + 340, W, x0 + 840, W + 560)
        cell.box(top, L["cont"], x0 + 510, W + 300, x0 + 670, W + 460)
        g = (x0 + 455, W + 210, x0 + 725, W + 550)
        cell.box(top, L["m1"], *g)
        return {"s": (x0 + s.left, x0 + s.right, s.bottom, s.top), "d": (x0 + d.left, x0 + d.right, d.bottom, d.top), "g": g}

    def tap(self, ly, top, x, y):
        """A substrate tap (p+ Activ in pSD with four contacts, as in the PCell ptap1, without its sub! label)."""
        L = {k: ly.layer(*v) for k, v in self.LAYERS.items()}
        cell.box(top, L["activ"], x, y, x + 780, y + 780)
        cell.box(top, L["psd"], x - 30, y - 30, x + 810, y + 810)
        for cx in (140, 480):
            for cy in (140, 480):
                cell.box(top, L["cont"], x + cx, y + cy, x + cx + 160, y + cy + 160)
        m1 = (x + 140, y + 90, x + 640, y + 690)
        cell.box(top, L["m1"], *m1)
        return m1


if __name__ == "__main__":
    cell.main(SG13G2(), sys.argv[1:])
