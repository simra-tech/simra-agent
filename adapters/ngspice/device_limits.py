"""Operation "device_limits" of the ngspice adapter: the operating limits of each device, at DC and (optional) the peak
of a transient.

Inputs: deck, libs, params, temp_c (as simulate); technology (optional pack name; default the pack of $PDK);
tran (optional {step_s, stop_s, start_s}: also the peak over a transient of the circuit of the deck); extra_limits
(optional list of limits of the same form as the pack; each needs a source or an assumption).

The pack (ngspice.limits.<pdk>) gives the device classes and the limits:
  classes: {<class>: {kind: "hbt" | "mos", letter, models (regex on the model name, lower case)}}
  limits:  [{id, class, quantity, op ("<=" or ">="), limit, models (optional regex), source | assumption, description}]
Quantities: hbt: vbe, vbc, vce (vbe - vbc), vcb (-vbc), veb (-vbe), ic, ib, ic_per_emitter (ic / Nx; Nx from the X
line of the netlist). mos: vgs, vds (magnitudes), id_per_finger (|ids| / nf).

Method: run 1 is "op" and "listing e" (full instance names and models; hashed, work/ngspice.log). Run 2 prints
@<device>[<quantity>] at the operating point and, with tran, the maximum and minimum of the voltages over the
transient (from start_s). Transient currents are not checked: the instance currents of the VBIC model include the
charge currents of the junctions (registry ngspice-sg13g2-vbic-transient-currents).

Output work/limits.json (role "device_limits"): {schema, technology, devices: [{device, class, model, nx, dc: {q: v},
peak: {q: [min, max]}}], limits: [{id, class, quantity, op, limit, source, assumption, at: "dc" | "peak", value,
device, status ("pass", "fail" or "not_measured"), reason}]}. Measurements: limit.<id>.<dc|peak> (the worst value)
and devices_<class>.
"""

import json
import os
import re

import ngspice_adapter as na
from monte_carlo import inline_deck

LIMITS_SCHEMA = "simra.device_limits/0"
LISTING = re.compile(r"^\s*\d+\s*:\s*([qmn]\.\S+)\s+(.*)$", re.IGNORECASE)
PRINTED = re.compile(r"^\s*(?:(maximum|minimum)\()?(@[^\s\)]+)\)?\s*=\s*(" + na.NUMBER + r")\s*$", re.IGNORECASE)
BASE = {"hbt": ["vbe", "vbc", "ic", "ib"], "mos": ["vgs", "vds", "ids", "nf"]}
PEAK = {"hbt": ["vbe", "vbc"], "mos": ["vgs", "vds"]}
QUANTITIES = {"hbt": ["vbe", "vbc", "vce", "vcb", "veb", "ic", "ib", "ic_per_emitter"], "mos": ["vgs", "vds", "id_per_finger"]}
UNITS = {"ic": "A", "ib": "A", "ic_per_emitter": "A", "id_per_finger": "A"}


def listing_devices(lines, classes):
    """[{device, class, kind, model}] of the "listing e" lines whose model matches a class."""
    out, seen = [], set()
    for line in lines:
        m = LISTING.match(line)
        if not m:
            continue
        name, rest = m.group(1).lower(), m.group(2).split()
        model = next((w for w in rest if ":" in w and "=" not in w), None)
        if model is None:
            model = next((rest[i - 1] for i, w in enumerate(rest) if "=" in w and i > 0), rest[-1] if rest else "")
        model = model.split(":")[-1].lower()
        for cname, c in classes.items():
            if name[0] == c["letter"].lower() and re.search(c["models"], model) and name not in seen:
                seen.add(name)
                out.append({"device": name, "class": cname, "kind": c["kind"], "model": model})
    return out


