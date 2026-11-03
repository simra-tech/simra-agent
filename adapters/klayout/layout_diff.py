"""The operation "diff" of the klayout adapter: compare two layouts, and optionally the DRC markers of two runs.

It uses the KLayout Python module klayout.db in the adapter process. The layer names come from the layer
properties file of the pack (see layout_read.py). This file has no layer names and no other PDK facts.

"gds" is the new layout and "against" is the old one. "added" is in gds and not in against; "removed" is in
against and not in gds. All coordinates are in µm, in the coordinates of the top cell, unless a row says otherwise.
"""

import time

import layout_read as lr
from layout_read import QueryError, area_um2, box_text, box_um, f3, polygon_text

MAX_PATH_SHAPES = 200
MAX_OWN_LAYERS = 4


# ---------------------------------------------------------------- layers

def layer_keys(A, B, names, wanted):
    """The (layer, datatype) keys to compare: the given layers, or all layers of both layouts."""
    if wanted is None:
        return sorted(set(A.keys) | set(B.keys))
    if not isinstance(wanted, list) or not wanted:
        raise QueryError("input 'layers' must be a list of layer names or layer/datatype")
    return sorted({names.resolve(w) for w in wanted})


def flat_texts(L, li, box):
    """{(string, x, y): count} of the texts of a layer, flat from the top cell (in the box, when it is given)."""
    db = L.db
    out = {}
    if li is None:
        return out
    it = L.top.begin_shapes_rec_touching(li, box) if box is not None else L.top.begin_shapes_rec(li)
    it.shape_flags = db.Shapes.STexts
    while not it.at_end():
        t = it.shape().text.transformed(it.trans())
        k = (t.string, t.x, t.y)
        out[k] = out.get(k, 0) + 1
        it.next()
    return out


def count_delta(a, b):
    """(in a and not in b, in b and not in a) of two {key: count} maps."""
    plus = sum(max(0, n - b.get(k, 0)) for k, n in a.items())
    minus = sum(max(0, n - a.get(k, 0)) for k, n in b.items())
    return plus, minus


def common_path(L, li, poly):
    """The cell path of the instance that holds all shapes of the layer that overlap poly, or the top cell name. Two
    path elements are the same instance when they have the same cell and the same placement in their parent."""
    db = L.db
    target = db.Region(poly)
    it = L.top.begin_shapes_rec_touching(li, poly.bbox())
    it.shape_flags = db.Shapes.SAll & ~db.Shapes.STexts
    prefix, seen = None, 0
    while not it.at_end() and seen < MAX_PATH_SHAPES:
        shape = it.shape().polygon
        if shape is not None and not (target & db.Region(shape.transformed(it.trans()))).is_empty():
            path = list(it.path())
            keys = [(e.cell_inst().cell_index, str(e.specific_cplx_trans())) for e in path]
            if prefix is None:
                prefix = list(zip(keys, path))
            else:
                n = 0
                while n < len(prefix) and n < len(keys) and prefix[n][0] == keys[n]:
                    n += 1
                prefix = prefix[:n]
            seen += 1
            if not prefix:
                break
        it.next()
    return L.path_text([e for _, e in prefix]) if prefix else L.top.name


def polygons_of(region, limit):
    """(count, the largest polygons of a region, largest area first, up to limit)."""
    polys = list(region.each())
    polys.sort(key=lambda p: (-p.area(), p.bbox().left, p.bbox().bottom))
    return len(polys), polys[:limit]


