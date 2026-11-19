"""Operation "hb_limits" of the xyce adapter: the operating limits of each HBT under the drive of a harmonic-balance
experiment.

Inputs: the inputs of the hb operation (deck, libs, params, temp_c, tones, harmonics, startup_periods, ports, products,
dc_currents, sweep, ...), technology (optional pack name; default the pack of $PDK) and extra_limits (as device_limits
of the ngspice adapter). The limits come from the same pack section (ngspice.limits.<pdk>): the classes, the limits
with their sources, and hbt_cells (the HBT subcircuits of the PDK).

Method:
1. The HBT instances are the X lines of the deck (includes of the design root inlined) whose cell is an HBT cell. The
   terminal nodes are the first three nodes (c, b, e), with Xyce hierarchical names. The device element in the cell
   (for IHP SG13G2: Qnpn13G2 between the pins c, b, e) comes from the model libraries.
2. The hb operation runs with the terminal voltages and the lead currents IC and IB of each device in its hb_fd output.
3. From the two-sided spectrum of each point: the cycle mean of each voltage and current (the DC bin), and, with one
   tone, the waveform over one period (512 points) for the minimum and the maximum of V_BE, V_BC and V_CE at the same
   time (the peak V_CE is exact, not a bound from the extremes of V_BE and V_BC).
4. The limits of the pack apply to the cycle means (rows "mean": V_CE, V_BE, I_C per emitter, the cycle-mean base
   current) and to the peak voltages (rows "peak"). Each sweep point is a separate entry (device@point).

Not checked: the instantaneous conduction currents. The lead currents of Xyce include the charging currents of the
junction capacitances (at 122 GHz the terminal base current of a large-signal stage swings by tens of mA), so their
minimum and maximum say nothing about avalanche or the current per emitter. Their cycle means are exact, because the
mean of a charging current over a period is zero. limits.json lists this under "not_run".

Output work/limits.json (role "device_limits", schema simra.device_limits/0, as the ngspice operation) and the
measurements limit.<id>.<mean|peak>.
"""

import cmath
import json
import math
import os
import re
import sys

import xyce_adapter as xa

def ngspice_dir():
    """The ngspice adapter directory: SIMRA_ADAPTER_DIRS (set by the runner from the manifest uses_adapters), or the
    sibling directory of this adapter."""
    for entry in (os.environ.get("SIMRA_ADAPTER_DIRS") or "").split(":"):
        name, _, path = entry.partition("=")
        if name == "ngspice" and os.path.isdir(path):
            return path
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ngspice")


sys.path.insert(0, ngspice_dir())
import ngspice_adapter as na  # noqa: E402
import device_limits as dl  # noqa: E402
from monte_carlo import inline_deck  # noqa: E402

NOT_RUN = ("instantaneous conduction currents (minimum base current, peak current per emitter): the lead currents "
           "include the junction charging currents; only their cycle means are checked")


def lib_files(libs):
    """The model library files and the files they include or load (any section), at most 200."""
    out, todo = [], [p for p, _ in libs]
    while todo and len(out) < 200:
        path = os.path.realpath(todo.pop(0))
        if path in out or not os.path.isfile(path):
            continue
        out.append(path)
        with open(path, errors="replace") as f:
            for line in f:
                m = xa.INCLUDE_LINE.match(line)
                if m:
                    words = xa.split_args(m.group(2))
                    if words:
                        name = os.path.expandvars(words[0].strip("'\""))
                        todo.append(name if os.path.isabs(name) else os.path.join(os.path.dirname(path), name))
    return out


def cell_elements(files, cells):
    """{cell (lower case): (element name, model name)}: the first Q element of each HBT cell in the libraries."""
    out = {}
    for path in files:
        current = None
        with open(path, errors="replace") as f:
            for line in f:
                low = line.strip().lower()
                if low.startswith(".subckt"):
                    words = low.split()
                    current = words[1] if len(words) > 1 and words[1] in cells and words[1] not in out else None
                elif low.startswith(".ends"):
                    current = None
                elif current and low.startswith("q"):
                    words = [w for w in low.split() if "=" not in w]
                    if len(words) >= 5:
                        out[current] = (words[0], words[-1])
                        current = None
    return out


