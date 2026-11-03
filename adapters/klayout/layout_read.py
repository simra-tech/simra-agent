"""Read operations of the klayout adapter: "query" (questions about one layout).

They use the KLayout Python module klayout.db in the adapter process; they start no external command. The layer
names come from the KLayout layer properties file (.lyp) that the technology pack names in
klayout.<pdk>.layer_properties. This file has no layer names and no other PDK facts.

All coordinates of the questions and the answers are in µm, in the coordinates of the top cell, unless a row says
otherwise. A box is [x1, y1, x2, y2]; a point [x, y] is a box of zero size. A layer is a name of the layer
properties file (for example Metal1 or Metal1.drawing) or layer/datatype (for example 8/0).
"""

import difflib
import os
import re
import time
import xml.etree.ElementTree as ET

MAX_REPORT = 200
MAX_JSON = 10000
SOURCE = re.compile(r"(\d+)\s*/\s*(\d+)")
LAYER_DATATYPE = re.compile(r"^\s*(\d+)\s*/\s*(\d+)\s*$")
NAME_SUFFIX = re.compile(r"\s+-\s+\d+\s*/\s*\d+\s*$")
DRAWING = ".drawing"
KINDS = ("layers", "cells", "shapes", "instances", "at", "bbox", "texts", "distance")
ARGS = {"layers": (), "cells": ("depth",), "shapes": ("layer", "box", "max"), "instances": ("box", "max"),
        "at": ("box", "max"), "bbox": ("layer", "cell"), "texts": ("layer", "box", "max"),
        "distance": ("layer", "box_a", "box_b")}
MAX_EDGE_PAIRS = 4000000


class QueryError(Exception):
    """A bad argument of one question: the question gets an error, the others are still answered."""


def klayout_db():
    """The module klayout.db, or None when it is not installed."""
    try:
        import klayout.db as db  # noqa: PLC0415
    except ImportError:
        return None
    return db


# ---------------------------------------------------------------- layer names

def normalise_name(name):
    """The name of a .lyp entry without the suffix ' - 68/20' (SKY130) and without the purpose '.drawing' (IHP)."""
    name = NAME_SUFFIX.sub("", name.strip())
    return name[:-len(DRAWING)] if name.endswith(DRAWING) and len(name) > len(DRAWING) else name


def read_layer_properties(path):
    """{(layer, datatype): name} from the <name> and <source> elements of a KLayout layer properties file."""
    names = {}
    for entry in ET.parse(path).getroot().iter("properties"):
        name, source = entry.findtext("name"), entry.findtext("source")
        m = SOURCE.search(source or "")
        if name and name.strip() and m:
            names.setdefault((int(m.group(1)), int(m.group(2))), normalise_name(name))
    return names


class LayerNames:
    """The layer names of one PDK. A question can give a name with or without '.drawing', in any case when the name
    is unique, or layer/datatype."""

    def __init__(self, names=None):
        self.names = dict(names or {})
        self.aliases = {}
        for key, name in self.names.items():
            for alias in (name, name + DRAWING) if "." not in name else (name,):
                self.aliases.setdefault(alias, key)
        self.lower = {}
        for alias, key in self.aliases.items():
            self.lower.setdefault(alias.lower(), set()).add(key)

    def resolve(self, text):
        """(layer, datatype) of a layer argument, or raise QueryError."""
        if isinstance(text, (list, tuple)) and len(text) == 2 and all(isinstance(v, int) for v in text):
            return int(text[0]), int(text[1])
        if not isinstance(text, str) or not text.strip():
            raise QueryError("'layer' must be a layer name or layer/datatype, for example 8/0")
        m = LAYER_DATATYPE.match(text)
        if m:
            return int(m.group(1)), int(m.group(2))
        if text in self.aliases:
            return self.aliases[text]
        keys = self.lower.get(text.lower())
        if keys and len(keys) == 1:
            return next(iter(keys))
        if not self.names:
            raise QueryError("unknown layer '{}': the layer names are not known (see the warning); give layer/datatype, "
                             "for example 8/0".format(text))
        close = difflib.get_close_matches(text, sorted(set(self.names.values())), n=4, cutoff=0.5)
        raise QueryError("unknown layer '{}'{}; give a name of the layer properties file or layer/datatype".format(
            text, " (close names: {})".format(", ".join(close)) if close else ""))

    def label(self, key):
        """'Metal1 8/0', or '8/0' for a layer that the file does not name."""
        ld = "{}/{}".format(*key)
        return "{} {}".format(self.names[key], ld) if key in self.names else ld