def subckt_tree(lines):
    """({subckt name: [x lines]}, [top x lines]) of a netlist without continuations; x line = (name, words, params)."""
    subckts, top, current = {}, [], None
    for raw in lines:
        line = raw.split(";")[0].strip()
        low = line.lower()
        if low.startswith(".subckt"):
            current = low.split()[1]
            subckts[current] = []
            continue
        if low.startswith(".ends"):
            current = None
            continue
        if not low.startswith("x"):
            continue
        words = line.split()
        params = {}
        for w in words:
            if "=" in w:
                k, v = w.split("=", 1)
                params[k.lower()] = v
        positional = [w.lower() for w in words if "=" not in w]
        (subckts[current] if current else top).append((positional[0], positional[-1], params))
    return subckts, top


def nx_map(lines, hbt_cells):
    """{instance path (x names joined by "."): Nx or None} of each HBT subcircuit instance in the hierarchy."""
    subckts, top = subckt_tree(lines)
    out = {}

    def walk(items, prefix, depth):
        for name, cell, params in items:
            path = prefix + name
            if cell in hbt_cells:
                v = params.get("nx", "1")
                n = na.spice_number(v) if not v.startswith("{") else None
                out[path] = int(round(n)) if n and n > 0 else None
            elif cell in subckts and depth < 50:
                walk(subckts[cell], path + ".", depth + 1)
    walk(top, "", 0)
    return out


def device_path(device):
    """The X path of a device: "q.xa.xq1.qnpn13g2" -> "xa.xq1"."""
    parts = device.split(".")
    return ".".join(parts[1:-1])


def control_text(devices, tran):
    lines = [".control", "op"]
    for d in devices:
        for q in BASE[d["kind"]]:
            lines.append("print @{}[{}]".format(d["device"], q))
    if tran:
        vecs = ["@{}[{}]".format(d["device"], q) for d in devices for q in PEAK[d["kind"]]]
        for i in range(0, len(vecs), 20):
            lines.append("save " + " ".join(vecs[i:i + 20]))
        lines.append("tran {} {} {}".format(tran["step_s"], tran["stop_s"], tran.get("start_s", 0)))
        for v in vecs:
            lines.append("print maximum({0}) minimum({0})".format(v))
    lines += [".endc", ".end"]
    return "\n".join(lines) + "\n"


def derived(kind, base, nx):
    """The quantities of a device from its printed values."""
    g = base.get
    if kind == "hbt":
        vbe, vbc, ic, ib = g("vbe"), g("vbc"), g("ic"), g("ib")
        return {"vbe": vbe, "vbc": vbc, "vce": None if None in (vbe, vbc) else vbe - vbc,
                "vcb": None if vbc is None else -vbc, "veb": None if vbe is None else -vbe, "ic": ic, "ib": ib,
                "ic_per_emitter": None if ic is None or not nx else ic / nx}
    vgs, vds, ids, nf = g("vgs"), g("vds"), g("ids"), g("nf")
    return {"vgs": None if vgs is None else abs(vgs), "vds": None if vds is None else abs(vds),
            "id_per_finger": None if ids is None or not nf else abs(ids) / nf}


def peak_values(kind, mm):
    """{quantity: [min, max]} from {base: [min, max]} of the transient."""
    out = {}
    if kind == "hbt":
        vbe, vbc = mm.get("vbe"), mm.get("vbc")
        if vbe:
            out["vbe"] = vbe
            out["veb"] = [-vbe[1], -vbe[0]]
        if vbc:
            out["vbc"] = vbc
            out["vcb"] = [-vbc[1], -vbc[0]]
        if vbe and vbc:
            # vce = vbe - vbc at the same time point is not available from the extremes; the bound is conservative.
            out["vce"] = [vbe[0] - vbc[1], vbe[1] - vbc[0]]
    else:
        for q in ("vgs", "vds"):
            if mm.get(q):
                lo, hi = mm[q]
                out[q] = [0.0 if lo <= 0 <= hi else min(abs(lo), abs(hi)), max(abs(lo), abs(hi))]
    return out


