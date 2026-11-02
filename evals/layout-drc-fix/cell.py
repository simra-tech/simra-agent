# The cell of the layout tasks: an NMOS differential pair with a tail current mirror and a dummy device at each
# end of the pair. The same floor plan on each PDK; the per-PDK generate.py draws the devices, the substrate tap
# and gives the layers and the sizes.
#
# Floor plan (one row, left to right): tap, D1, M1, M2, D2, M4, M3.
#   M1, M2: the input pair (gates inp, inn; drains outn, outp; sources tail).
#   M3: the tail device (drain tail, gate ibias, source vss). M4: the diode of the mirror (drain and gate ibias).
#   D1, D2: dummy devices; all terminals on vss.
# The gate contacts are above the row. Each source and drain is a vertical Metal1 line down to a horizontal Metal2
# bus (tail, vss, ibias, from top to bottom), with a Via1 where it connects. The pins are Metal1 or Metal2 pads
# with a pin shape and a label.
#
# Variants:
#   clean:  no DRC markers; LVS matches cell.spice.
#   seeded: the clean cell with four routing shapes drawn wrong. The connectivity stays the same:
#           1. width:     the segment of the outp line above the outp pin is narrower than the Metal1 minimum width.
#           2. spacing:   the bridge of the vss bus is moved down, nearer to the ibias bus than the Metal2 minimum space.
#           3. enclosure: the Via1 of the M3 drain is moved to the edge of its Metal1 pad (Metal1 enclosure too small).
#           4. off-grid:  the inp line below the inp pin has an edge 1 nm off the manufacturing grid.
#   cheat:  the seeded cell without the four shapes. DRC is clean, but four connections are open, so LVS fails.

import hashlib

import klayout.db as db

VARIANTS = ("clean", "seeded", "cheat")
SEEDS = ("width", "spacing", "enclosure", "offgrid")
PINS = ("inp", "inn", "outp", "outn", "ibias", "vss")


def box(cell, layer, x1, y1, x2, y2):
    cell.shapes(layer).insert(db.Box(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))


class Router:
    """Draws the routing of the cell in dbu (1 nm). pdk gives the layers, the sizes and the device drawing."""

    def __init__(self, layout, top, pdk, variant):
        self.ly, self.top, self.pdk, self.variant = layout, top, pdk, variant
        self.L = {k: layout.layer(*v) for k, v in pdk.LAYERS.items()}

    def m1(self, *b):
        box(self.top, self.L["m1"], *b)

    def m2(self, *b):
        box(self.top, self.L["m2"], *b)

    def seed(self, name, clean, seeded):
        """Draw a routing shape that is a seed: the clean shape, the seeded shape or nothing (cheat)."""
        if self.variant == "clean":
            clean()
        elif self.variant == "seeded":
            seeded()

    def via(self, xc, yc, shift=0):
        """A Via1 at (xc, yc) with a Metal1 pad; the via can move by shift in x (the pad stays)."""
        p = self.pdk
        h = p.M1_PAD // 2
        self.m1(xc - h, yc - h, xc + h, yc + h)
        v = p.VIA // 2
        box(self.top, self.L["via1"], xc - v + shift, yc - v, xc + v + shift, yc + v)

    def pin(self, name, layer, xc, yc):
        """A pin pad on Metal1 or Metal2 at (xc, yc): the metal, the pin shape and the label."""
        h = self.pdk.PIN_PAD // 2
        box(self.top, self.L[layer], xc - h, yc - h, xc + h, yc + h)
        box(self.top, self.L[f"{layer}_pin"], xc - h, yc - h, xc + h, yc + h)
        self.top.shapes(self.L[f"{layer}_label"]).insert(db.Text(name, db.Trans(db.Point(xc, yc))))