def compare_layers(A, B, keys, box, limit):
    """The difference of each layer: [{key, added, removed, ...}]. Without a box: deep XOR in one shape store (it keeps
    the hierarchy, and it is also faster than the flat mode on a flat layout). With a box: flat, clipped to the box.
    One XOR finds the layers with no difference; the two differences are made only for a changed layer."""
    db = A.db
    deep = box is None
    dss = db.DeepShapeStore() if deep else None
    out = []
    for key in keys:
        la, lb = A.layer_index(key), B.layer_index(key)
        ra = A.region(la, box, dss) if la is not None else db.Region()
        rb = B.region(lb, box, dss) if lb is not None else db.Region()
        texts_plus, texts_minus = count_delta(flat_texts(A, la, box), flat_texts(B, lb, box))
        xor = ra ^ rb
        if xor.is_empty() and not texts_plus and not texts_minus:
            out.append({"key": key, "changed": False})
            continue
        added = (xor & ra).merged() if not xor.is_empty() else db.Region()
        removed = (xor & rb).merged() if not xor.is_empty() else db.Region()
        n_add, add_polys = polygons_of(added, limit)
        n_rem, rem_polys = polygons_of(removed, limit)
        out.append({
            "key": key, "changed": True,
            "added_um2": area_um2(added.area(), A.dbu), "removed_um2": area_um2(removed.area(), A.dbu),
            "added_count": n_add, "removed_count": n_rem, "texts_added": texts_plus, "texts_removed": texts_minus,
            "added": [(p, common_path(A, la, p)) for p in add_polys],
            "removed": [(p, common_path(B, lb, p)) for p in rem_polys]})
    return out, ("deep" if deep else "flat")


def layer_rows(A, layers, limit):
    rows, data = [], []
    for d in layers:
        if not d["changed"]:
            continue
        label = A.names.label(d["key"])
        row = "  {}  added={} ({} polygons)  removed={} ({} polygons)".format(
            label, f3(d["added_um2"]), d["added_count"], f3(d["removed_um2"]), d["removed_count"])
        if d["texts_added"] or d["texts_removed"]:
            row += "  texts +{} -{}".format(d["texts_added"], d["texts_removed"])
        rows.append(row)
        for sign, side, count in (("+", "added", d["added_count"]), ("-", "removed", d["removed_count"])):
            for p, path in d[side]:
                rows.append("    {} {}  area={}  cell={}".format(sign, polygon_text(p, A.dbu), f3(area_um2(p.area(), A.dbu)), path))
            if count > len(d[side]):
                rows.append("    {} ... {} more {}".format(sign, count - len(d[side]), side))
        data.append({"layer": label, "layer_datatype": "{}/{}".format(*d["key"]),
                     "added_um2": round(d["added_um2"], 6), "removed_um2": round(d["removed_um2"], 6),
                     "added_polygons": d["added_count"], "removed_polygons": d["removed_count"],
                     "texts_added": d["texts_added"], "texts_removed": d["texts_removed"],
                     "added": [{"bbox_um": box_um(p.bbox(), A.dbu), "area_um2": round(area_um2(p.area(), A.dbu), 6),
                                "cell_path": path} for p, path in d["added"]],
                     "removed": [{"bbox_um": box_um(p.bbox(), A.dbu), "area_um2": round(area_um2(p.area(), A.dbu), 6),
                                  "cell_path": path} for p, path in d["removed"]]})
    return rows, data


# ---------------------------------------------------------------- cells

def name_counts(L):
    return {L.cell_name(ci): n for ci, n in L.flat.items()}


def placement_text(L, inst):
    """The placement of an instance in µm: cell, origin, rotation, mirror, magnification and array."""
    t = inst.dcplx_trans
    text = "{} at ({},{})".format(L.cell_name(inst.cell_index), f3(t.disp.x), f3(t.disp.y))
    if t.angle or t.is_mirror() or abs(t.mag - 1) > 1e-12:
        text += " r{:g}{}{}".format(t.angle, " mirror" if t.is_mirror() else "", " mag {:g}".format(t.mag) if abs(t.mag - 1) > 1e-12 else "")
    if inst.is_regular_array():
        a, b = inst.da, inst.db
        text += "  array {}x{} a=({},{}) b=({},{})".format(inst.na, inst.nb, f3(a.x), f3(a.y), f3(b.x), f3(b.y))
    return text