# ---------------------------------------------------------------- formats

def f3(x):
    text = "{:.3f}".format(x)
    return "0.000" if text == "-0.000" else text


def box_text(box, dbu):
    """(x1,y1;x2,y2) in µm with 3 decimals, from a box in database units."""
    if box.empty():
        return "empty"
    return "({},{};{},{})".format(f3(box.left * dbu), f3(box.bottom * dbu), f3(box.right * dbu), f3(box.top * dbu))


def box_um(box, dbu):
    return None if box.empty() else [round(box.left * dbu, 6), round(box.bottom * dbu, 6), round(box.right * dbu, 6),
                                     round(box.top * dbu, 6)]


def point_text(x, y, dbu):
    return "({},{})".format(f3(x * dbu), f3(y * dbu))


def area_um2(region_area, dbu):
    return region_area * dbu * dbu


def edge_text(e, dbu):
    return "({},{};{},{})".format(f3(e.p1.x * dbu), f3(e.p1.y * dbu), f3(e.p2.x * dbu), f3(e.p2.y * dbu))


def trans_text(t, dbu):
    """'(x,y) r90' and ' mx' for a mirror (KLayout: mirror at the x axis, then rotate), ' mag=2' for a magnification."""
    text = "{} r{:g}".format(point_text(t.disp.x, t.disp.y, dbu), t.angle)
    if t.is_mirror():
        text += " mx"
    if abs(t.mag - 1) > 1e-9:
        text += " mag={:g}".format(t.mag)
    return text


def trans_json(t, dbu):
    return {"x": round(t.disp.x * dbu, 6), "y": round(t.disp.y * dbu, 6), "rotation": t.angle, "mirror": t.is_mirror(),
            "mag": t.mag}


def polygon_text(poly, dbu):
    """box (..) for a rectangle, polygon <n> pts (..;..) for up to 8 points, else polygon <n> pts bbox (..)."""
    if poly.is_box():
        return "box " + box_text(poly.bbox(), dbu)
    points = list(poly.each_point_hull())
    n = poly.num_points()
    if n <= 8 and not poly.holes():
        return "polygon {} pts ({})".format(n, ";".join("{},{}".format(f3(p.x * dbu), f3(p.y * dbu)) for p in points))
    return "polygon {} pts{} bbox {}".format(n, " {} holes".format(poly.holes()) if poly.holes() else "",
                                            box_text(poly.bbox(), dbu))


# ---------------------------------------------------------------- arguments

def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_box(db, value, name, dbu):
    """A box argument in µm ([x1, y1, x2, y2] or a point [x, y]) as a db.Box in database units."""
    if isinstance(value, list) and len(value) in (2, 4) and all(number(v) for v in value):
        if len(value) == 2:
            value = [value[0], value[1], value[0], value[1]]
        x1, y1, x2, y2 = value
        return db.DBox(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)).to_itype(dbu)
    raise QueryError("'{}' must be [x1, y1, x2, y2] or a point [x, y], in µm".format(name))


def parse_max(q, default=20):
    value = q.get("max", default)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise QueryError("'max' must be an integer of 0 or more")
    return value


def required(q, name):
    if q.get(name) is None:
        raise QueryError("'{}' is required".format(name))
    return q[name]


# ---------------------------------------------------------------- one layout