def build(pdk, variant):
    """The layout of the cell for one variant: (layout, top cell)."""
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    ly = db.Layout()
    ly.dbu = 0.001
    top = ly.create_cell(pdk.CELL)
    r = Router(ly, top, pdk, variant)
    P = pdk.PITCH
    lw = pdk.LINE_W
    bus = pdk.BUS_H
    names = ["D1", "M1", "M2", "D2", "M4", "M3"]
    dev = {n: pdk.device(ly, top, i * P, n) for i, n in enumerate(names)}
    W = pdk.W
    # The Metal2 buses (centre y) and the pin rows.
    y_tail, y_vss, y_ib = -1200, -1200 - pdk.BUS_PITCH, -1200 - 2 * pdk.BUS_PITCH
    y_bot = y_ib - 1000
    xc = lambda s: (s[0] + s[1]) // 2

    def down(strip, y, extra=0):
        """A Metal1 line from the bottom of a source or drain strip down to y (and extra below)."""
        r.m1(strip[0], strip[2], strip[1], y - extra)

    # Dummies: one Metal1 shape over the gate contact and both strips; the left strip goes down to vss.
    for n in ("D1", "D2"):
        d = dev[n]
        g = d["g"]
        r.m1(d["s"][0], d["s"][2], d["d"][1], g[3])
        down(d["s"], y_vss)
        r.via(xc(d["s"]), y_vss)
        down(d["d"], y_vss)
        r.via(xc(d["d"]), y_vss)

    # Input pair: sources to tail, drains down to the out pins, gates up to the in pins.
    for n, gate, out in (("M1", "inp", "outn"), ("M2", "inn", "outp")):
        d = dev[n]
        down(d["s"], y_tail)
        r.via(xc(d["s"]), y_tail)
        g = d["g"]
        gx = (g[0] + g[2]) // 2
        y_pin = W + 2200
        r.pin(gate, "m1", gx, y_pin)
        if gate == "inp":
            # Seed 4 (off-grid): the line from the gate contact to the pin; in the seeded cell its right edge is 1 nm off.
            r.seed("offgrid", lambda: r.m1(gx - lw // 2, g[3], gx + lw // 2, y_pin), lambda: r.m1(gx - lw // 2, g[3], gx + lw // 2 + pdk.OFFGRID, y_pin))
        else:
            r.m1(gx - lw // 2, g[3], gx + lw // 2, y_pin)
        dx = xc(d["d"])
        if out == "outp":
            # Seed 1 (width): the segment from the drain line to the pin pad; narrower than the minimum when seeded.
            y_seg = y_ib - 300
            down(d["d"], y_seg)
            nw = pdk.NARROW
            r.seed("width", lambda: r.m1(d["d"][0], y_seg, d["d"][1], y_bot), lambda: r.m1(dx - nw // 2, y_seg, dx + nw // 2, y_bot))
        else:
            down(d["d"], y_bot)
        r.pin(out, "m1", dx, y_bot)

    # Mirror: M4 drain to the ibias bus, sources to vss, M3 drain to tail; the gates join on an ibias bar above the row,
    # which goes down on the right of M3 to the ibias bus.
    m4, m3 = dev["M4"], dev["M3"]
    down(m4["s"], y_vss)
    r.via(xc(m4["s"]), y_vss)
    down(m3["s"], y_vss)
    r.via(xc(m3["s"]), y_vss)
    down(m4["d"], y_ib)
    r.via(xc(m4["d"]), y_ib)
    down(m3["d"], y_tail)
    # Seed 3 (enclosure): the Via1 of the M3 drain; moved to the left edge of its pad when seeded.
    yc_tail = y_tail
    hp, hv = pdk.M1_PAD // 2, pdk.VIA // 2
    r.m1(xc(m3["d"]) - hp, yc_tail - hp, xc(m3["d"]) + hp, yc_tail + hp)
    via_box = lambda s: box(top, r.L["via1"], xc(m3["d"]) - hv + s, yc_tail - hv, xc(m3["d"]) + hv + s, yc_tail + hv)
    r.seed("enclosure", lambda: via_box(0), lambda: via_box(-pdk.VIA_SHIFT))
    x_side = m3["d"][1] + 700
    y_bar = max(m4["g"][3], m3["g"][3]) + 600
    for d in (m4, m3):
        g = d["g"]
        gx = (g[0] + g[2]) // 2
        r.m1(gx - lw // 2, g[3], gx + lw // 2, y_bar + lw)
    r.m1((m4["g"][0] + m4["g"][2]) // 2 - lw // 2, y_bar, x_side + lw, y_bar + lw)
    r.m1(x_side, y_ib, x_side + lw, y_bar + lw)
    r.via(x_side + lw // 2, y_ib)
    r.pin("ibias", "m1", x_side + lw // 2, y_bar + lw + 600)
    r.m1(x_side, y_bar, x_side + lw, y_bar + lw + 600)

    # The substrate tap, left of D1, down to the vss bus.
    tx = -pdk.TAP_X
    t = pdk.tap(ly, top, tx, 0)
    tc = (t[0] + t[2]) // 2
    r.m1(tc - lw // 2, t[1], tc + lw // 2, y_vss)
    r.via(tc, y_vss)

    # The buses. vss is in two parts with a bridge between M4 and M3 (seed 2, spacing: moved down when seeded).
    h = bus // 2
    x_m3s = xc(m3["s"])
    x_m4s = xc(m4["s"])
    r.m2(xc(dev["M1"]["s"]) - hp, y_tail - h, xc(m3["d"]) + hp, y_tail + h)
    r.m2(tc - hp, y_vss - h, x_m4s + hp, y_vss + h)
    r.m2(x_m3s - hp, y_vss - h, x_m3s + hp, y_vss + h)
    down_by = pdk.BUS_PITCH - bus - pdk.SPACE_SEEDED
    r.seed("spacing", lambda: r.m2(x_m4s, y_vss - h, x_m3s, y_vss + h), lambda: r.m2(x_m4s, y_vss - h - down_by, x_m3s, y_vss + h - down_by))
    r.m2(xc(m4["d"]) - hp, y_ib - h, x_side + lw // 2 + hp, y_ib + h)
    r.pin("vss", "m2", tc, y_vss)
    return ly, top


def write(pdk, variant, path):
    """Write the GDS of a variant (no time stamps, no context information) and return its SHA-256."""
    ly, top = build(pdk, variant)
    # One flat cell: the PCell instances become plain shapes, and the PCell variant cells are removed.
    top.flatten(True)
    opt = db.SaveLayoutOptions()
    opt.format = "GDS2"
    opt.gds2_write_timestamps = False
    opt.write_context_info = False
    opt.gds2_libname = pdk.CELL
    ly.write(path, opt)
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main(pdk, argv):
    import argparse

    ap = argparse.ArgumentParser(description=f"Write the GDS of the {pdk.CELL} cell.")
    ap.add_argument("--variant", choices=VARIANTS, required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    print(f"sha256 {write(pdk, a.variant, a.out)}")
