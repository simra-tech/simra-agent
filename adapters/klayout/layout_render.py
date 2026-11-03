"""The operation render of the klayout adapter: a picture of a region of a layout, or of DRC markers, as a PNG.

It uses the KLayout Python module klayout.lay (a LayoutView without a display) with the layer colours of the PDK's
layer properties file. The adapter (klayout_adapter.py) gives the inputs, the layer names and the marker table;
this module draws and writes the images and gives the report lines. No PDK fact is here: the colours come from
the file that the technology pack names, and a layer without an entry in that file gets the default style of
KLayout.
"""

import math
import os

from layout_read import QueryError, f3, number

DEFAULT_SIZE = 1024
MAX_SIZE = 2048
MIN_SIZE = 64
DEFAULT_MAX = 4
MAX_IMAGES = 8
MARGIN = 0.1
MIN_MARGIN_UM = 0.5
MARKER_MARGIN_UM = 3.0
MARKER_COLOR = 0xff0000
MARKER_LAYER = 9999
MARKER_WIDTH = 3
GRID_UNDER_UM = 50.0
VIEWS = ("box", "drc")


def klayout_lay():
    """The module klayout.lay, or None when it is not installed."""
    try:
        import klayout.lay as lay  # noqa: PLC0415
    except ImportError:
        return None
    return lay


def box_text(b):
    return "({},{};{},{})".format(f3(b.left), f3(b.bottom), f3(b.right), f3(b.top))