class Layout:
    """One layout file and its top cell, with the flat instance count of each cell of the tree."""

    def __init__(self, db, path, cell, names):
        self.db, self.names = db, names
        self.ly = db.Layout()
        self.ly.read(path)
        self.dbu = self.ly.dbu
        self.top = self.ly.cell(cell) if isinstance(cell, str) else None
        if self.top is None:
            tops = ", ".join(sorted(c.name for c in self.ly.top_cells())) or "none"
            raise QueryError("the layout has no cell '{}' (its top cells: {})".format(cell, tops))
        self.flat = self.flat_counts()
        self.tree = set(self.flat)
        self.keys = {}
        for li in self.ly.layer_indexes():
            info = self.ly.get_info(li)
            self.keys[(info.layer, info.datatype)] = li
        self.hierarchical = self.is_hierarchical()
        self.dss = None

    def flat_counts(self):
        """{cell index: the number of its flat instances under the top cell} (the top cell has 1)."""
        counts = {self.top.cell_index(): 1}
        for ci in self.ly.each_cell_top_down():
            n = counts.get(ci)
            if not n:
                continue
            for inst in self.ly.cell(ci).each_inst():
                counts[inst.cell_index] = counts.get(inst.cell_index, 0) + n * inst.size()
        return counts

    def is_hierarchical(self):
        """True when the flat shape count is more than twice the stored count: then the deep (hierarchical) mode of
        klayout.db is faster for the whole-layout operations."""
        stored = flat = 0
        for ci, n in self.flat.items():
            cell = self.ly.cell(ci)
            for li in self.ly.layer_indexes():
                size = cell.shapes(li).size()
                stored += size
                flat += n * size
        return flat > 2 * stored

    def cell_name(self, ci):
        return self.ly.cell(ci).name

    def layer_index(self, key):
        return self.keys.get(key)

    def resolve(self, text):
        """(key, layer index or None when the layout has no such layer)."""
        key = self.names.resolve(text)
        return key, self.layer_index(key)

    def region(self, li, box=None, dss=None):
        """The merged region of a layer, flat from the top cell; clipped to box when it is given."""
        db = self.db
        if li is None:
            return db.Region()
        if box is None:
            it = self.top.begin_shapes_rec(li)
            return db.Region(it, dss) if dss is not None else db.Region(it)
        r = db.Region(self.top.begin_shapes_rec_touching(li, box))
        return r & db.Region(box)

    def path_text(self, path):
        """The cell path of an iterator path below the top cell (branch/unit, with [a,b] for an array member), or the
        name of the top cell for an empty path."""
        parts = []
        for e in path:
            name = self.cell_name(e.cell_inst().cell_index)
            if e.cell_inst().is_regular_array():
                name += "[{},{}]".format(e.ia(), e.ib())
            parts.append(name)
        return "/".join(parts) if parts else self.top.name


# ---------------------------------------------------------------- questions

def q_layers(L, q):
    db, ly = L.db, L.ly
    rows, data = [], []
    for key in sorted(L.keys):
        li = L.keys[key]
        count = sum(n * ly.cell(ci).shapes(li).size() for ci, n in L.flat.items())
        if not count:
            continue
        dss = db.DeepShapeStore() if L.hierarchical else None
        area = area_um2(L.region(li, dss=dss).area(), L.dbu)
        rows.append("  {}  shapes={}  area={}".format(L.names.label(key), count, f3(area)))
        data.append({"layer": L.names.label(key), "layer_datatype": "{}/{}".format(*key), "name": L.names.names.get(key),
                     "shapes": count, "area_um2": round(area, 6)})
    head = "layers: {} layers with shapes, {} shapes (flat)".format(len(data), sum(d["shapes"] for d in data))
    return head, rows, {"layers": data}


def q_cells(L, q):
    depth = q.get("depth", 2)
    if not isinstance(depth, int) or isinstance(depth, bool) or depth < 0:
        raise QueryError("'depth' must be an integer of 0 or more")
    ly = L.ly
    rows, data, seen = [], [], set()

    def own_shapes(cell):
        return sum(cell.shapes(li).size() for li in ly.layer_indexes())

    def visit(ci, level, path):
        if ci in seen:
            return
        seen.add(ci)
        cell = ly.cell(ci)
        row = {"cell": cell.name, "depth": level, "path": "/".join(path), "flat_instances": L.flat[ci],
               "bbox_um": box_um(cell.bbox(), L.dbu), "own_shapes": own_shapes(cell)}
        data.append(row)
        if level <= depth:
            rows.append("  {}{}  flat={}  bbox={}  own_shapes={}".format(
                "  " * level, cell.name, L.flat[ci], box_text(cell.bbox(), L.dbu), row["own_shapes"]))
        for child in sorted(set(i.cell_index for i in cell.each_inst()), key=L.cell_name):
            visit(child, level + 1, path + [L.cell_name(child)])

    visit(L.top.cell_index(), 0, [])
    listed = sum(1 for d in data if d["depth"] <= depth)
    more = len(data) - listed
    if more:
        below = sum(d["flat_instances"] for d in data if d["depth"] > depth)
        rows.append("  ... {} more cells below depth {} ({} flat instances)".format(more, depth, below))
    head = "cells: {} cells in the tree of {}, {} listed (depth {}; bbox in the coordinates of each cell)".format(
        len(data), L.top.name, listed, depth)
    return head, rows, {"cells": data, "depth": depth}