def hbt_instances(lines, cells):
    """[{path, prefix, cell, nodes: [c, b, e], params}] of the HBT cell instances, with Xyce node names."""
    subckts, top, current = {}, [], None
    for raw in lines:
        line = raw.split(";")[0].strip()
        low = line.lower()
        if not low or low.startswith("*"):
            continue
        if low.startswith(".subckt"):
            words = [w for w in low.split() if "=" not in w]
            current = words[1]
            subckts[current] = {"pins": words[2:], "x": []}
            continue
        if low.startswith(".ends"):
            current = None
            continue
        if not low.startswith("x"):
            continue
        words = line.split()
        params = {w.split("=", 1)[0].lower(): w.split("=", 1)[1] for w in words if "=" in w}
        pos = [w.lower() for w in words if "=" not in w]
        item = (pos[0], pos[1:-1], pos[-1], params)
        (subckts[current]["x"] if current else top).append(item)
    out = []

    def walk(items, prefix, pinmap, depth):
        def node(n):
            if n in pinmap:
                return pinmap[n]
            if n in ("0", "gnd", "gnd!"):
                return "0"
            return prefix + n
        for name, nodes, cell, params in items:
            if cell in cells:
                out.append({"path": (prefix + name).replace(":", "."), "prefix": prefix + name, "cell": cell,
                            "nodes": [node(n) for n in nodes[:3]], "params": params})
            elif cell in subckts and depth < 50:
                sub = subckts[cell]
                walk(sub["x"], prefix + name + ":", {p: node(n) for p, n in zip(sub["pins"], nodes)}, depth + 1)
    walk(top, "", {}, 0)
    return out


def waveform(spectrum, f0, n=512):
    """Samples over one period of the tone f0 from [(freq, X)] of a two-sided spectrum."""
    return [sum((x * cmath.exp(2j * math.pi * f * k / (n * f0))).real for f, x in spectrum) for k in range(n)]


