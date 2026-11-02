# The block of the layout block tasks: a binary-weighted current-source array with its bias and a differential
# input pair, in a hierarchy of four levels. The floor plan is the same on each PDK. The per-PDK generate.py gives
# the layers, the sizes, the seed sizes, the device drawing and the substrate tap (it reuses the device and the tap
# of ../layout-drc-fix/<pdk>/generate.py) and, on a PDK with a density check, the fill step.
#
# Hierarchy (cell names):
#   level 0  unit          one NMOS with its rails: gate (Metal1, top), drain (Metal2, with a Via1 on the drain),
#                          source (Metal1) and bulk (Metal1 over a substrate tap). The rails go across the full
#                          width of the cell, so the units of a row connect by abutment.
#   level 1  arr<R>x<C>    an array of R rows and C columns of unit, with four vertical Metal3 straps: gate, bulk and
#                          source on the left, drain on the right. A Via1/Via2 pair joins each rail to its strap.
#   level 2  csarray       the current-source array: branch k (k = 0..7) has 2^k * SCALE units; gate on nbias,
#                          source and bulk on vss, drain on the output o<k>.
#            bias          the diode of the mirror: gate and drain on nbias, source and bulk on vss.
#            diffpair      the input pair: two arrays (gate inp, drain outn; gate inn, drain outp; sources on tail)
#                          and the tail (gate nbias, drain tail, source vss).
#   level 3  the top       the three level-2 cells, the top-level Metal2 links of the buses vss and nbias, the Metal3
#                          lines to the pins, and the pins on the block boundary.
#
# Each level-2 cell has Metal2 buses: vss at the bottom, tail above it (diffpair only) and nbias above the arrays.
# The straps go down to vss or tail, or up to nbias, with a Via2 on the bus; a strap of a pin net goes up to the top
# edge of the core. The top cell joins the buses of the level-2 cells with Metal2 links, runs the bus vss and the
# bus nbias (pin ibias) to the left boundary, and runs a Metal3 line from each pin strap to the top boundary.
#
# Variants: clean, seeded and cheat. A seed draws a shape wrong without a change of the connectivity. The cheat
# variant is the seeded variant without the seeded shapes (a seed that is a necessary connection then leaves an
# open, and LVS fails). SEEDS lists the seeds: the cell, the kind and the count of seeded sites.

import hashlib

import klayout.db as db

VARIANTS = ("clean", "seeded", "cheat")

# The base branch shapes (rows, columns): 1, 2, 4 ... 128 units. The PDK scales them with SCALE = (a, b).
BASE_BRANCHES = [(1, 1), (1, 2), (2, 2), (2, 4), (4, 4), (4, 8), (8, 8), (8, 16)]

# The seeds: name -> (cell, kind, sites). The cell "pair" is the array cell of the two input devices (PAIR), and
# "top" is the top cell. The marker count of each rule is in expected.json (the deck counts).
SEEDS = {
    "unit_via1": ("unit", "Via1 on the drain without its Metal1 pad (enclosure 0)", 1),
    "unit_m1_spur": ("unit", "Metal1 spur on the gate rail too near the drain strip (spacing)", 1),
    "pair_rail_neck": ("pair", "narrow Metal1 rail from the gate strap to row r (width)", 2),
    "top_nbias_neck": ("top", "narrow Metal2 link of nbias between bias and csarray (width)", 1),
    "top_vss_comb": ("top", "comb of Metal2 spurs on the vss link (spacing)", 6),
    "top_nbias_offgrid": ("top", "Metal2 link of nbias between csarray and diffpair off the grid", 1),
    "top_jumper_via": ("top", "Via2 at the end of the Metal3 jumper of vss (enclosure)", 2),
    "top_dangling_pads": ("top", "small Metal3 pads on Via2 on the vss stub (minimum area)", 8),
    "top_pin_neck": ("top", "narrow Metal3 line to a pin (width)", 2),
    "top_pin_comb": ("top", "comb of Metal3 spurs on a pin line (spacing)", 5),
}


def box(cell, layer, x1, y1, x2, y2):
    cell.shapes(layer).insert(db.Box(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))