def overlap_area(db, poly, box):
    if box.width() == 0 or box.height() == 0:
        return 0
    if poly.is_box():
        b = poly.bbox() & box
        return 0 if b.empty() else b.area()
    return (db.Region(poly) & db.Region(box)).area()


def q_shapes(L, q):
    db = L.db
    key, li = L.resolve(required(q, "layer"))
    box = parse_box(db, required(q, "box"), "box", L.dbu)
    limit = parse_max(q)
    label = L.names.label(key)
    found = []
    if li is not None:
        it = L.top.begin_shapes_rec_touching(li, box)
        it.shape_flags = db.Shapes.SAll & ~db.Shapes.STexts
        while not it.at_end():
            poly = it.shape().polygon
            if poly is not None:
                poly = poly.transformed(it.trans())
                found.append((overlap_area(db, poly, box), poly.area(), poly, L.path_text(it.path())))
            it.next()
    found.sort(key=lambda f: (-f[0], -f[1], f[2].bbox().left, f[2].bbox().bottom))
    merged = area_um2(L.region(li, box).area(), L.dbu) if li is not None else 0.0
    rows = ["  {}  overlap={}  cell={}".format(polygon_text(p, L.dbu), f3(area_um2(ov, L.dbu)), path)
            for ov, _, p, path in found[:limit]]
    if len(found) > limit:
        rows.append("  ... {} more shapes".format(len(found) - limit))
    head = "shapes {} touching {}: {} shapes, merged area in box {}{}".format(
        label, box_text(box, L.dbu), len(found), f3(merged), "" if li is not None else " (the layout has no such layer)")
    return head, rows, {"layer": label, "box_um": box_um(box, L.dbu), "count": len(found), "merged_area_um2": round(merged, 6),
                        "shapes": [{"bbox_um": box_um(p.bbox(), L.dbu), "points_um": [[round(pt.x * L.dbu, 6), round(pt.y * L.dbu, 6)]
                                                                                     for pt in p.each_point_hull()],
                                    "overlap_um2": round(area_um2(ov, L.dbu), 6), "cell_path": path}
                                   for ov, _, p, path in found[:MAX_JSON]]}


def touching_instances(L, box, deepest=False):
    """The instances of the tree of the top cell whose bounding box touches box, each array member on its own:
    [{path, cell, trans (ICplxTrans to the top), bbox (top coordinates), depth}]. With deepest, only the instances
    that have no child instance that touches box."""
    db = L.db
    it = db.RecursiveInstanceIterator(L.ly, L.top, box)
    out = []
    while not it.at_end():
        cell = it.inst_cell()
        t = it.trans() * it.inst_trans()
        element = it.current_inst_element()
        path = list(it.path()) + [element]
        out.append({"path": L.path_text(path), "cell": cell.name, "trans": t, "bbox": cell.bbox().transformed(t),
                    "depth": len(path)})
        it.next()
    if deepest:
        parents = {o["path"].rsplit("/", 1)[0] for o in out if "/" in o["path"]}
        out = [o for o in out if o["path"] not in parents]
    out.sort(key=lambda o: (o["depth"], -o["bbox"].area(), o["bbox"].left, o["bbox"].bottom, o["path"]))
    return out


def instance_row(L, o):
    return "  {}  {}  {}  bbox={}".format(o["cell"], o["path"], trans_text(o["trans"], L.dbu), box_text(o["bbox"], L.dbu))


def instance_json(L, o):
    return {"cell": o["cell"], "path": o["path"], "trans": trans_json(o["trans"], L.dbu), "bbox_um": box_um(o["bbox"], L.dbu)}


def q_instances(L, q):
    box = parse_box(L.db, required(q, "box"), "box", L.dbu)
    limit = parse_max(q)
    found = touching_instances(L, box)
    rows = [instance_row(L, o) for o in found[:limit]]
    if len(found) > limit:
        rows.append("  ... {} more instances".format(len(found) - limit))
    head = "instances touching {}: {} instances (cell, path, placement in the top cell, bbox)".format(
        box_text(box, L.dbu), len(found))
    return head, rows, {"box_um": box_um(box, L.dbu), "count": len(found),
                        "instances": [instance_json(L, o) for o in found[:MAX_JSON]]}


