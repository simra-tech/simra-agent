# The variants of the layout-stale-state task: the block of layout-block-fix (../layout-block-fix/block.py), before
# and after the commit of another designer. The per-PDK generate.py gives the PDK (the class of
# ../layout-block-fix/<pdk>/generate.py) and the sizes of the new seed.
#
# Variants:
#   v1-seeded  the input: the seeded block of layout-block-fix (all ten seeds). Its hash is the hash of
#              layout-block-fix/<pdk>/block-seeded.gds.
#   v2-seeded  the commit of the colleague, from the same hierarchy:
#              (a) the seeds in FIXED (two rules of v1) are fixed: they have their clean drawing;
#              (b) a new seed, top_via2_pairs: pairs of Via2 too near each other on the vss link between bias and
#                  csarray (spacing), with their Metal2 and Metal3 pads;
#              (c) the change to keep: the ibias stub (Metal2, from the left boundary to the core) is wider, by
#                  WIDEN below its old bottom edge. LVS sees no device change.
#   v2-clean   the clean block with the change (c), and the clean drawing of the new seed (the same pairs at a legal
#              spacing): the reference of the kept check. 0 markers, LVS match.
#   v1-clean   the clean block of layout-block-fix (no change (c)): a block that lost the change of the colleague.
#              The kept check must fail on it.
#
# On a PDK with a fill step (IHP), the fill of each variant comes from that variant (as in block.py).
#
# Usage (in the environment image):
#   python3 generate.py --variant <v1-seeded|v2-seeded|v2-clean|v1-clean> --out <gds>   (prints the SHA-256)
#   python3 generate.py --info   (prints the facts of the change and of the new seed as JSON)

import hashlib
import os
import sys

import klayout.db as db

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../layout-block-fix"))

import block  # noqa: E402

VARIANTS = ("v1-seeded", "v2-seeded", "v2-clean", "v1-clean")

# The seeds of v1 that the colleague fixes in v2 (their rules have no markers in v2).
FIXED = ("top_vss_comb", "top_pin_comb")

# The new seed of v2: name -> (cell, kind, sites).
NEW_SEED = {"top_via2_pairs": ("top", "pairs of Via2 too near each other on the vss link (spacing)", 4)}

# The change of the colleague: the bus and its new width, for the commit message and the README.
CHANGE = "the ibias stub (Metal2) from the left boundary to the core is wider, below its old bottom edge"


