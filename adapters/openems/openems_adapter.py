#!/usr/bin/env python3
"""openEMS adapter for Simra Agent (contract simra.adapter/0).

Usage: openems_adapter.py <request.json>
       openems_adapter.py --solve <plan.json>     (internal: the solver child process)

Operation "simulate": a GDS cell, an openEMS stackup (XML) and lumped ports in; S-parameter columns out (one column
per excited port), and a Touchstone file when every port is excited in the run. The solver runs headless in a child
process (python3 with CSXCAD and openEMS); its output goes to work/openems_<k>.log.

Operation "merge": the column files of several "simulate" runs (one excited port each) in; one Touchstone file out.
The kernel runs one "simulate" job per port with "run N jobs and wait", then "merge" (simra em).

Convergence: openEMS stops at the end criterion (the field energy falls by end_criteria_db) or at max_timesteps. A
run that stops at max_timesteps did not converge: its S-parameters can be wrong. The adapter reports it as failed
(end_criteria_reached 0, energy_end_db), never as passed, unless the caller sets allow_unconverged.

Method (see README.md): metals are conducting sheets at the bottom face (Zmin) of the layer, with the conductivity
and the thickness of the stackup; vias are solid conductors from the sheet of the metal below to the top of the via;
dielectrics are boxes over the whole domain; a lumped port is a z-directed current source with a resistance, from
the sheet of one layer (or the bottom of the domain, "bottom") to the sheet of another. Default boundaries: PML_8 on
the four sides and on the top, PEC at the bottom. First-order MUR boundaries do not absorb the quasi-static field of
an on-chip line: the energy stays at a plateau and the end criterion is never reached.

numpy and gdstk are needed for "simulate"; CSXCAD and openEMS for the solver. "merge" needs only the standard library.
"""

import cmath
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