def collect_texts(L, li_list, box):
    db = L.db
    out = []
    for key, li in li_list:
        it = L.top.begin_shapes_rec_touching(li, box) if box is not None else L.top.begin_shapes_rec(li)
        it.shape_flags = db.Shapes.STexts
        while not it.at_end():
            text = it.shape().text.transformed(it.trans())
            out.append({"text": text.string, "layer": L.names.label(key), "x": text.x, "y": text.y,
                        "cell_path": L.path_text(it.path())})
            it.next()
    out.sort(key=lambda t: (t["text"], t["layer"], t["x"], t["y"]))
    return out


def text_row(L, t):
    return '  "{}"  {}  {}  cell={}'.format(t["text"], t["layer"], point_text(t["x"], t["y"], L.dbu), t["cell_path"])


def text_json(L, t):
    return {"text": t["text"], "layer": t["layer"], "x_um": round(t["x"] * L.dbu, 6), "y_um": round(t["y"] * L.dbu, 6),
            "cell_path": t["cell_path"]}


def q_at(L, q):
    db = L.db
    box = parse_box(db, required(q, "box"), "box", L.dbu)
    limit = parse_max(q)
    layers = []
    for key in sorted(L.keys):
        li = L.keys[key]
        it = L.top.begin_shapes_rec_touching(li, box)
        it.shape_flags = db.Shapes.SAll & ~db.Shapes.STexts
        count = 0
        while not it.at_end():
            count += 1
            it.next()
        if count:
            area = area_um2(L.region(li, box).area(), L.dbu)
            layers.append({"layer": L.names.label(key), "shapes": count, "area_um2": round(area, 6)})
    instances = touching_instances(L, box, deepest=True)
    texts = collect_texts(L, sorted(L.keys.items()), box)
    rows = ["  layer {}  shapes={}  area={}".format(x["layer"], x["shapes"], f3(x["area_um2"])) for x in layers]
    rows += ["  inst" + instance_row(L, o)[1:] for o in instances[:limit]]
    if len(instances) > limit:
        rows.append("  ... {} more instances".format(len(instances) - limit))
    rows += ["  text" + text_row(L, t)[1:] for t in texts[:limit]]
    if len(texts) > limit:
        rows.append("  ... {} more texts".format(len(texts) - limit))
    head = "at {}: {} layers, {} instances (deepest), {} texts (area: merged, in the box)".format(
        box_text(box, L.dbu), len(layers), len(instances), len(texts))
    return head, rows, {"box_um": box_um(box, L.dbu), "layers": layers,
                        "instances": [instance_json(L, o) for o in instances[:MAX_JSON]],
                        "texts": [text_json(L, t) for t in texts[:MAX_JSON]]}


def q_bbox(L, q):
    name = q.get("cell") or L.top.name
    cell = L.ly.cell(name) if isinstance(name, str) else None
    if cell is None or cell.cell_index() not in L.tree:
        raise QueryError("no cell '{}' in the tree of {}".format(name, L.top.name))
    label, key = "all layers", None
    if q.get("layer") is not None:
        key, li = L.resolve(q["layer"])
        label = L.names.label(key)
        box = cell.bbox(li) if li is not None else L.db.Box()
    else:
        box = cell.bbox()
    where = "top cell" if cell.cell_index() == L.top.cell_index() else "own coordinates of {}, {} flat instances".format(
        name, L.flat[cell.cell_index()])
    size = "" if box.empty() else "  w={} h={}".format(f3(box.width() * L.dbu), f3(box.height() * L.dbu))
    head = "bbox {} {}: {}{} ({})".format(name, label, box_text(box, L.dbu), size, where)
    return head, [], {"cell": name, "layer": None if key is None else label, "bbox_um": box_um(box, L.dbu),
                      "flat_instances": L.flat[cell.cell_index()]}