def check_limits(limits, devices, at):
    """Rows of each limit over the devices: the worst value."""
    rows = []
    for lim in limits:
        cands = [d for d in devices if d["class"] == lim["class"] and (not lim.get("models") or re.search(lim["models"], d["model"]))]
        row = {k: lim.get(k) for k in ("id", "class", "quantity", "op", "limit", "source", "assumption", "description")}
        row.update({"at": at, "value": None, "device": None, "status": "not_measured", "reason": None})
        if not cands:
            row["status"], row["reason"] = "not_applicable", "no device of class {}".format(lim["class"])
            rows.append(row)
            continue
        worst, missing = None, []
        for d in cands:
            if at == "dc":
                v = d["dc"].get(lim["quantity"])
            else:
                pair = d.get("peak", {}).get(lim["quantity"])
                v = None if pair is None else (pair[1] if lim["op"] == "<=" else pair[0])
            if v is None:
                missing.append(d["device"])
                continue
            if worst is None or (v > worst[0] if lim["op"] == "<=" else v < worst[0]):
                worst = (v, d["device"])
        if missing:
            row["reason"] = "no value for {} of {} devices ({})".format(lim["quantity"], len(missing), ", ".join(missing[:5]))
        if worst is not None:
            row["value"], row["device"] = worst
            if not missing:
                ok = worst[0] <= lim["limit"] if lim["op"] == "<=" else worst[0] >= lim["limit"]
                row["status"] = "pass" if ok else "fail"
        rows.append(row)
    return rows


def check_limit_entries(limits, classes):
    for lim in limits:
        if not isinstance(lim, dict) or lim.get("class") not in classes:
            return "limit {}: class must be one of {}".format(lim.get("id") if isinstance(lim, dict) else lim, ", ".join(classes))
        kind = classes[lim["class"]]["kind"]
        if lim.get("quantity") not in QUANTITIES[kind]:
            return "limit {}: quantity must be one of {}".format(lim.get("id"), ", ".join(QUANTITIES[kind]))
        if lim.get("op") not in ("<=", ">=") or isinstance(lim.get("limit"), bool) or not isinstance(lim.get("limit"), (int, float)):
            return "limit {}: op must be <= or >= and limit a number".format(lim.get("id"))
        if not lim.get("id") or not (lim.get("source") or lim.get("assumption")):
            return "limit {}: an id and a source or an assumption are required".format(lim.get("id"))
    return None