def hb_limits(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "Xyce", "version": None}
    deck_path, libs, error = xa.deck_and_libs(root, inputs)
    if error:
        return xa.failure(tool, error)
    pdk = os.environ.get("PDK")
    pack_path, pack, error = na.find_technology(inputs.get("technology"), pdk, section="limits")
    if error:
        return xa.failure(tool, error)
    facts = pack["ngspice"]["limits"].get(pdk)
    if facts is None:
        return xa.failure(tool, "technology pack {} has no ngspice.limits.{}".format(pack["name"], pdk))
    classes = facts["classes"]
    limits = list(facts["limits"]) + list(inputs.get("extra_limits") or [])
    error = dl.check_limit_entries(limits, classes)
    if error:
        return xa.failure(tool, error)
    cells = {c.lower() for c in facts.get("hbt_cells", [])}
    elements = cell_elements(lib_files(libs), cells)
    devices = []
    for d in hbt_instances(inline_deck(deck_path, root), cells):
        if d["cell"] not in elements:
            continue
        element, model = elements[d["cell"]]
        cls = next((k for k, c in classes.items() if c["kind"] == "hbt" and c["letter"].lower() == element[0] and re.search(c["models"], model)), None)
        if cls is None:
            continue
        v = d["params"].get("nx", "1")
        n = na.spice_number(v) if not v.startswith("{") else None
        d.update({"device": "{}:{}".format(d["prefix"], element), "class": cls, "model": model,
                  "nx": int(round(n)) if n and n > 0 else None})
        devices.append(d)
    if not devices:
        return xa.failure(tool, "no HBT of the cells {} found in the deck (or no device element of the cell in the libraries)".format(", ".join(sorted(cells))))

    nodes = sorted({n for d in devices for n in d["nodes"] if n != "0"})
    prints = ["v({})".format(n) for n in nodes]
    prints += ["{}({})".format(q, d["device"]) for d in devices for q in ("ic", "ib")]
    hb_request = dict(request, inputs={k: v for k, v in inputs.items() if k not in ("technology", "extra_limits")})
    response = xa.hb(hb_request, extra_prints=prints)
    response["tool"]["technology"] = pack["name"]
    hb_path = os.path.join(work, "hb.json")
    if not os.path.isfile(hb_path):
        response["status"] = "failed"
        return response
    with open(hb_path) as f:
        run = json.load(f)
    tones = run["tones_hz"]
    spec, _ = xa.hb_inputs(hb_request["inputs"])
    offset = len(spec["ports"]) + len(spec["dc"])
    index = {p: offset + k for k, p in enumerate(prints)}
    entries, notes = [], [NOT_RUN]
    if len(tones) != 1:
        notes.append("peak voltages: more than one tone (the waveform over one period needs one tone)")
    many = len(run["points"]) > 1
    for p in run["points"]:
        if p.get("status") != "converged" or not p.get("fd_csv"):
            notes.append("point {}: {}".format(p["index"], p.get("status")))
            continue
        rows = xa.read_hb_csv(os.path.join(work, p["fd_csv"]))
        tol = 1e-6 * max(tones)

        def spectrum(q):
            return [(f, vals[index[q]]) for f, vals in rows]

        def mean(q):
            return next((vals[index[q]].real for f, vals in rows if abs(f) <= tol), None)

        def volt(n):
            return None if n == "0" else "v({})".format(n)
        for d in devices:
            c, b, e = (volt(n) for n in d["nodes"])
            vm = {n: (0.0 if q is None else mean(q)) for n, q in (("c", c), ("b", b), ("e", e))}
            base = {"vbe": vm["b"] - vm["e"], "vbc": vm["b"] - vm["c"], "ic": mean("ic({})".format(d["device"])),
                    "ib": mean("ib({})".format(d["device"]))}
            entry = {"device": d["device"].lower() + ("@{}".format(p["index"]) if many else ""), "class": d["class"],
                     "kind": "hbt", "model": d["model"], "nx": d["nx"], "dc": dl.derived("hbt", base, d["nx"])}
            if len(tones) == 1:
                w = {n: ([0.0] * 512 if q is None else waveform(spectrum(q), tones[0])) for n, q in (("c", c), ("b", b), ("e", e))}
                vbe = [x - y for x, y in zip(w["b"], w["e"])]
                vbc = [x - y for x, y in zip(w["b"], w["c"])]
                vce = [x - y for x, y in zip(w["c"], w["e"])]
                entry["peak"] = {"vbe": [min(vbe), max(vbe)], "vbc": [min(vbc), max(vbc)], "vce": [min(vce), max(vce)],
                                 "veb": [-max(vbe), -min(vbe)], "vcb": [-max(vbc), -min(vbc)]}
            if p.get("value") is not None:
                entry["point"] = p["value"]
            entries.append(entry)
    rows = dl.check_limits(limits, entries, "dc")
    for r in rows:
        r["at"] = "mean"
    if len(tones) == 1:
        rows += [r for r in dl.check_limits(limits, entries, "peak") if r["quantity"] in ("vbe", "vbc", "vce", "vcb", "veb")]
    path = os.path.join(work, "limits.json")
    with open(path, "w") as f:
        json.dump({"schema": dl.LIMITS_SCHEMA, "technology": pack["name"], "hb": {"tones_hz": tones, "points": len(run["points"])},
                   "devices": entries, "limits": rows, "not_run": notes}, f, indent=1)
        f.write("\n")
    response["outputs"].append({"path": os.path.relpath(path, root), "sha256": xa.sha256(path), "bytes": os.path.getsize(path), "role": "device_limits"})
    for r in rows:
        response["measurements"]["limit.{}.{}".format(r["id"], r["at"])] = {
            "value": r["value"], "unit": dl.UNITS.get(r["quantity"], "V"), "status": "measured" if r["value"] is not None else "missing"}
    response["measurements"]["devices_hbt"] = {"value": len(devices), "unit": None, "status": "measured"}
    response["diagnostics"].append({"severity": "info", "source": "adapter", "message": "not checked: " + NOT_RUN})
    for r in rows:
        if r["status"] == "fail":
            response["diagnostics"].append({"severity": "warning", "source": "work/limits.json", "message": "{} {} {} {:.4g} at {} ({}): fails {} {}".format(
                r["id"], r["quantity"], r["at"], r["value"], r["device"], r["class"], r["op"], r["limit"])})
    if not entries:
        response["status"] = "failed"
    return response