def q_texts(L, q):
    limit = parse_max(q)
    box = parse_box(L.db, q["box"], "box", L.dbu) if q.get("box") is not None else None
    if q.get("layer") is not None:
        key, li = L.resolve(q["layer"])
        layers = [(key, li)] if li is not None else []
    else:
        layers = sorted(L.keys.items())
    texts = collect_texts(L, layers, box)
    rows = [text_row(L, t) for t in texts[:limit]]
    if len(texts) > limit:
        rows.append("  ... {} more texts".format(len(texts) - limit))
    where = " in {}".format(box_text(box, L.dbu)) if box is not None else ""
    head = "texts{}{}: {} texts".format(" " + L.names.label(key) if q.get("layer") is not None else "", where, len(texts))
    return head, rows, {"count": len(texts), "texts": [text_json(L, t) for t in texts[:MAX_JSON]]}


def segment_distance(e, f):
    """(distance, point on e, point on f) of two segments, in database units (float)."""
    def closest(p, a, b):
        dx, dy = b.x - a.x, b.y - a.y
        n = dx * dx + dy * dy
        s = 0.0 if n == 0 else max(0.0, min(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n))
        return a.x + s * dx, a.y + s * dy

    if e.intersects(f):
        p = e.intersection_point(f) or e.p1
        return 0.0, (p.x, p.y), (p.x, p.y)
    best = None
    for p, a, b, swap in ((e.p1, f.p1, f.p2, False), (e.p2, f.p1, f.p2, False), (f.p1, e.p1, e.p2, True),
                          (f.p2, e.p1, e.p2, True)):
        x, y = closest(p, a, b)
        d = ((p.x - x) ** 2 + (p.y - y) ** 2) ** 0.5
        if best is None or d < best[0]:
            best = (d, (x, y), (p.x, p.y)) if swap else (d, (p.x, p.y), (x, y))
    return best


def facing_length(e, f):
    """The length of the common projection of two parallel edges, 0 for edges that are not parallel."""
    ex, ey, fx, fy = e.dx(), e.dy(), f.dx(), f.dy()
    if ex * fy - ey * fx != 0:
        return 0
    n = (ex * ex + ey * ey) ** 0.5
    if n == 0:
        return 0
    ux, uy = ex / n, ey / n
    a = sorted(((e.p1.x * ux + e.p1.y * uy), (e.p2.x * ux + e.p2.y * uy)))
    b = sorted(((f.p1.x * ux + f.p1.y * uy), (f.p2.x * ux + f.p2.y * uy)))
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def q_distance(L, q):
    db = L.db
    key, li = L.resolve(required(q, "layer"))
    a = parse_box(db, required(q, "box_a"), "box_a", L.dbu)
    b = parse_box(db, required(q, "box_b"), "box_b", L.dbu)
    label = L.names.label(key)
    ra, rb = L.region(li, a), L.region(li, b)
    for name, r, box in (("box_a", ra, a), ("box_b", rb, b)):
        if r.is_empty():
            raise QueryError("{} {} has no shapes of {}".format(name, box_text(box, L.dbu), label))
    ea, eb = list(ra.edges().each()), list(rb.edges().each())
    if len(ea) * len(eb) > MAX_EDGE_PAIRS:
        raise QueryError("the boxes have {} and {} edges of {}; give smaller boxes".format(len(ea), len(eb), label))
    best = None
    if not (ra & rb).is_empty():
        best = (0.0, None, None, None, None)
    else:
        rank = None
        for e in ea:
            for f in eb:
                d, pa, pb = segment_distance(e, f)
                # Of the pairs at the same distance, take the parallel pair with the longest common length.
                key = (round(d, 6), -facing_length(e, f))
                if rank is None or key < rank:
                    rank, best = key, (d, e, f, pa, pb)
    d, e, f = best[0], best[1], best[2]
    head = "distance {} between {} and {}: {}{}".format(label, box_text(a, L.dbu), box_text(b, L.dbu), f3(d * L.dbu),
                                                        " (the shapes overlap)" if e is None else "")
    rows, data = [], {"layer": label, "distance_um": round(d * L.dbu, 6), "overlap": e is None}
    if e is not None:
        rows = ["  edge a {}".format(edge_text(e, L.dbu)), "  edge b {}".format(edge_text(f, L.dbu))]
        data.update({"edge_a_um": [round(v * L.dbu, 6) for v in (e.p1.x, e.p1.y, e.p2.x, e.p2.y)],
                     "edge_b_um": [round(v * L.dbu, 6) for v in (f.p1.x, f.p1.y, f.p2.x, f.p2.y)],
                     "closest_a_um": [round(v * L.dbu, 6) for v in best[3]],
                     "closest_b_um": [round(v * L.dbu, 6) for v in best[4]]})
    return head, rows, data