def placements(L, ci):
    """{placement key: (count, text in µm)} of the child instances of a cell. The key is in database units."""
    out = {}
    for inst in L.ly.cell(ci).each_inst():
        ca = inst.cell_inst
        key = "{} {} {} {} {} {}".format(L.cell_name(inst.cell_index), inst.cplx_trans, ca.a, ca.b, ca.na, ca.nb) \
            if ca.is_regular_array() else "{} {}".format(L.cell_name(inst.cell_index), inst.cplx_trans)
        n, text = out.get(key, (0, None))
        out[key] = (n + 1, text or placement_text(L, inst))
    return out


def placement_delta(A, B):
    """{cell name: (placements only in A, placements only in B)} of the cells in both trees whose child instances
    differ (a moved, added or removed instance). A placement is a text in µm."""
    by_name_b = {B.cell_name(ci): ci for ci in B.flat}
    out = {}
    for ci in A.flat:
        name = A.cell_name(ci)
        if name not in by_name_b:
            continue
        pa, pb = placements(A, ci), placements(B, by_name_b[name])
        plus = sorted(t for k, (n, t) in pa.items() for _ in range(n - pb.get(k, (0, None))[0]))
        minus = sorted(t for k, (n, t) in pb.items() for _ in range(n - pa.get(k, (0, None))[0]))
        if plus or minus:
            out[name] = (plus, minus)
    return out


def own_shapes_delta(A, B, ca, cb, keys):
    """[(key, added µm², removed µm², texts +, texts -)] of the own shapes of one cell (cell coordinates)."""
    db = A.db
    out = []
    for key in keys:
        la, lb = A.layer_index(key), B.layer_index(key)
        sa = A.ly.cell(ca).shapes(la) if la is not None else None
        sb = B.ly.cell(cb).shapes(lb) if lb is not None else None
        if (sa is None or sa.is_empty()) and (sb is None or sb.is_empty()):
            continue
        ra = db.Region(sa) if sa is not None else db.Region()
        rb = db.Region(sb) if sb is not None else db.Region()
        added, removed = (ra - rb).area(), (rb - ra).area()
        ta = cell_texts(db, sa)
        tb = cell_texts(db, sb)
        tp, tm = count_delta(ta, tb)
        if added or removed or tp or tm:
            out.append((key, area_um2(added, A.dbu), area_um2(removed, A.dbu), tp, tm))
    return out


def cell_texts(db, shapes):
    out = {}
    if shapes is None:
        return out
    for s in shapes.each(db.Shapes.STexts):
        t = s.text
        k = (t.string, t.x, t.y)
        out[k] = out.get(k, 0) + 1
    return out