class Block:
    """Draws the block in dbu (1 nm). pdk gives the layers, the sizes and the device drawing."""

    def __init__(self, pdk, variant):
        if variant not in VARIANTS:
            raise ValueError(f"unknown variant {variant}")
        self.pdk, self.variant = pdk, variant
        self.ly = db.Layout()
        self.ly.dbu = 0.001
        self.L = {k: self.ly.layer(*v) for k, v in pdk.LAYERS.items()}
        self.cells = {}

    # Drawing helpers -------------------------------------------------------------------------------------------

    def b(self, cell, layer, *xy):
        box(cell, self.L[layer], *xy)

    def seed(self, clean, seeded):
        """Draw a seeded site: the clean drawing, the seeded drawing, or nothing (cheat)."""
        if self.variant == "clean":
            clean()
        elif self.variant == "seeded":
            seeded()

    def pad(self, cell, layer, xc, yc, size):
        h = size // 2
        self.b(cell, layer, xc - h, yc - h, xc + h, yc + h)

    def via1(self, cell, xc, yc):
        """A Via1 with a Metal1 and a Metal2 pad."""
        p = self.pdk
        self.pad(cell, "m1", xc, yc, p.M1_PAD)
        self.pad(cell, "via1", xc, yc, p.VIA)
        self.pad(cell, "m2", xc, yc, p.M2_PAD)

    def via2(self, cell, xc, yc):
        """A Via2 with a Metal2 and a Metal3 pad."""
        p = self.pdk
        self.pad(cell, "m2", xc, yc, p.M2_PAD)
        self.pad(cell, "via2", xc, yc, p.VIA2)
        self.pad(cell, "m3", xc, yc, p.M3_PAD)

    def stack(self, cell, xc, yc):
        """Metal1 to Metal3: a Via2 at (xc, yc) and a Via1 at the right of it, on one Metal2 pad."""
        p = self.pdk
        self.via2(cell, xc, yc)
        self.via1(cell, xc + p.STACK_DX, yc)
        self.b(cell, "m2", xc - p.M2_PAD // 2, yc - p.M2_PAD // 2, xc + p.STACK_DX + p.M2_PAD // 2, yc + p.M2_PAD // 2)

    def pin(self, cell, name, layer, x1, y1, x2, y2):
        """A pin: the metal, the pin shape and the label at the centre."""
        self.b(cell, layer, x1, y1, x2, y2)
        self.b(cell, f"{layer}_pin", x1, y1, x2, y2)
        cell.shapes(self.L[f"{layer}_label"]).insert(db.Text(name, db.Trans(db.Point((x1 + x2) // 2, (y1 + y2) // 2))))

    def comb(self, cell, layer, x0, y0, width, space, count, length, up=True):
        """count spurs of the given width, at the given space, from the edge y0 (up or down)."""
        for i in range(count):
            x = x0 + i * (width + space)
            self.b(cell, layer, x, y0, x + width, y0 + (length if up else -length))

    # Level 0: the unit ------------------------------------------------------------------------------------------

    def unit(self):
        if "unit" in self.cells:
            return self.cells["unit"]
        p, ly = self.pdk, self.ly
        c = ly.create_cell("unit")
        d = p.device(ly, c, p.UX, "M")
        c.flatten(True)
        P = p.UNIT_W
        s, dr, g = d["s"], d["d"], d["g"]
        # Gate rail across the cell, on the gate contact pad.
        self.b(c, "m1", 0, g[1], P, g[3])
        # Source: the strip goes down to the source rail.
        self.b(c, "m1", s[0], p.S_RAIL[0], s[1], s[2])
        self.b(c, "m1", 0, p.S_RAIL[0], P, p.S_RAIL[1])
        # Bulk: a substrate tap under the bulk rail.
        p.tap(ly, c, p.TAP_UX, p.TAP_UY)
        self.b(c, "m1", 0, p.B_RAIL[0], P, p.B_RAIL[1])
        # Drain: a Via1 on the drain strip, and the Metal2 drain rail across the cell.
        xd = (dr[0] + dr[1]) // 2
        self.b(c, "m2", 0, p.D_Y - p.D_RAIL_H // 2, P, p.D_Y + p.D_RAIL_H // 2)
        # Seed unit_via1: the Via1 without its Metal1 pad (the drain strip is narrower than the via).
        self.seed(lambda: (self.pad(c, "m1", xd, p.D_Y, p.M1_PAD), self.pad(c, "via1", xd, p.D_Y, p.VIA)),
                  lambda: (self.pad(c, "m1", xd, p.D_Y, p.VIA), self.pad(c, "via1", xd, p.D_Y, p.VIA)))
        # Seed unit_m1_spur: a Metal1 spur down from the gate rail, too near the top of the drain strip.
        self.seed(lambda: None,
                  lambda: self.b(c, "m1", xd - p.SPUR_W // 2, dr[3] + p.BAD_M1_S, xd + p.SPUR_W // 2, g[1]))
        self.cells["unit"] = c
        # The y ranges of the rails in the unit.
        self.rails = {"g": (g[1], g[3]), "s": p.S_RAIL, "b": p.B_RAIL}
        return c

    # Level 1: an array of units with its straps ------------------------------------------------------------------

    def array(self, rows, cols, neck_rows=0):
        """An array of rows x cols units. Straps (Metal3, vertical): gate, bulk and source on the left, drain on the
        right. Returns (cell, straps): straps maps g, s, b, d to the x centre of the strap. neck_rows: the count of
        rows (from row 0) with the seed pair_rail_neck on the gate rail."""
        name = f"arr{rows}x{cols}"
        if name in self.cells:
            return self.cells[name], self.straps(cols)
        p = self.pdk
        u = self.unit()
        c = self.ly.create_cell(name)
        P, RY = p.UNIT_W, p.ROW_H
        c.insert(db.CellInstArray(u.cell_index(), db.Trans(), db.Vector(P, 0), db.Vector(0, RY), cols, rows))
        st = self.straps(cols)
        y_lo, y_hi = self.strap_span(rows)
        for r in range(rows):
            y0 = r * RY
            # Rails out to the straps on the left; the drain rail out to the drain strap on the right.
            for k in ("g", "b", "s"):
                ry = self.rails[k]
                if k == "g" and r < neck_rows:
                    ym = y0 + (ry[0] + ry[1]) // 2
                    self.seed(lambda: self.b(c, "m1", st["g"], y0 + ry[0], 0, y0 + ry[1]),
                              lambda: self.b(c, "m1", st["g"], ym - p.BAD_M1_W // 2, 0, ym + p.BAD_M1_W // 2))
                else:
                    self.b(c, "m1", st[k], y0 + ry[0], 0, y0 + ry[1])
                self.stack(c, st[k], y0 + (ry[0] + ry[1]) // 2)
            yd = y0 + p.D_Y
            self.b(c, "m2", cols * P, yd - p.D_RAIL_H // 2, st["d"] + p.M2_PAD // 2, yd + p.D_RAIL_H // 2)
            self.via2(c, st["d"], yd)
        for k, x in st.items():
            self.b(c, "m3", x - p.STRAP_W // 2, y_lo, x + p.STRAP_W // 2, y_hi)
        self.cells[name] = c
        return c, st

    def straps(self, cols):
        p = self.pdk
        return {"s": -p.STRAP_PITCH, "b": -2 * p.STRAP_PITCH, "g": -3 * p.STRAP_PITCH, "d": cols * p.UNIT_W + p.STRAP_PITCH}

    def strap_span(self, rows):
        p = self.pdk
        return p.B_RAIL[0] - p.STRAP_EXT, (rows - 1) * p.ROW_H + self.rails["g"][1] + p.STRAP_EXT

    # Level 2: a group of arrays with its buses -------------------------------------------------------------------

    def levels(self, max_rows):
        """The y of the buses (centres) and of the top edge of the core; the same in each level-2 cell."""
        p = self.pdk
        lo = self.strap_span(1)[0]
        y = {"lo": lo}
        y["tail"] = lo - p.BUS_GAP - p.BUS_W // 2
        y["vss"] = y["tail"] - p.BUS_W - p.BUS_GAP
        y["nbias"] = self.strap_span(max_rows)[1] + p.BUS_GAP + p.BUS_W // 2
        y["edge"] = y["nbias"] + p.BUS_W // 2 + p.BUS_GAP
        return y

    def group(self, name, arrays):
        """A level-2 cell: arrays side by side. arrays: a list of (rows, cols, nets, neck_rows); nets maps g, s, b, d
        to vss, tail, nbias or a pin name. Returns (cell, width, pins): pins is a list of (pin name, x)."""
        p, Y = self.pdk, self.Y
        c = self.ly.create_cell(name)
        x = p.STRAP_W + p.STRAP_W // 2 - self.straps(1)["g"]
        pins, buses = [], {"vss"}
        for rows, cols, nets, neck in arrays:
            arr, st = self.array(rows, cols, neck)
            c.insert(db.CellInstArray(arr.cell_index(), db.Trans(db.Point(x, 0))))
            y_lo, y_hi = self.strap_span(rows)
            for k, net in nets.items():
                xs = x + st[k]
                w = p.STRAP_W // 2
                if net in ("vss", "tail"):
                    self.b(c, "m3", xs - w, Y[net], xs + w, y_lo)
                    self.via2(c, xs, Y[net])
                elif net == "nbias":
                    self.b(c, "m3", xs - w, y_hi, xs + w, Y[net])
                    self.via2(c, xs, Y[net])
                else:
                    self.b(c, "m3", xs - w, y_hi, xs + w, Y["edge"])
                    pins.append((net, xs))
                if net in ("vss", "tail", "nbias"):
                    buses.add(net)
            last_d = x + st["d"]
            x = last_d + p.ARRAY_GAP - st["g"]
        width = last_d + p.STRAP_W + p.STRAP_W // 2
        for net in sorted(buses):
            self.b(c, "m2", 0, Y[net] - p.BUS_W // 2, width, Y[net] + p.BUS_W // 2)
        self.cells[name] = c
        return c, width, pins

    # Level 3: the top ---------------------------------------------------------------------------------------------

    def build(self):
        p = self.pdk
        self.unit()
        a, b = p.SCALE
        branches = [(r * a, c * b) for r, c in BASE_BRANCHES]
        max_rows = max(r for r, _ in branches + [p.BIAS, p.PAIR, p.TAIL])
        self.Y = Y = self.levels(max_rows)
        # The diffpair arrays carry a seed: their shape must not be the shape of another array.
        assert p.PAIR not in branches + [p.BIAS, p.TAIL], "PAIR must differ from the other array shapes"
        vss = {"s": "vss", "b": "vss"}
        groups = [
            self.group("bias", [(*p.BIAS, {**vss, "g": "nbias", "d": "nbias"}, 0)]),
            self.group("csarray", [(r, c, {**vss, "g": "nbias", "d": f"o{k}"}, 0) for k, (r, c) in enumerate(branches)]),
            self.group("diffpair", [
                (*p.PAIR, {"g": "inp", "d": "outn", "s": "tail", "b": "vss"}, p.NECK_ROWS),
                (*p.PAIR, {"g": "inn", "d": "outp", "s": "tail", "b": "vss"}, p.NECK_ROWS),
                (*p.TAIL, {**vss, "g": "nbias", "d": "tail"}, 0),
            ]),
        ]
        top = self.ly.create_cell(p.CELL)
        x, spans, pins = 0, [], []
        for cell, width, gp in groups:
            top.insert(db.CellInstArray(cell.cell_index(), db.Trans(db.Point(x, 0))))
            spans.append((x, x + width))
            pins += [(n, x + xs) for n, xs in gp]
            x += width + p.GROUP_GAP
        H = p.BUS_W // 2
        # The core: the level-2 cells and the left stubs of the buses. The boundary: the core with the frame.
        core = db.Box(-p.LEFT, Y["vss"] - H - p.BUS_GAP, spans[-1][1] + p.BUS_GAP, Y["edge"])
        bnd = core.enlarged(p.FRAME, p.FRAME)
        bnd = db.Box(bnd.left, bnd.bottom, bnd.right, bnd.top + p.PIN_EXT)
        # Links of the buses between the level-2 cells (Metal2), with the seeds.
        (_, e0), (s1, e1), (s2, _) = spans
        self.b(top, "m2", e0, Y["vss"] - H, s1, Y["vss"] + H)
        # Seed top_vss_comb: Metal2 spurs on the top edge of the vss link, at a space below the minimum.
        ncomb = SEEDS["top_vss_comb"][2]
        cw = p.COMB_W
        cx = (e0 + s1) // 2 - (ncomb * cw + (ncomb - 1) * p.BAD_M2_S) // 2
        self.seed(lambda: None, lambda: self.comb(top, "m2", cx, Y["vss"] + H, cw, p.BAD_M2_S, ncomb, p.COMB_L))
        # Seed top_nbias_neck: the nbias link between bias and csarray is narrow.
        self.seed(lambda: self.b(top, "m2", e0, Y["nbias"] - H, s1, Y["nbias"] + H),
                  lambda: self.b(top, "m2", e0, Y["nbias"] - p.BAD_M2_W // 2, s1, Y["nbias"] + p.BAD_M2_W // 2))
        # Seed top_nbias_offgrid: the nbias link between csarray and diffpair is off the grid (it still overlaps the
        # buses).
        og = p.OFFGRID
        self.seed(lambda: self.b(top, "m2", e1, Y["nbias"] - H, s2, Y["nbias"] + H),
                  lambda: self.b(top, "m2", e1 - og, Y["nbias"] - H + og, s2 + og, Y["nbias"] + H - og))
        # The vss link between csarray and diffpair is a Metal3 jumper with a Via2 at each end.
        # Seed top_jumper_via: each Via2 sits at the end of the jumper (no Metal3 endcap enclosure).
        jx1, jx2 = e1 - p.JUMPER_IN, s2 + p.JUMPER_IN
        jh = p.JUMPER_W // 2
        self.b(top, "m3", jx1 - p.M3_PAD // 2, Y["vss"] - jh, jx2 + p.M3_PAD // 2, Y["vss"] + jh)
        v = p.VIA2 // 2
        for xv, sgn in ((jx1, -1), (jx2, 1)):
            self.pad(top, "m2", xv, Y["vss"], p.M2_PAD)
            xbad = xv + sgn * (p.M3_PAD // 2 - v)
            self.seed(lambda xv=xv: self.pad(top, "via2", xv, Y["vss"], p.VIA2),
                      lambda xb=xbad: self.pad(top, "via2", xb, Y["vss"], p.VIA2))
        # The stubs to the left boundary and the pins vss and ibias (Metal2).
        for net, name in (("vss", "vss"), ("nbias", "ibias")):
            self.b(top, "m2", bnd.left, Y[net] - H, 0, Y[net] + H)
            self.pin(top, name, "m2", bnd.left, Y[net] - H, bnd.left + p.PIN_H, Y[net] + H)
        # Seed top_dangling_pads: small Metal3 pads on Via2 on the vss stub (dead ends, no new connection).
        npad = SEEDS["top_dangling_pads"][2]
        for i in range(npad):
            xp = -p.LEFT + p.PIN_H + p.PAD_PITCH * (i + 1)
            self.seed(lambda: None,
                      lambda xp=xp: (self.pad(top, "via2", xp, Y["vss"], p.VIA2),
                                     self.pad(top, "m3", xp, Y["vss"], p.SMALL_M3_PAD)))
        # The Metal3 lines from the pin straps to the top boundary, and the pins (Metal3).
        w = p.STRAP_W // 2
        neck = {n for n in p.NECK_PINS}
        for name, xs in pins:
            if name in neck:
                # Seed top_pin_neck: the line is narrow from the core edge to the pin.
                self.seed(lambda xs=xs: self.b(top, "m3", xs - w, Y["edge"], xs + w, bnd.top - p.PIN_H),
                          lambda xs=xs: self.b(top, "m3", xs - p.BAD_M3_W // 2, Y["edge"], xs + p.BAD_M3_W // 2,
                                               bnd.top - p.PIN_H))
            else:
                self.b(top, "m3", xs - w, Y["edge"], xs + w, bnd.top - p.PIN_H)
            if name == p.COMB_PIN:
                # Seed top_pin_comb: Metal3 spurs on the right edge of the line, at a space below the minimum.
                n = SEEDS["top_pin_comb"][2]
                y0 = Y["edge"] + p.BUS_GAP
                self.seed(lambda: None,
                          lambda xs=xs, y0=y0: [self.b(top, "m3", xs + w, y0 + i * (p.COMB_W + p.BAD_M3_S), xs + w + p.COMB_L,
                                                       y0 + i * (p.COMB_W + p.BAD_M3_S) + p.COMB_W) for i in range(n)])
            self.pin(top, name, "m3", xs - w, bnd.top - p.PIN_H, xs + w, bnd.top)
        self.top, self.boundary = top, bnd
        self.devices = sum(r * c for r, c in branches) + p.BIAS[0] * p.BIAS[1] + 2 * p.PAIR[0] * p.PAIR[1] + p.TAIL[0] * p.TAIL[1]
        return self.ly, top


def write(pdk, variant, path):
    """Write the GDS of a variant (no time stamps, no context information) and return its SHA-256. On a PDK with a
    fill step (pdk.fill), the fill of the clean variant comes from the clean block, and the fill of the seeded and the
    cheat variants comes from the seeded block (the cheat removes only the seeded shapes)."""
    blk = Block(pdk, variant)
    ly, top = blk.build()
    if getattr(pdk, "fill", None):
        src = blk if variant != "cheat" else Block(pdk, "seeded")
        if src is not blk:
            src.build()
        pdk.fill(src, ly, top)
    opt = db.SaveLayoutOptions()
    opt.format = "GDS2"
    opt.gds2_write_timestamps = False
    opt.write_context_info = False
    opt.gds2_libname = pdk.CELL
    ly.write(path, opt)
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def spice(pdk):
    """The hierarchical reference netlist: one subcircuit per cell of the layout."""
    blk = Block(pdk, "clean")
    blk.build()
    a, b = pdk.SCALE
    branches = [(r * a, c * b) for r, c in BASE_BRANCHES]
    out = [f"* {pdk.CELL}: binary-weighted NMOS current-source array (8 branches) with its bias diode and a",
           "* differential input pair with a tail source. Hierarchy: unit, arr<R>x<C>, csarray / bias / diffpair, top.",
           f"* Devices: {blk.devices}.", ""]
    out += [".subckt unit d g s b", pdk.spice_device("M1", "d", "g", "s", "b"), ".ends unit", ""]
    shapes = sorted(set(branches + [pdk.BIAS, pdk.PAIR, pdk.TAIL]))
    for r, c in shapes:
        out.append(f".subckt arr{r}x{c} d g s b")
        out += [f"X{i} d g s b unit" for i in range(r * c)]
        out += [f".ends arr{r}x{c}", ""]
    out.append(".subckt csarray " + " ".join(f"o{k}" for k in range(8)) + " nbias vss")
    out += [f"X{k} o{k} nbias vss vss arr{r}x{c}" for k, (r, c) in enumerate(branches)]
    out += [".ends csarray", ""]
    r, c = pdk.BIAS
    out += [".subckt bias nbias vss", f"X1 nbias nbias vss vss arr{r}x{c}", ".ends bias", ""]
    (r, c), (rt, ct) = pdk.PAIR, pdk.TAIL
    out += [".subckt diffpair inp inn outp outn nbias vss", f"X1 outn inp tail vss arr{r}x{c}",
            f"X2 outp inn tail vss arr{r}x{c}", f"X3 tail nbias vss vss arr{rt}x{ct}", ".ends diffpair", ""]
    pins = " ".join(PINS)
    out += [f".subckt {pdk.CELL} {pins}", "X1 ibias vss bias",
            "X2 " + " ".join(f"o{k}" for k in range(8)) + " ibias vss csarray",
            "X3 inp inn outp outn ibias vss diffpair", f".ends {pdk.CELL}", ""]
    return "\n".join(out)


PINS = ["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7", "inp", "inn", "outp", "outn", "ibias", "vss"]


def info(pdk):
    """The facts of the block: the top cell, the pins, the device count, the levels of the hierarchy, the size of the
    boundary (um) and the seeds (with the real cell names)."""
    blk = Block(pdk, "clean")
    ly, top = blk.build()
    cell = {"pair": "arr{}x{}".format(*pdk.PAIR), "top": pdk.CELL}
    bnd = blk.boundary
    return {
        "cell": pdk.CELL,
        "pins": PINS,
        "devices": blk.devices,
        "levels": 4,
        "size_um": [round(bnd.width() * ly.dbu, 3), round(bnd.height() * ly.dbu, 3)],
        "seeds": {k: {"cell": cell.get(c, c), "kind": kind, "sites": n} for k, (c, kind, n) in SEEDS.items()},
    }


def main(pdk, argv):
    import argparse
    import json

    ap = argparse.ArgumentParser(description=f"Write the GDS (or the reference netlist) of the {pdk.CELL} block.")
    ap.add_argument("--variant", choices=VARIANTS)
    ap.add_argument("--out")
    ap.add_argument("--spice", action="store_true", help="write the reference netlist block.spice")
    ap.add_argument("--info", action="store_true", help="print the facts of the block as JSON")
    a = ap.parse_args(argv)
    if a.info:
        print(json.dumps(info(pdk)))
        return
    if not a.out:
        ap.error("--out is required")
    if a.spice:
        with open(a.out, "w") as f:
            f.write(spice(pdk))
        return
    if not a.variant:
        ap.error("--variant is required")
    print(f"sha256 {write(pdk, a.variant, a.out)}")