def parse_dbox(db, value, name):
    """A box argument in µm ([x1, y1, x2, y2] or a point [x, y]) as a db.DBox."""
    if isinstance(value, list) and len(value) in (2, 4) and all(number(v) for v in value):
        if len(value) == 2:
            value = [value[0], value[1], value[0], value[1]]
        x1, y1, x2, y2 = value
        return db.DBox(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
    raise QueryError("'{}' must be [x1, y1, x2, y2] or a point [x, y], in µm".format(name))


def parse_int(inputs, name, default, low, high):
    value = inputs.get(name, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < low or value > high:
        raise QueryError("'{}' must be an integer from {} to {}".format(name, low, high))
    return value


def parse_bool(inputs, name, default):
    value = inputs.get(name, default)
    if not isinstance(value, bool):
        raise QueryError("'{}' must be true or false".format(name))
    return value


def view_box(db, box, margin_um=None):
    """The box plus a margin: 10 % of each side and at least 0.5 µm (so that a point gives a view of 1 µm), or, for
    a marker, at least margin_um and half of the longer side of the marker."""
    w, h = box.width(), box.height()
    mx, my = max(w * MARGIN, MIN_MARGIN_UM), max(h * MARGIN, MIN_MARGIN_UM)
    if margin_um is not None:
        mx, my = max(mx, margin_um, w * 0.5), max(my, margin_um, h * 0.5)
    return db.DBox(box.left - mx, box.bottom - my, box.right + mx, box.top + my)


def image_size(box, size):
    """(width, height) in pixels: the longer side is size, the other follows the box."""
    w, h = max(box.width(), 1e-9), max(box.height(), 1e-9)
    if w >= h:
        return size, max(MIN_SIZE, int(round(size * h / w)))
    return max(MIN_SIZE, int(round(size * w / h))), size


def scale_length(box):
    """A round scale bar length in µm for the view: 1, 2 or 5 times a power of ten, about a fifth of the width."""
    target = box.width() / 5.0
    if target <= 0:
        return 1.0
    power = 10.0 ** int(math.floor(math.log10(target)))
    for m in (1.0, 2.0, 5.0, 10.0):
        if m * power >= target:
            return m * power
    return 10.0 * power


class Renderer:
    """One LayoutView on one layout file and top cell."""

    def __init__(self, lay, db, path, cell, lyp, names):
        self.lay, self.db, self.names = lay, db, names
        self.view = lay.LayoutView()
        self.view.load_layout(path, True)
        self.cellview = self.view.cellview(0)
        self.layout = self.cellview.layout()
        if self.layout.cell(cell) is None:
            tops = ", ".join(sorted(c.name for c in self.layout.top_cells())) or "none"
            raise QueryError("the layout has no cell '{}' (its top cells: {})".format(cell, tops))
        self.cell = cell
        self.cellview.cell_name = cell
        self.lyp_loaded = False
        if lyp and os.path.isfile(lyp):
            try:
                self.view.load_layer_props(lyp)
                self.lyp_loaded = True
            except RuntimeError:
                self.lyp_loaded = False
        self.view.add_missing_layers()
        self.view.max_hier()
        self.view.set_config("background-color", "#ffffff")
        self.view.set_config("grid-color", "#c0c0c0")
        self.view.set_config("grid-style", "dotted-lines")
        self.view.set_config("ruler-color", "#000000")
        self.view.set_config("ruler-halo", "false")
        self.marker_key, self.marker_li = None, None

    def set_cell(self, cell):
        if self.layout.cell(cell) is None:
            raise QueryError("the layout has no cell '{}'".format(cell))
        self.cellview.cell_name = cell
        self.cell = cell
        self.view.max_hier()

    def select_layers(self, wanted):
        """Show only the layers of wanted ({(layer, datatype)}), or all layers when wanted is None. Returns the
        count of visible drawing layers."""
        shown = 0
        it = self.view.begin_layers()
        while not it.at_end():
            node = it.current()
            if not node.has_children():
                key = (node.source_layer, node.source_datatype) if node.source_layer >= 0 else None
                visible = key is not None and (wanted is None or key in wanted)
                node.visible = visible
                if visible:
                    shown += 1
            it.next()
        return shown

    def visible_layer_names(self, view, limit=12):
        """The names of the visible layers that have shapes in the view box (in the tree of the current cell), for
        the report line."""
        names = []
        cell = self.layout.cell(self.cell)
        box = view.to_itype(self.layout.dbu)
        it = self.view.begin_layers()
        while not it.at_end():
            node = it.current()
            if not node.has_children() and node.visible and node.source_layer >= 0:
                key = (node.source_layer, node.source_datatype)
                li = self.layer_index(key) if key != self.marker_key else None
                if li is not None and not cell.begin_shapes_rec_touching(li, box).at_end():
                    names.append(self.names.label(key).split(" ")[0])
            it.next()
        return names[:limit] + (["... {} more".format(len(names) - limit)] if len(names) > limit else [])

    def layer_index(self, key):
        for li in self.layout.layer_indexes():
            info = self.layout.get_info(li)
            if (info.layer, info.datatype) == key:
                return li
        return None

    def marker_layer(self):
        """A scratch layer of the loaded layout (in memory, not in the file) with a red hollow style, for the
        marker outlines: the first free layer number from 9999, datatype 0."""
        if self.marker_li is None:
            layer = MARKER_LAYER
            while self.layout.find_layer(layer, 0) is not None:
                layer += 1
            self.marker_key = (layer, 0)
            self.marker_li = self.layout.layer(self.db.LayerInfo(layer, 0))
            lp = self.lay.LayerProperties()
            lp.source = "{}/{}@1".format(layer, 0)
            lp.name = "marker"
            lp.frame_color, lp.fill_color = MARKER_COLOR, MARKER_COLOR
            lp.dither_pattern = 1  # hollow
            lp.width = MARKER_WIDTH
            self.view.insert_layer(self.view.end_layers(), lp)
        return self.marker_li

    def draw(self, path, view, size, labels, hierarchy, grid, markers=()):
        """Draw the view box (a db.DBox in µm, in the coordinates of the current cell) to path. markers: db.DBox
        outlines in red. Returns (width, height)."""
        lay, db, v = self.lay, self.db, self.view
        v.clear_annotations()
        if self.marker_li is not None:
            self.layout.clear_layer(self.marker_li)
        v.set_config("text-visible", "true" if labels else "false")
        if hierarchy is None:
            v.max_hier()
        else:
            # max_hier_levels = n draws the cells down to depth n - 1: 1 is the top cell alone.
            v.max_hier_levels = hierarchy + 1
        fine = view.width() <= GRID_UNDER_UM and view.height() <= GRID_UNDER_UM
        v.set_config("grid-visible", "true" if grid and fine else "false")
        v.set_config("grid-micron", "1")
        if markers:
            shapes = self.layout.cell(self.cell).shapes(self.marker_layer())
            for m in markers:
                shapes.insert(m.to_itype(self.layout.dbu))
        if grid:
            bar = scale_length(view)
            x0, y0 = view.left + view.width() * 0.04, view.bottom + view.height() * 0.04
            a = lay.Annotation()
            a.p1, a.p2 = db.DPoint(x0, y0), db.DPoint(x0 + bar, y0)
            a.style = lay.Annotation.StyleRuler
            a.outline = lay.Annotation.OutlineDiag
            a.fmt = "{:g} um  view {}".format(bar, box_text(view))
            a.fmt_x, a.fmt_y = "", ""
            a.category = "scale"
            v.insert_annotation(a)
        w, h = image_size(view, size)
        v.resize(w, h)
        v.zoom_box(view)
        v.save_image(path, w, h)
        return w, h


def marker_boxes(db, table, rule):
    """The markers of one rule of a drc.json table: [(cell, DBox)], in the order of the table. Raises QueryError
    when the rule is not in the table."""
    for r in table.get("rules", []):
        if r.get("rule") == rule:
            boxes = []
            for b in r.get("boxes", []):
                box = b.get("box")
                if isinstance(box, list) and len(box) == 4:
                    boxes.append((b.get("cell"), db.DBox(box[0], box[1], box[2], box[3])))
            if not boxes:
                raise QueryError("rule '{}' has {} markers but no marker box in the table".format(rule, r.get("count")))
            return boxes
    known = ", ".join(r.get("rule", "?") for r in table.get("rules", [])[:12]) or "none"
    raise QueryError("rule '{}' is not in the drc table (rules with markers: {})".format(rule, known))


def view_kind(inputs):
    """'box' or 'drc': the one view that the inputs give, or raise QueryError."""
    kinds = [k for k in VIEWS if inputs.get(k) is not None]
    if len(kinds) != 1:
        raise QueryError("give one view: 'box' ([x1, y1, x2, y2] in µm) or 'drc' (the id of a drc experiment) with 'rule'")
    return kinds[0]


def run_render(lay, db, gds, cell, inputs, names, lyp, work_dir, root_rel, table=None):
    """Draw the images of one render request. Returns (report lines, the full answer, image paths).
    inputs: the operation inputs (box or drc+rule, layers, size, labels, hierarchy, grid, index, all, max).
    table: the drc.json table when inputs give 'drc'. root_rel: a function that gives the path of a file relative
    to the design root (for the report). Raises QueryError for a bad input."""
    kind = view_kind(inputs)
    size = parse_int(inputs, "size", DEFAULT_SIZE, MIN_SIZE, MAX_SIZE)
    labels = parse_bool(inputs, "labels", True)
    grid = parse_bool(inputs, "grid", True)
    hierarchy = None if inputs.get("hierarchy") is None else parse_int(inputs, "hierarchy", 0, 0, 64)
    wanted = None
    layers = inputs.get("layers")
    if layers is not None:
        if not isinstance(layers, list) or not layers:
            raise QueryError("'layers' must be a list of layer names or layer/datatype")
        wanted = {names.resolve(text) for text in layers}
    R = Renderer(lay, db, gds, cell, lyp, names)
    shown = R.select_layers(wanted)
    if wanted is not None and shown == 0:
        raise QueryError("none of the layers in 'layers' is in the layer properties file or the layout")
    views = []
    if kind == "box":
        box = parse_dbox(db, inputs["box"], "box")
        views.append({"kind": "box", "cell": cell, "box": box, "view": view_box(db, box), "markers": [], "label": "box"})
    else:
        rule = inputs.get("rule")
        if not isinstance(rule, str) or not rule:
            raise QueryError("'rule' is required with 'drc': the rule name as the drc report gives it")
        boxes = marker_boxes(db, table, rule)
        limit = parse_int(inputs, "max", DEFAULT_MAX, 1, MAX_IMAGES)
        if parse_bool(inputs, "all", False):
            chosen = list(enumerate(boxes, 1))[:limit]
        else:
            index = parse_int(inputs, "index", 1, 1, len(boxes))
            chosen = [(index, boxes[index - 1])]
        for i, (mcell, box) in chosen:
            views.append({"kind": "marker", "cell": mcell or cell, "box": box, "view": view_box(db, box, MARKER_MARGIN_UM),
                          "markers": [box], "label": "marker {} {}/{}".format(rule, i, len(boxes))})
    lines, answer, paths = [], [], []
    for n, item in enumerate(views, 1):
        name = "render.png" if len(views) == 1 else "render-{}.png".format(n)
        path = os.path.join(work_dir, name)
        if item["cell"] != R.cell:
            R.set_cell(item["cell"])
        w, h = R.draw(path, item["view"], size, labels, hierarchy, grid, item["markers"])
        shown_names = R.visible_layer_names(item["view"])
        lines.append("[{}] {} cell={} box={} view={} image={} {}x{} layers={}".format(
            n, item["label"], item["cell"], box_text(item["box"]), box_text(item["view"]), root_rel(path), w, h,
            ",".join(shown_names) if shown_names else "none"))
        answer.append({"index": n, "kind": item["kind"], "cell": item["cell"],
                       "box": [round(v, 3) for v in (item["box"].left, item["box"].bottom, item["box"].right, item["box"].top)],
                       "view": [round(v, 3) for v in (item["view"].left, item["view"].bottom, item["view"].right, item["view"].top)],
                       "image": root_rel(path), "width": w, "height": h, "layers": shown_names})
        paths.append(path)
    full = {"cell": cell, "views": answer, "layer_properties": lyp if R.lyp_loaded else None,
            "size": size, "labels": labels, "grid": grid, "hierarchy": hierarchy}
    return lines, full, paths