def compare_cells(A, B, keys, layers, box, a_name, b_name, limit):
    """(head, rows, data, changed cell names)."""
    counts_a, counts_b = name_counts(A), name_counts(B)
    only_a = sorted(set(counts_a) - set(counts_b))
    only_b = sorted(set(counts_b) - set(counts_a))
    count_diff = sorted(n for n in set(counts_a) & set(counts_b) if counts_a[n] != counts_b[n])
    moved = placement_delta(A, B)
    same = not only_a and not only_b and not moved
    own = []
    if same:
        by_name_b = {B.cell_name(ci): ci for ci in B.flat}
        flat_top = not list(A.top.each_inst()) and not list(B.top.each_inst()) and box is None
        for ci in sorted(A.flat, key=A.cell_name):
            name = A.cell_name(ci)
            if flat_top and ci == A.top.cell_index():
                # A top cell without instances: its own shapes are the flat layout; reuse the layer comparison.
                delta = [(d["key"], d["added_um2"], d["removed_um2"], d["texts_added"], d["texts_removed"])
                         for d in layers if d["changed"]]
            else:
                delta = own_shapes_delta(A, B, ci, by_name_b[name], keys)
            if delta:
                own.append((name, delta))
    changed = sorted(set(only_a) | set(only_b) | set(count_diff) | set(moved) | {n for n, _ in own})
    head = "cells: {} in {}, {} in {}; {} changed; hierarchy {}".format(
        len(counts_a), a_name, len(counts_b), b_name, len(changed),
        "the same (own shapes compared per cell)" if same else "differs (own shapes not compared per cell; see the flat XOR of the layers)")
    rows = []
    for n in only_a:
        rows.append("  only in {}: {}  flat={}".format(a_name, n, counts_a[n]))
    for n in only_b:
        rows.append("  only in {}: {}  flat={}".format(b_name, n, counts_b[n]))
    for n in count_diff:
        rows.append("  count {}: {} -> {}".format(n, counts_b[n], counts_a[n]))
    for n in sorted(moved):
        plus, minus = moved[n]
        rows.append("  instances in {}: +{} -{}".format(n, len(plus), len(minus)))
        for sign, items in (("+", plus), ("-", minus)):
            for text in items[:limit]:
                rows.append("    {} {}".format(sign, text))
            if len(items) > limit:
                rows.append("    {} ... {} more".format(sign, len(items) - limit))
    for name, delta in own:
        parts = ["{} +{} -{}{}".format(A.names.label(k), f3(add), f3(rem), " texts +{} -{}".format(tp, tm) if tp or tm else "")
                 for k, add, rem, tp, tm in delta[:MAX_OWN_LAYERS]]
        more = len(delta) - MAX_OWN_LAYERS
        rows.append("  own shapes {}: {}{}".format(name, "; ".join(parts), "; ... {} more layers".format(more) if more > 0 else ""))
    data = {"cells_gds": len(counts_a), "cells_against": len(counts_b), "same_hierarchy": same,
            "only_in_gds": [{"cell": n, "flat": counts_a[n]} for n in only_a],
            "only_in_against": [{"cell": n, "flat": counts_b[n]} for n in only_b],
            "count_changed": [{"cell": n, "against": counts_b[n], "gds": counts_a[n]} for n in count_diff],
            "instances_changed": [{"cell": n, "added": moved[n][0], "removed": moved[n][1]} for n in sorted(moved)],
            "own_shapes_changed": [{"cell": name, "layers": [{"layer": A.names.label(k), "added_um2": round(add, 6),
                                                               "removed_um2": round(rem, 6), "texts_added": tp,
                                                               "texts_removed": tm} for k, add, rem, tp, tm in delta]}
                                   for name, delta in own]}
    return head, rows, data, changed


# ---------------------------------------------------------------- DRC markers

def match_markers(new, old, tol):
    """(new, fixed, unchanged) of two lists of {cell, box}: a marker is unchanged when the other run has a marker of the
    same cell whose box is within tol on each coordinate."""
    left = list(old)
    unchanged, fresh = [], []
    for m in new:
        hit = next((i for i, o in enumerate(left) if o.get("cell") == m.get("cell")
                    and all(abs(a - b) <= tol for a, b in zip(o["box"], m["box"]))), None)
        if hit is None:
            fresh.append(m)
        else:
            unchanged.append(m)
            left.pop(hit)
    return fresh, left, unchanged


def marker_delta(table, table_against, tol, limit):
    """(rows, data, totals) of the marker delta per rule."""
    rules_a = {r["rule"]: r for r in table.get("rules", [])}
    rules_b = {r["rule"]: r for r in table_against.get("rules", [])}
    totals = {"new": 0, "fixed": 0, "unchanged": 0}
    per_rule, rows, warnings = [], [], []
    for rule in sorted(set(rules_a) | set(rules_b)):
        a, b = rules_a.get(rule, {}), rules_b.get(rule, {})
        for r in (a, b):
            if r and r.get("count") != len(r.get("boxes", [])):
                warnings.append("rule {}: {} markers, {} with a box; the delta uses the boxes".format(
                    rule, r.get("count"), len(r.get("boxes", []))))
        fresh, fixed, same = match_markers(a.get("boxes", []), b.get("boxes", []), tol)
        totals["new"] += len(fresh)
        totals["fixed"] += len(fixed)
        totals["unchanged"] += len(same)
        per_rule.append({"rule": rule, "new": len(fresh), "fixed": len(fixed), "unchanged": len(same),
                         "new_markers": fresh, "fixed_markers": fixed})
    per_rule.sort(key=lambda r: (-(r["new"] + r["fixed"]), r["rule"]))
    for r in per_rule:
        rows.append("  {}  new={} fixed={} unchanged={}".format(r["rule"], r["new"], r["fixed"], r["unchanged"]))
        for side, label in (("new_markers", "new"), ("fixed_markers", "fixed")):
            for m in r[side][:limit]:
                x1, y1, x2, y2 = m["box"]
                rows.append("    {} ({},{};{},{})  cell={}".format(label, f3(x1), f3(y1), f3(x2), f3(y2), m.get("cell")))
            if len(r[side]) > limit:
                rows.append("    {} ... {} more".format(label, len(r[side]) - limit))
    return rows, per_rule, totals, warnings