class StaleBlock(block.Block):
    """The block with the options of the stale-state variants. base: the variant of block.py (clean or seeded).
    fixed: seeds of block.py that get their clean drawing in a seeded block. pairs: draw the new seed (seeded: at the
    bad spacing; clean: at a legal spacing). widen: draw the change of the colleague."""

    def __init__(self, pdk, base, fixed=(), pairs=False, widen=False):
        super().__init__(pdk, base)
        self.fixed, self.pairs, self.widen = set(fixed), pairs, widen

    def seed(self, clean, seeded, name=None):
        if name in self.fixed and self.variant == "seeded":
            clean()
            return
        super().seed(clean, seeded, name)

    def build(self):
        ly, top = super().build()
        p, Y, H = self.pdk, self.Y, self.pdk.BUS_W // 2
        if self.widen:
            box = self.change_box()
            self.b(top, "m2", box.left, box.bottom, box.right, box.top)
        if self.pairs:
            e0, s1 = self.gap()
            space = p.BAD_V2_S if self.variant == "seeded" else p.GOOD_V2_S
            n = NEW_SEED["top_via2_pairs"][2]
            v, m = p.VIA2, p.PAIR_ENC
            for i in range(n):
                xc = (e0 + s1) // 2 + (i - (n - 1) / 2) * p.PAIR_PITCH
                xc = int(round(xc / 5)) * 5
                x1 = xc - space // 2 - v
                x2 = xc + space // 2 + v
                for x in (x1 + v // 2, x2 - v // 2):
                    self.pad(top, "via2", x, Y["vss"], v)
                self.b(top, "m3", x1 - m, Y["vss"] - v // 2 - m, x2 + m, Y["vss"] + v // 2 + m)
        return ly, top

    def change_box(self):
        """The Metal2 box of the change: the strip below the old ibias stub, from the left boundary to BUS_GAP before the
        core."""
        p, Y, H = self.pdk, self.Y, self.pdk.BUS_W // 2
        return db.Box(self.boundary.left, Y["nbias"] - H - p.WIDEN, -p.BUS_GAP, Y["nbias"] - H)

    def gap(self):
        """The x range of the vss link between bias and csarray (the right edge of bias, the left edge of csarray)."""
        x = {}
        for inst in self.top.each_inst():
            name = self.ly.cell(inst.cell_index).name
            if name in ("bias", "csarray"):
                x[name] = (inst.bbox().left, inst.bbox().right)
        return x["bias"][1], x["csarray"][0]


def make(pdk, variant):
    if variant == "v1-seeded":
        return StaleBlock(pdk, "seeded")
    if variant == "v2-seeded":
        return StaleBlock(pdk, "seeded", fixed=FIXED, pairs=True, widen=True)
    if variant == "v2-clean":
        return StaleBlock(pdk, "clean", pairs=True, widen=True)
    if variant == "v1-clean":
        return StaleBlock(pdk, "clean")
    raise ValueError(f"unknown variant {variant}")


def write(pdk, variant, path):
    """Write the GDS of a variant (no time stamps, no context information) and return its SHA-256. The fill (IHP)
    comes from the variant itself."""
    blk = make(pdk, variant)
    ly, top = blk.build()
    if getattr(pdk, "fill", None):
        pdk.fill(blk, ly, top)
    opt = db.SaveLayoutOptions()
    opt.format = "GDS2"
    opt.gds2_write_timestamps = False
    opt.write_context_info = False
    opt.gds2_libname = pdk.CELL
    ly.write(path, opt)
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def info(pdk):
    """The facts of the stale-state variants: the change (its layer, its box in um, and the check box: the change box
    enlarged by CHECK_MARGIN), the seeds that the colleague fixes, and the new seed."""
    blk = make(pdk, "v2-clean")
    ly, _ = blk.build()
    um = lambda b: [round(c * ly.dbu, 3) for c in (b.left, b.bottom, b.right, b.top)]  # noqa: E731
    box = blk.change_box()
    layer = list(pdk.LAYERS["m2"])
    e0, s1 = blk.gap()
    return {
        "cell": pdk.CELL,
        "change": {
            "what": CHANGE,
            "layer": layer,
            "box_um": um(box),
            "check_box_um": um(box.enlarged(pdk.CHECK_MARGIN, pdk.CHECK_MARGIN)),
            "widen_um": round(pdk.WIDEN * ly.dbu, 3),
            "bus_width_um": [round(pdk.BUS_W * ly.dbu, 3), round((pdk.BUS_W + pdk.WIDEN) * ly.dbu, 3)],
        },
        "fixed_seeds": list(FIXED),
        "new_seed": {k: {"cell": pdk.CELL, "kind": kind, "sites": n, "x_um": [round(e0 * ly.dbu, 3), round(s1 * ly.dbu, 3)]}
                     for k, (_, kind, n) in NEW_SEED.items()},
    }


def main(pdk, argv):
    import argparse
    import json

    ap = argparse.ArgumentParser(description=f"Write a stale-state variant of the {pdk.CELL} block.")
    ap.add_argument("--variant", choices=VARIANTS)
    ap.add_argument("--out")
    ap.add_argument("--info", action="store_true")
    a = ap.parse_args(argv)
    if a.info:
        print(json.dumps(info(pdk)))
        return
    if not a.variant or not a.out:
        ap.error("--variant and --out are required")
    print(f"sha256 {write(pdk, a.variant, a.out)}")