def device_limits(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    deck_path, libs, error = na.deck_and_libs(root, inputs)
    if error:
        return na.failure(tool, error)
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    pdk = os.environ.get("PDK")
    pack_path, pack, error = na.find_technology(inputs.get("technology"), pdk, section="limits")
    if error:
        return na.failure(tool, error)
    facts = pack["ngspice"]["limits"].get(pdk)
    if facts is None:
        return na.failure(tool, "technology pack {} has no ngspice.limits.{}".format(pack["name"], pdk))
    tool["technology"] = pack["name"]
    classes = facts["classes"]
    limits = list(facts["limits"]) + list(inputs.get("extra_limits") or [])
    error = check_limit_entries(limits, classes)
    if error:
        return na.failure(tool, error)
    tran = inputs.get("tran")
    if tran is not None:
        try:
            tran = {k: float(tran[k]) for k in ("step_s", "stop_s")} | {"start_s": float(tran.get("start_s", 0))}
        except (KeyError, TypeError, ValueError):
            return na.failure(tool, "input 'tran' must be {step_s, stop_s, start_s (optional)} in seconds")
        if not 0 < tran["step_s"] < tran["stop_s"] or not 0 <= tran["start_s"] < tran["stop_s"]:
            return na.failure(tool, "input 'tran': 0 < step_s < stop_s and 0 <= start_s < stop_s")

    circuit = na.circuit_lines(deck_path)
    head = ["* simra ngspice adapter: device limits for experiment {}".format(request.get("experiment"))]
    head += ['.lib "{}"{}'.format(p, " " + s if s else "") for p, s in libs]
    with open(os.path.join(work, "list.cir"), "w") as f:
        f.write("\n".join(head + circuit + settings) + "\n.control\nop\nlisting e\n.endc\n.end\n")
    response = na.run(request, tool, "list.cir", deck_path, libs, None, [(pack_path, "technology")])
    with open(os.path.join(work, "ngspice.log"), errors="replace") as f:
        devices = listing_devices(f.read().splitlines(), classes)
    if response["status"] != "completed" or not devices:
        response["status"] = "failed"
        response["diagnostics"].insert(0, {"severity": "error", "source": "work/ngspice.log", "message":
                                           "no operating point, or no device of the classes {} in 'listing e'".format(", ".join(classes))})
        return response

    with open(os.path.join(work, "values.cir"), "w") as f:
        f.write("\n".join(head + circuit + settings) + "\n" + control_text(devices, tran))
    import subprocess
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    with open(os.path.join(work, "values.log"), "w") as log:
        code = subprocess.call(["ngspice", "-b", "values.cir"], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
    base, mm = {}, {}
    with open(os.path.join(work, "values.log"), errors="replace") as f:
        for line in f:
            m = PRINTED.match(line)
            if not m:
                continue
            vec = m.group(2).lower()
            dev, q = vec[1:].split("[")[0], vec.split("[")[1].rstrip("]")
            if m.group(1):
                mm.setdefault(dev, {}).setdefault(q, [None, None])[0 if m.group(1).lower() == "minimum" else 1] = float(m.group(3))
            else:
                base.setdefault(dev, {})[q] = float(m.group(3))
    hbt_cells = {c.lower() for c in facts.get("hbt_cells", [])}
    nx = nx_map(inline_deck(deck_path, root), hbt_cells)
    for d in devices:
        d["nx"] = nx.get(device_path(d["device"])) if d["kind"] == "hbt" else None
        d["dc"] = derived(d["kind"], base.get(d["device"], {}), d["nx"])
        if tran:
            d["peak"] = peak_values(d["kind"], {q: v for q, v in mm.get(d["device"], {}).items() if None not in v})
    rows = check_limits(limits, devices, "dc") + (check_limits(limits, devices, "peak") if tran else [])
    if tran:
        rows = [r for r in rows if not (r["at"] == "peak" and r["quantity"] not in ("vbe", "vbc", "vce", "vcb", "veb", "vgs", "vds"))]
    if code != 0:
        response["status"] = "failed"
        response["diagnostics"].insert(0, {"severity": "error", "source": "work/values.log", "message": "the value run exited with code {}".format(code)})
    path = os.path.join(work, "limits.json")
    with open(path, "w") as f:
        json.dump({"schema": LIMITS_SCHEMA, "technology": pack["name"], "tran": tran, "devices": devices, "limits": rows}, f, indent=1)
        f.write("\n")
    response["outputs"].append({"path": na.display_path(path, root), "sha256": na.sha256(path), "bytes": os.path.getsize(path), "role": "device_limits"})
    m = {}
    for r in rows:
        m["limit.{}.{}".format(r["id"], r["at"])] = {"value": r["value"], "unit": UNITS.get(r["quantity"], "V"),
                                                    "status": "measured" if r["value"] is not None else "missing"}
    for c in classes:
        m["devices_" + c] = {"value": sum(1 for d in devices if d["class"] == c), "unit": None, "status": "measured"}
    response["measurements"] = m
    for r in rows:
        if r["status"] == "fail":
            response["diagnostics"].append({"severity": "warning", "source": "work/limits.json", "message":
                                            "{} {} {} {} {}: {} has {:.4g}".format(r["id"], r["at"], r["quantity"], r["op"], r["limit"], r["device"], r["value"])})
    return response