# ---------------------------------------------------------------- run

def run_diff(db, gds, against, cell, names, opts):
    """(report lines, full answer, summary values). opts: layers, box, max, a_name, b_name, drc (None or
    (table, table_against, id, id_against)). Raises QueryError."""
    start = time.monotonic()
    A = lr.Layout(db, gds, cell, names)
    B = lr.Layout(db, against, cell, names)
    limit = lr.parse_max({"max": opts.get("max", 10)}, 10)
    box = lr.parse_box(db, opts["box"], "box", A.dbu) if opts.get("box") is not None else None
    if abs(A.dbu - B.dbu) > 1e-12:
        raise QueryError("the two layouts have different database units ({} µm and {} µm)".format(A.dbu, B.dbu))
    keys = layer_keys(A, B, names, opts.get("layers"))
    layers, mode = compare_layers(A, B, keys, box, limit)
    lrows, ldata = layer_rows(A, layers, limit)
    changed = [d for d in layers if d["changed"]]
    where = "in the box {}".format(box_text(box, A.dbu)) if box is not None else "whole layout"
    lines = ["layers: {} changed, {} unchanged ({} XOR, {}; + in {}, - in {}; the first {} polygons of each, largest first)".format(
        len(changed), len(layers) - len(changed), mode, where, opts["a_name"], opts["b_name"], limit)]
    lines += lrows
    if len(layers) > len(changed):
        lines.append("  unchanged: {} layers".format(len(layers) - len(changed)))
    chead, crows, cdata, cells_changed = compare_cells(A, B, keys, layers, box, opts["a_name"], opts["b_name"], limit)
    lines.append(chead)
    lines += crows
    values = {"layers_changed": len(changed), "area_added_um2": round(sum(d["added_um2"] for d in changed), 6),
              "area_removed_um2": round(sum(d["removed_um2"] for d in changed), 6), "cells_changed": len(cells_changed)}
    full = {"cell": cell, "dbu_um": A.dbu, "mode": mode, "box_um": box_um(box, A.dbu) if box is not None else None,
            "layers": ldata, "layers_unchanged": ["{}/{}".format(*d["key"]) for d in layers if not d["changed"]],
            "cells": cdata}
    warnings = []
    if opts.get("drc"):
        table, table_against, id_a, id_b = opts["drc"]
        tol = A.dbu * (1 + 1e-6)
        drows, ddata, totals, warnings = marker_delta(table, table_against, tol, limit)
        lines.append("drc: {} against {}: new={} fixed={} unchanged={} (same cell and box within {} µm)".format(
            id_a, id_b, totals["new"], totals["fixed"], totals["unchanged"], f3(A.dbu)))
        lines += drows
        values.update({"markers_new": totals["new"], "markers_fixed": totals["fixed"], "markers_unchanged": totals["unchanged"]})
        full["drc"] = {"experiment": id_a, "experiment_against": id_b, "tolerance_um": A.dbu, "rules": ddata}
    full["runtime_s"] = round(time.monotonic() - start, 3)
    return lines, full, values, warnings