QUESTIONS = {"layers": q_layers, "cells": q_cells, "shapes": q_shapes, "instances": q_instances, "at": q_at,
             "bbox": q_bbox, "texts": q_texts, "distance": q_distance}


def answer(L, index, q):
    """(header, rows, data, error message or None) of one question."""
    if not isinstance(q, dict) or q.get("kind") not in QUESTIONS:
        kind = q.get("kind") if isinstance(q, dict) else None
        raise QueryError("unknown kind '{}'; the kinds are: {}".format(kind, ", ".join(KINDS)))
    unknown = sorted(set(q) - {"kind"} - set(ARGS[q["kind"]]))
    if unknown:
        raise QueryError("unknown argument{} {} (the arguments of {}: {})".format(
            "s" if len(unknown) > 1 else "", ", ".join(unknown), q["kind"], ", ".join(ARGS[q["kind"]]) or "none"))
    return QUESTIONS[q["kind"]](L, q)


def truncate(lines, where):
    """At most MAX_REPORT lines: the last line tells how many more rows are in the full answer."""
    if len(lines) <= MAX_REPORT:
        return lines
    return lines[:MAX_REPORT - 1] + ["... {} more rows in {}".format(len(lines) - MAX_REPORT + 1, where)]


def run_queries(db, gds, cell, queries, names):
    """(report lines, the full answer, diagnostics, answered count, row count). Raises QueryError when the layout
    or its top cell cannot be read."""
    start = time.monotonic()
    L = Layout(db, gds, cell, names)
    lines, answers, diagnostics, answered, row_count = [], [], [], 0, 0
    for i, q in enumerate(queries, 1):
        kind = q.get("kind") if isinstance(q, dict) else None
        try:
            head, rows, data = answer(L, i, q)
        except QueryError as e:
            lines.append("[{}] {}: error: {}".format(i, kind, e))
            answers.append({"index": i, "question": q, "status": "error", "error": str(e)})
            diagnostics.append({"severity": "error", "source": "adapter", "message": "question {} ({}): {}".format(i, kind, e)})
            continue
        except RuntimeError as e:
            message = "klayout.db: {}".format(str(e).splitlines()[0] if str(e) else type(e).__name__)
            lines.append("[{}] {}: error: {}".format(i, kind, message))
            answers.append({"index": i, "question": q, "status": "error", "error": message})
            diagnostics.append({"severity": "error", "source": "adapter", "message": "question {} ({}): {}".format(i, kind, message)})
            continue
        answered += 1
        row_count += len(rows)
        lines.append("[{}] {}".format(i, head))
        lines.extend(rows)
        answers.append({"index": i, "question": q, "status": "answered", "header": head, "rows": rows, "answer": data})
    full = {"cell": cell, "dbu_um": L.dbu, "deep_mode": L.hierarchical, "questions": answers,
            "runtime_s": round(time.monotonic() - start, 3)}
    return lines, full, diagnostics, answered, row_count


def layer_names(facts, pdk_root, expand):
    """(LayerNames, path of the .lyp or None, diagnostic or None) from klayout.<pdk>.layer_properties of the pack."""
    entry = (facts or {}).get("layer_properties")
    template = entry.get("path") if isinstance(entry, dict) else entry
    if not isinstance(template, str) or not template:
        return LayerNames(), None, "the technology pack gives no klayout layer_properties: layers are given as layer/datatype"
    if "{pdk_root}" in template and not pdk_root:
        return LayerNames(), None, "PDK_ROOT is not set: the layer names are not known; layers are given as layer/datatype"
    try:
        path = expand(template, {"pdk_root": pdk_root}, ("pdk_root",))
    except ValueError as e:
        return LayerNames(), None, "layer_properties of the technology pack: {}".format(e)
    if not os.path.isfile(path):
        return LayerNames(), path, "the layer properties file {} is not found: layers are given as layer/datatype".format(path)
    try:
        return LayerNames(read_layer_properties(path)), path, None
    except (OSError, ET.ParseError) as e:
        return LayerNames(), path, "the layer properties file {} does not parse ({}): layers are given as layer/datatype".format(path, e)
