# Write the GDS (or the reference netlist) of the block of the layout block tasks on IHP SG13G2. See ../block.py for
# the floor plan, the seeds and the variants. The device and the substrate tap are the ones of the layout-drc-fix
# cell (../../layout-drc-fix/sg13g2/generate.py: the PCell nmos of the PDK library SG13_dev). The fill is the stock
# filler of the PDK (libs.tech/klayout/tech/scripts/filler.py). Run in the environment image:
#   python3 generate.py --variant <clean|seeded|cheat> --out block.gds   (prints the SHA-256 of the GDS)
#   python3 generate.py --spice --out block.spice
#   python3 generate.py --info   (prints the facts of the block: devices, cells, size, seeds)

import importlib.util
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, ".."))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cellgen = _load("drcfix_sg13g2", os.path.join(here, "../../layout-drc-fix/sg13g2/generate.py"))

import klayout.db as db  # noqa: E402

import block  # noqa: E402

PDK_ROOT = os.environ.get("PDK_ROOT", "/foss/pdks")
FILLER = os.path.join(PDK_ROOT, "ihp-sg13g2/libs.tech/klayout/tech/scripts/filler.py")


class SG13G2Block(cellgen.SG13G2):
    CELL = "idac"
    LAYERS = {
        **cellgen.SG13G2.LAYERS,
        "via2": (29, 0),
        "m3": (30, 0),
        "m3_pin": (30, 2),
        "m3_label": (30, 25),
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
    S_RAIL = (-600, -300)
    B_RAIL = (-1350, -1050)
    TAP_UX = 1100
    TAP_UY = -1590
    D_Y = 500
    D_RAIL_H = 350
    # Vias and pads: V1.a and V2.a 0.19 um.
    VIA = 190
    VIA2 = 190
    M1_PAD = 390
    M2_PAD = 390
    M3_PAD = 400
    STACK_DX = 400
    # Straps, buses, pins and the frame around the core (filled by the filler).
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
    FRAME = 100000
    RING_W = 2000
    # Seeds: M1.a 0.16, M1.b 0.18, M2.a / M3.a 0.20, M2.b / M3.b 0.21, M3.d 0.144 um2, grid 5 nm.
    SPUR_W = 200
    BAD_M1_W = 120
    BAD_M1_S = 120
    BAD_M2_W = 150
    BAD_M2_S = 150
    BAD_M3_W = 150
    BAD_M3_S = 150
    COMB_W = 300
    COMB_L = 1000
    OFFGRID = 2
    JUMPER_IN = 600
    JUMPER_W = 1000
    PAD_PITCH = 1000
    SMALL_M3_PAD = 370
    NECK_ROWS = 2
    NECK_PINS = ("o2", "outp")
    COMB_PIN = "o7"

    def spice_device(self, name, d, g, s, b):
        return f"{name} {d} {g} {s} {b} sg13_lv_nmos w=1u l=0.5u ng=1 m=1"

    def fill(self, src, ly, top):
        """Run the stock filler on the block src inside a temporary EdgeSeal ring on the block boundary, and copy
        the fill cells and their instances into the top cell of ly (the ring is not copied)."""
        with tempfile.TemporaryDirectory() as d:
            a, o = os.path.join(d, "in.gds"), os.path.join(d, "out.gds")
            ring = db.Region(src.boundary.enlarged(self.RING_W, self.RING_W)) - db.Region(src.boundary)
            ly2 = src.ly.dup()
            ly2.cell(src.top.cell_index()).shapes(ly2.layer(39, 0)).insert(ring)
            ly2.write(a)
            env = {**os.environ, "PDK": "ihp-sg13g2", "PATH": "/foss/tools/klayout:" + os.environ.get("PATH", "")}
            subprocess.run(["klayout", "-n", "sg13g2", "-zz", "-r", FILLER, "-rd", f"output_file={o}", a],
                           env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            out = db.Layout()
            out.read(o)
        otop = out.cell(src.top.name)
        cmap = {}
        for inst in otop.each_inst():
            child = out.cell(inst.cell_index)
            if not child.name.endswith("_FILL_CELL"):
                continue
            if child.name not in cmap:
                c = ly.create_cell(child.name)
                for li in out.layer_indexes():
                    info = out.get_info(li)
                    for sh in child.shapes(li).each():
                        c.shapes(ly.layer(info.layer, info.datatype)).insert(sh)
                cmap[child.name] = c.cell_index()
            ca = inst.cell_inst.dup()
            ca.cell_index = cmap[child.name]
            top.insert(ca)


if __name__ == "__main__":
    block.main(SG13G2Block(), sys.argv[1:])