CONTRACT = "simra.adapter/0"
COLUMNS_SCHEMA = "simra.openems_columns/0"
C0 = 299792458.0
DEFAULT_BOUNDARIES = ["PML_8", "PML_8", "PML_8", "PML_8", "PEC", "PML_8"]
TOOL = {"name": "simra-openems", "version": "0.1.0"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def display_path(path, root):
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


def file_entry(path, root, role=None):
    e = {"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path)}
    if role:
        e["role"] = role
    return e


def resolve(path, root):
    path = os.path.expandvars(path)
    return path if os.path.isabs(path) else os.path.join(root, path)


def measured(value, unit=None):
    return {"value": value, "unit": unit, "status": "measured"}


def failed_m(unit=None, reason=None):
    m = {"value": None, "unit": unit, "status": "failed"}
    if reason:
        m["reason"] = reason
    return m


def failure(message, measurements=None, input_files=None, outputs=None):
    return {"contract": CONTRACT, "status": "failed", "tool": dict(TOOL), "input_files": input_files, "outputs": outputs or [],
            "measurements": measurements or {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


# --------------------------------------------------------------------------------------------------------- stackup
def read_stackup(path):
    """The stackup of an openEMS XML file (schema 2.0): materials, dielectrics (bottom first, with z) and layers
    (absolute z in um, substrate bottom = 0)."""
    root = ET.parse(path).getroot()
    materials = {}
    for m in root.iter("Material"):
        materials[m.get("Name")] = {"type": m.get("Type"), "eps": float(m.get("Permittivity", "1")),
                                    "sigma": float(m.get("Conductivity", "0"))}
    diel = [(d.get("Name"), d.get("Material"), float(d.get("Thickness"))) for d in root.iter("Dielectric")]
    dielectrics, z = [], 0.0
    for name, mat, t in reversed(diel):
        dielectrics.append({"name": name, "material": mat, "zmin": z, "zmax": z + t})
        z += t
    sub = root.find(".//Substrate")
    offset = float(sub.get("Offset")) if sub is not None else 0.0
    layers = []
    for l in root.iter("Layer"):
        layers.append({"name": l.get("Name"), "type": l.get("Type"), "material": l.get("Material"), "gds": int(l.get("Layer")),
                       "zmin": float(l.get("Zmin")) + offset, "zmax": float(l.get("Zmax")) + offset})
    return {"materials": materials, "dielectrics": dielectrics, "layers": layers, "top": z}


def metal_layers(stackup):
    """Layers that are conductors in the model: type conductor or via with a material of type Conductor."""
    mats = stackup["materials"]
    return [l for l in stackup["layers"] if l["type"] in ("conductor", "via") and mats.get(l["material"], {}).get("type") == "Conductor"
            and l["zmin"] >= 0]


def sheet_z(layer):
    return layer["zmin"]


def via_z(via, stackup):
    """A via is a solid from the sheet of the metal below (its Zmin) to the top of the via."""
    below = [l for l in metal_layers(stackup) if l["type"] == "conductor" and l["zmax"] <= via["zmin"] + 1e-9]
    z0 = max((sheet_z(l) for l in below), default=via["zmin"])
    return z0, via["zmax"]


def port_z(ref, stackup):
    if ref == "bottom":
        return 0.0
    for l in metal_layers(stackup):
        if l["name"] == ref and l["type"] == "conductor":
            return sheet_z(l)
    return None


# ------------------------------------------------------------------------------------------------------------ mesh
def smooth_lines(fixed, max_cell, ratio=1.4):
    """Mesh lines through every fixed line, no cell above max_cell. Between two fixed lines the cells start at the
    smallest neighbour gap of each end and grow by ratio toward the middle (a graded mesh)."""
    fixed = sorted(set(round(x, 6) for x in fixed))
    if len(fixed) < 2:
        return fixed
    gaps = [b - a for a, b in zip(fixed, fixed[1:])]
    start = [min([max_cell] + gaps[max(0, i - 1):i + 1]) for i in range(len(fixed))]
    lines = [fixed[0]]
    for i, (a, b) in enumerate(zip(fixed, fixed[1:])):
        left, right, cl, cr = [a], [b], start[i], start[i + 1]
        while right[-1] - left[-1] > (cl + cr) * (1 + 1e-9):
            if cl <= cr:
                left.append(left[-1] + cl)
                cl = min(cl * ratio, max_cell)
            else:
                right.append(right[-1] - cr)
                cr = min(cr * ratio, max_cell)
        if right[-1] - left[-1] > max(cl, cr) * (1 + 1e-9):
            left.append((left[-1] + right[-1]) / 2)
        lines += left[1:] + right[::-1]
    return lines


def build_plan(inputs, stackup, polygons):
    """The solver plan: materials, boxes, polygons, ports, mesh lines, excitation. polygons: {layer name: [[(x, y)...]]}
    in um. Raises ValueError with the reason for a bad input."""
    ports = inputs.get("ports")
    if not isinstance(ports, list) or not ports:
        raise ValueError("input 'ports' is required: a list of {name, x, y, from, to, r_ohm} (um, layer names or 'bottom')")
    band = inputs.get("band_hz")
    if not (isinstance(band, list) and len(band) == 2 and 0 < band[0] < band[1]):
        raise ValueError("input 'band_hz' must be [f_lo, f_hi] with 0 < f_lo < f_hi")
    points = int(inputs.get("points", 101))
    excite = inputs.get("excite", list(range(1, len(ports) + 1)))
    if not (isinstance(excite, list) and excite and all(isinstance(k, int) and 1 <= k <= len(ports) for k in excite)):
        raise ValueError("input 'excite' must be a list of port numbers from 1 to %d" % len(ports))
    plan_ports = []
    for k, p in enumerate(ports, 1):
        z0, z1 = port_z(p.get("from"), stackup), port_z(p.get("to"), stackup)
        if z0 is None or z1 is None:
            raise ValueError("port %d: 'from' and 'to' must be conductor layers of the stackup or 'bottom' (got %r, %r)"
                             % (k, p.get("from"), p.get("to")))
        if abs(z1 - z0) < 1e-9:
            raise ValueError("port %d: 'from' and 'to' are at the same height" % k)
        plan_ports.append({"name": p.get("name", "p%d" % k), "x": float(p["x"]), "y": float(p["y"]),
                           "z0": min(z0, z1), "z1": max(z0, z1), "r_ohm": float(p.get("r_ohm", 50.0))})
    if not any(polygons.values()):
        raise ValueError("the cell has no polygons on the selected layers")
    xs = [pt[0] for polys in polygons.values() for poly in polys for pt in poly] + [p["x"] for p in plan_ports]
    ys = [pt[1] for polys in polygons.values() for poly in polys for pt in poly] + [p["y"] for p in plan_ports]
    margin = float(inputs.get("margin_um", 200.0))
    box = [min(xs) - margin, max(xs) + margin, min(ys) - margin, max(ys) + margin]
    mats = stackup["materials"]
    eps_max = max(mats[d["material"]]["eps"] for d in stackup["dielectrics"])
    scale = float(inputs.get("mesh_scale", 1.0))
    fine = float(inputs.get("fine_um", 3.0)) * scale
    lam = C0 / band[1] * 1e6
    max_xy = min(float(inputs.get("max_cell_um", 25.0)), lam / math.sqrt(eps_max) / 15) * scale
    max_z = min(40.0, lam / 12) * scale
    fx = [box[0], box[1]] + [p["x"] for p in plan_ports]
    fy = [box[2], box[3]] + [p["y"] for p in plan_ports]
    for polys in polygons.values():
        for poly in polys:
            for x, y in poly:
                fx += [x - fine, x, x + fine]
                fy += [y - fine, y, y + fine]
    used = set(polygons)
    layers = [l for l in metal_layers(stackup) if l["name"] in used]
    fz = [0.0, stackup["top"]]
    for l in layers:
        fz += [sheet_z(l)] if l["type"] == "conductor" else list(via_z(l, stackup))
    for p in plan_ports:
        fz += [p["z0"] + (p["z1"] - p["z0"]) * k / 3 for k in range(4)]
    # a dielectric interface gets its own z line only when it is at least dielectric_snap_um from every other line: a
    # thin layer (for example a 0.4 um passivation) would set a small cell and a small time step for the whole run
    snap = float(inputs.get("dielectric_snap_um", 2.0))
    for d in stackup["dielectrics"]:
        if all(abs(d["zmax"] - z) >= snap for z in fz):
            fz.append(d["zmax"])
    boundaries = inputs.get("boundaries", DEFAULT_BOUNDARIES)
    if not (isinstance(boundaries, list) and len(boundaries) == 6):
        raise ValueError("input 'boundaries' must be 6 strings: x-, x+, y-, y+, z-, z+ (for example PML_8, MUR, PEC)")
    plan = {
        "dielectrics": [{"name": d["name"], "eps": mats[d["material"]]["eps"], "sigma": mats[d["material"]]["sigma"],
                         "box": [box[0], box[2], d["zmin"], box[1], box[3], d["zmax"]]} for d in stackup["dielectrics"]],
        "metals": [], "ports": plan_ports, "excite": excite, "boundaries": boundaries,
        "f_hz": [band[0] + (band[1] - band[0]) * k / (points - 1) for k in range(points)] if points > 1 else [band[1]],
        "f0_hz": band[1] / 2, "fc_hz": band[1] / 2,
        "end_criteria_db": float(inputs.get("end_criteria_db", -40.0)),
        "max_timesteps": int(inputs.get("max_timesteps", 200000)),
        "mesh": {"x": smooth_lines(fx, max_xy), "y": smooth_lines(fy, max_xy), "z": smooth_lines(fz, max_z)},
    }
    for l in layers:
        sigma = mats[l["material"]]["sigma"]
        if l["type"] == "conductor":
            plan["metals"].append({"name": l["name"], "kind": "sheet", "z": sheet_z(l), "sigma": sigma,
                                   "thickness_um": l["zmax"] - l["zmin"], "polygons": polygons[l["name"]]})
        else:
            z0, z1 = via_z(l, stackup)
            plan["metals"].append({"name": l["name"], "kind": "solid", "z0": z0, "z1": z1, "sigma": sigma,
                                   "polygons": polygons[l["name"]]})
    plan["cells"] = (len(plan["mesh"]["x"]) - 1) * (len(plan["mesh"]["y"]) - 1) * (len(plan["mesh"]["z"]) - 1)
    return plan


def read_polygons(gds, cell_name, stackup, layer_names):
    import gdstk
    lib = gdstk.read_gds(gds)
    tops = lib.top_level()
    if cell_name:
        cells = [c for c in lib.cells if c.name == cell_name]
        if not cells:
            raise ValueError("cell %s is not in the GDS" % cell_name)
        cell = cells[0]
    elif len(tops) == 1:
        cell = tops[0]
    else:
        raise ValueError("the GDS has %d top cells; give input 'cell'" % len(tops))
    um = lib.unit / 1e-6
    out = {}
    for l in metal_layers(stackup):
        if layer_names is not None and l["name"] not in layer_names:
            continue
        polys = cell.get_polygons(layer=l["gds"], datatype=0)
        if polys:
            out[l["name"]] = [[(float(x) * um, float(y) * um) for x, y in p.points] for p in polys]
    return cell.name, out


# --------------------------------------------------------------------------------------------------------- logs
ENERGY = re.compile(r"Timestep:\s*(\d+).*Energy:\s*~?\s*([0-9.eE+-]+)\s*\(\s*(-?)\s*([0-9.]+)\s*dB\)")
MAXTS = "Max. number of timesteps was reached"
TIMEFOR = re.compile(r"Time for (\d+) iterations with ([0-9.]+) cells\s*:\s*([0-9.]+) sec")


def read_log(text, end_criteria_db):
    """Convergence of one openEMS run from its log: {timesteps, cells, energy_end_db, end_criteria_reached, solve_s}."""
    out = {"timesteps": None, "cells": None, "energy_end_db": None, "end_criteria_reached": False, "solve_s": None}
    last = None
    for m in ENERGY.finditer(text):
        last = m
    if last:
        out["timesteps"], out["energy_end_db"] = int(last.group(1)), float(last.group(3) + last.group(4))
    t = None
    for m in TIMEFOR.finditer(text):
        t = m
    if t:
        out["timesteps"], out["cells"], out["solve_s"] = int(t.group(1)), int(float(t.group(2))), float(t.group(3))
    out["end_criteria_reached"] = bool(t) and MAXTS not in text
    if out["end_criteria_reached"] and out["energy_end_db"] is not None and out["energy_end_db"] > end_criteria_db + 3:
        # the last energy line comes before the final step; a value far above the criterion is a contradiction
        out["end_criteria_reached"] = False
    return out


# ---------------------------------------------------------------------------------------------------- Touchstone
def s_matrix(columns, n):
    """S[f][i][j] from {j (1-based excited port): {"re": [[port i][f]], "im": ...}}."""
    nf = len(next(iter(columns.values()))["re"][0])
    s = [[[0j] * n for _ in range(n)] for _ in range(nf)]
    for j in range(1, n + 1):
        col = columns[str(j)] if str(j) in columns else columns[j]
        for i in range(n):
            for k in range(nf):
                s[k][i][j - 1] = complex(col["re"][i][k], col["im"][i][k])
    return s


def write_touchstone(path, f_hz, s, z0, comment_lines):
    n = len(s[0])
    with open(path, "w") as fh:
        for c in comment_lines:
            fh.write("! %s\n" % c)
        fh.write("# Hz S RI R %g\n" % z0)
        for k, f in enumerate(f_hz):
            if n == 2:
                order = [(0, 0), (1, 0), (0, 1), (1, 1)]
                fh.write("%.9e %s\n" % (f, " ".join("%.9e %.9e" % (s[k][i][j].real, s[k][i][j].imag) for i, j in order)))
            else:
                for i in range(n):
                    vals = ["%.9e %.9e" % (s[k][i][j].real, s[k][i][j].imag) for j in range(n)]
                    for c in range(0, n, 4):
                        lead = "%.9e " % f if (i == 0 and c == 0) else "  "
                        fh.write(lead + " ".join(vals[c:c + 4]) + "\n")


def column_measurements(conv, allow):
    m = {}
    for k, c in sorted(conv.items(), key=lambda kv: int(kv[0])):
        m["end_criteria_reached_p%s" % k] = measured(1 if c["end_criteria_reached"] else 0)
        for name, unit in (("energy_end_db", "dB"), ("timesteps", None), ("cells", None), ("solve_s", "s")):
            v = c.get(name)
            m["%s_p%s" % (name, k)] = measured(v, unit) if v is not None else failed_m(unit, "not in the openEMS log")
    return m


# ------------------------------------------------------------------------------------------------------- simulate
def simulate(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    os.makedirs(work, exist_ok=True)
    for key in ("gds", "stackup"):
        if not isinstance(inputs.get(key), str):
            return failure("input '%s' is required (relative to the design root; $PDK_ROOT is expanded)" % key)
    gds, xml = resolve(inputs["gds"], root), resolve(inputs["stackup"], root)
    for p in (gds, xml):
        if not os.path.isfile(p):
            return failure("file not found: %s" % p)
    files = {"files": [file_entry(gds, root, "gds"), file_entry(xml, root, "stackup")], "complete": True}
    try:
        import numpy  # noqa: F401
        import gdstk
        TOOL["gdstk"] = gdstk.__version__
    except ImportError as e:
        return failure("numpy and gdstk are required: %s" % e, input_files=files)
    try:
        stackup = read_stackup(xml)
        cell, polygons = read_polygons(gds, inputs.get("cell"), stackup, inputs.get("layers"))
        plan = build_plan(inputs, stackup, polygons)
    except (ValueError, KeyError, ET.ParseError) as e:
        return failure(str(e), input_files=files)
    max_cells = int(inputs.get("max_cells", 5_000_000))
    if plan["cells"] > max_cells:
        return failure("the mesh has %d cells, more than max_cells %d; raise mesh_scale or max_cells" % (plan["cells"], max_cells),
                       input_files=files)
    allow = bool(inputs.get("allow_unconverged", False))
    outputs, diagnostics, conv, columns, commands = [], [], {}, {}, []
    plan_path = os.path.join(work, "plan.json")
    timeout = float(inputs.get("solve_timeout_s", 3000))
    t_start = time.time()
    for k in plan["excite"]:
        sim_dir = os.path.join(work, "sim_p%d" % k)
        one = dict(plan, excite=k, sim_dir=sim_dir, out=os.path.join(work, "col_p%d.json" % k))
        with open(plan_path, "w") as fh:
            json.dump(one, fh)
        log = os.path.join(work, "openems_p%d.log" % k)
        cmd = [sys.executable, os.path.abspath(__file__), "--solve", plan_path]
        commands.append(" ".join(cmd))
        with open(log, "w") as fh:
            try:
                rc = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, timeout=timeout).returncode
            except subprocess.TimeoutExpired:
                rc = None
        outputs.append(file_entry(log, root, "log"))
        with open(log, errors="replace") as fh:
            text = fh.read()
        conv[str(k)] = read_log(text, plan["end_criteria_db"])
        if rc != 0 or not os.path.isfile(one["out"]):
            why = "timeout after %g s" % timeout if rc is None else "exit code %s" % rc
            tail = "; ".join(l.strip() for l in text.strip().splitlines()[-3:])
            diagnostics.append({"severity": "error", "source": "openems", "message": "port %d: the solver failed (%s): %s" % (k, why, tail)})
            continue
        with open(one["out"]) as fh:
            columns[str(k)] = json.load(fh)
        os.remove(one["out"])
        c = conv[str(k)]
        if not c["end_criteria_reached"]:
            diagnostics.append({"severity": "warning" if allow else "error", "source": "openems",
                                "message": "port %d: the end criterion %g dB was not reached (energy %s dB after %s timesteps); the "
                                           "S-parameters can be wrong. Check the boundaries (MUR does not absorb the static field; "
                                           "use PML_8) and max_timesteps" % (k, plan["end_criteria_db"], c["energy_end_db"], c["timesteps"])})
    n = len(plan["ports"])
    doc = {"schema": COLUMNS_SCHEMA, "cell": cell, "ports": [p["name"] for p in plan["ports"]],
           "r_ohm": [p["r_ohm"] for p in plan["ports"]], "f_hz": plan["f_hz"], "columns": columns, "convergence": conv,
           "cells": plan["cells"], "boundaries": plan["boundaries"], "end_criteria_db": plan["end_criteria_db"]}
    col_path = os.path.join(work, "columns.json")
    with open(col_path, "w") as fh:
        json.dump(doc, fh)
    outputs.append(file_entry(col_path, root, "sparameter_columns"))
    outputs.append(file_entry(plan_path, root, "plan"))
    measurements = column_measurements(conv, allow)
    measurements["mesh_cells"] = measured(plan["cells"])
    measurements["runtime_s"] = measured(round(time.time() - t_start, 2), "s")
    errors = any(d["severity"] == "error" for d in diagnostics)
    if len(columns) == n and not errors:
        ts = write_from_columns(doc, work, cell)
        outputs.append(file_entry(ts, root, "touchstone"))
    elif len(columns) == n:
        diagnostics.append({"severity": "info", "source": "adapter", "message": "no Touchstone file: a run did not converge"})
    return {"contract": CONTRACT, "status": "failed" if errors else "completed", "tool": dict(TOOL), "input_files": files,
            "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics, "commands": commands,
            "report": ["openEMS: cell %s, %d ports, excited %s, %d cells" % (cell, n, ",".join(str(k) for k in plan["excite"]), plan["cells"])]
            + ["port %s: %s, energy %s dB after %s timesteps, %s s" % (k, "converged" if c["end_criteria_reached"] else "NOT converged",
                                                                     c["energy_end_db"], c["timesteps"], c["solve_s"]) for k, c in conv.items()]}


def write_from_columns(doc, work, cell):
    n = len(doc["ports"])
    r = set(doc["r_ohm"])
    if len(r) != 1:
        raise ValueError("the ports have different r_ohm; Touchstone needs one reference impedance")
    path = os.path.join(work, "%s.s%dp" % (re.sub(r"[^A-Za-z0-9_.-]", "_", cell), n))
    write_touchstone(path, doc["f_hz"], s_matrix(doc["columns"], n), r.pop(),
                     ["simra openems adapter, cell %s, ports %s" % (cell, " ".join(doc["ports"])),
                      "boundaries %s, %d cells, end criterion %g dB" % (" ".join(doc["boundaries"]), doc["cells"], doc["end_criteria_db"])])
    return path


# ---------------------------------------------------------------------------------------------------------- merge
def merge(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    os.makedirs(work, exist_ok=True)
    paths = inputs.get("columns")
    if not (isinstance(paths, list) and paths):
        return failure("input 'columns' is required: the columns.json files of the simulate runs (relative to the design root)")
    docs, files = [], []
    for p in paths:
        full = resolve(p, root)
        if not os.path.isfile(full):
            return failure("file not found: %s" % p)
        files.append(file_entry(full, root, "sparameter_columns"))
        with open(full) as fh:
            d = json.load(fh)
        if d.get("schema") != COLUMNS_SCHEMA:
            return failure("%s is not a %s file" % (p, COLUMNS_SCHEMA))
        docs.append(d)
    files = {"files": files, "complete": True}
    first = docs[0]
    for d in docs[1:]:
        for key in ("ports", "r_ohm", "f_hz", "cell", "boundaries"):
            if d[key] != first[key]:
                return failure("the column files differ in %s" % key, input_files=files)
    n = len(first["ports"])
    columns, conv = {}, {}
    for d in docs:
        for k, col in d["columns"].items():
            if k in columns:
                return failure("port %s is excited in more than one file" % k, input_files=files)
            columns[k] = col
            conv[k] = d["convergence"][k]
    missing = [str(k) for k in range(1, n + 1) if str(k) not in columns]
    measurements = column_measurements(conv, False)
    if missing:
        return failure("no column for port(s) %s" % ", ".join(missing), measurements, files)
    bad = [k for k, c in conv.items() if not c["end_criteria_reached"]]
    allow = bool(inputs.get("allow_unconverged", False))
    diagnostics = []
    if bad:
        diagnostics.append({"severity": "warning" if allow else "error", "source": "adapter",
                            "message": "the run of port(s) %s did not reach the end criterion" % ", ".join(sorted(bad))})
        if not allow:
            return dict(failure(diagnostics[0]["message"], measurements, files))
    doc = dict(first, columns=columns, convergence=conv)
    ts = write_from_columns(doc, work, first["cell"])
    return {"contract": CONTRACT, "status": "completed", "tool": dict(TOOL), "input_files": files,
            "outputs": [file_entry(ts, root, "touchstone")], "measurements": measurements, "diagnostics": diagnostics,
            "report": ["merged %d columns of cell %s into %s" % (n, first["cell"], os.path.basename(ts))]}


# ---------------------------------------------------------------------------------------------------------- solver
def solve(plan_path):
    """Child process: build the openEMS model of one excitation, run it, write the S-parameter column."""
    import numpy as np
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS
    with open(plan_path) as fh:
        plan = json.load(fh)
    exc = plan["excite"]
    fdtd = openEMS(NrTS=plan["max_timesteps"], EndCriteria=10 ** (plan["end_criteria_db"] / 10))
    fdtd.SetGaussExcite(plan["f0_hz"], plan["fc_hz"])
    fdtd.SetBoundaryCond(plan["boundaries"])
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    grid = csx.GetGrid()
    grid.SetDeltaUnit(1e-6)
    for d in plan["dielectrics"]:
        b = d["box"]
        csx.AddMaterial(d["name"], epsilon=d["eps"], kappa=d["sigma"]).AddBox(b[:3], b[3:], priority=10)
    for m in plan["metals"]:
        if m["kind"] == "sheet":
            prop = csx.AddConductingSheet(m["name"], conductivity=m["sigma"], thickness=m["thickness_um"] * 1e-6)
            for poly in m["polygons"]:
                p = np.array(poly)
                prop.AddPolygon([p[:, 0], p[:, 1]], "z", m["z"], priority=100)
        else:
            prop = csx.AddMaterial(m["name"], kappa=m["sigma"])
            for poly in m["polygons"]:
                p = np.array(poly)
                prop.AddLinPoly([p[:, 0], p[:, 1]], "z", m["z0"], m["z1"] - m["z0"], priority=110)
    ports = []
    for k, p in enumerate(plan["ports"], 1):
        ports.append(fdtd.AddLumpedPort(k, p["r_ohm"], [p["x"], p["y"], p["z0"]], [p["x"], p["y"], p["z1"]], "z",
                                        excite=1 if k == exc else 0, priority=150))
    for axis in "xyz":
        grid.SetLines(axis, plan["mesh"][axis])
    try:
        threads = len(os.sched_getaffinity(0))
    except AttributeError:
        threads = os.cpu_count() or 1
    print("simra: mesh %s, %d threads" % ([len(plan["mesh"][a]) for a in "xyz"], threads), flush=True)
    fdtd.Run(plan["sim_dir"], cleanup=True, numThreads=threads, verbose=1)
    f = np.array(plan["f_hz"])
    for p in ports:
        p.CalcPort(plan["sim_dir"], f, ref_impedance=p.R)
    inc = ports[exc - 1].uf_inc
    s = [p.uf_ref / inc for p in ports]
    with open(plan["out"], "w") as fh:
        json.dump({"re": [list(map(float, np.real(x))) for x in s], "im": [list(map(float, np.imag(x))) for x in s]}, fh)
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "--solve":
        return solve(argv[2])
    if len(argv) != 2:
        sys.stderr.write("usage: openems_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    operation = {"simulate": simulate, "merge": merge}.get(request.get("operation"))
    try:
        response = operation(request) if operation else failure("unknown operation: {}".format(request.get("operation")))
    except ValueError as e:
        response = failure(str(e))
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=2)
        f.write("\n")
    os.rename(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
