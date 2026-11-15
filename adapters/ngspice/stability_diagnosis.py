"""Operation "stability_diagnosis" of the ngspice adapter: where and why the stability factor mu of a 2-port fails.

Inputs: deck (the S-parameter bench of the stage: two ngspice RF ports, "V... portnum k z0 Z"), touchstone (the
2-port of the stage that the bench wrote, relative to the design root), libs, params, temp_c (as simulate),
band_hz (optional [f_lo, f_hi]: the band of the mu check; default the band of the Touchstone file), window (optional,
default 0.15: the analysis band around the worst frequency, +-15 %), points (optional, default 31), max_nodes
(optional, default 200).

Method:
1. mu of the Touchstone 2-port in the band: the worst frequency f_mu, mu there, the bands with mu < 1, and the input
   and output impedances of the stage with the other port in Z0 (Zin from S11, Zout from S22).
2. The nodes of the design: the bench is inlined (its .include files in the design root) and each instance of a
   subcircuit of the root is walked. A node counts when it is a node of the bench or of a block with a PDK device (an
   X line to a subcircuit that the root does not define); the inner nodes of a block without devices (a line model,
   a fitted EM model) do not. Each element on a counted node is listed with its value or its device and parameters.
3. The driving-point impedance of each node: the RF ports become their Z0 (a resistor in series with the DC source),
   a 1 A AC current goes into one node at a time (alter of acmag), from f_mu (1 - window) to f_mu (1 + window).
   A node with Re Z < 0 near f_mu has a negative resistance (a loop with gain closes through it). A node whose Im Y
   crosses zero near f_mu resonates there.
4. Element pairs: on each suspect node (negative Re Z, or a resonance within the window), each ideal L and each
   capacitor (ideal C, cap_cmim, cap_rfcmim with 1.5 fF/um^2 for the MIM) whose resonance 1 / (2 pi sqrt(L C)) is
   within +-30 % of f_mu. Lines, fitted models and the device capacitances are listed as elements of the node, not
   paired: their reactance is not a single L or C.

The result is a diagnosis, not a verdict: the nodes and pairs are where to look. A node with Re Z < 0 can be the
input of the active device itself; the element pairs come from the ideal L and the capacitors only.

Output work/stability.json (role "stability_diagnosis"). Measurements: mu_min, f_mu_min_hz, bands_mu_below_1,
negative_resistance_nodes, resonant_nodes, element_pairs.
"""

import cmath
import json
import math
import os
import re
import subprocess

import ngspice_adapter as na
from monte_carlo import inline_deck

SCHEMA = "simra.stability_diagnosis/0"
MIM_F_PER_M2 = 1.5e-3  # 1.5 fF/um^2, the MIM of IHP SG13G2 (cap_cmim), for the pairs only
PORT = re.compile(r"\bportnum\s+(\d+)", re.IGNORECASE)
Z0 = re.compile(r"\bz0\s*=?\s*(\S+)", re.IGNORECASE)
PRINT_ROW = re.compile(r"^\s*\d+\s+(" + na.NUMBER + r")\s+(" + na.NUMBER + r"),\s*(" + na.NUMBER + r")\s*$")


def read_touchstone(path):
    """(f, S (K, 2, 2) complex, z0) of a version 1 2-port Touchstone file (MA, DB or RI; Hz to GHz)."""
    unit, fmt, z0, nums = 1.0, "MA", 50.0, []
    with open(path, errors="replace") as fh:
        for raw in fh:
            line = raw.split("!")[0].strip()
            if not line:
                continue
            if line.startswith("#"):
                w = line[1:].upper().split()
                unit = {"HZ": 1.0, "KHZ": 1e3, "MHZ": 1e6, "GHZ": 1e9}.get(w[0], 1.0) if w else 1.0
                fmt = next((x for x in w if x in ("MA", "DB", "RI")), "MA")
                if "R" in w:
                    z0 = float(w[w.index("R") + 1])
                continue
            nums.extend(float(x) for x in line.split())
    rows = [nums[i:i + 9] for i in range(0, len(nums) - 8, 9)]
    f, s = [], []
    for r in rows:
        f.append(r[0] * unit)
        v = []
        for a, b in zip(r[1::2], r[2::2]):
            if fmt == "RI":
                v.append(complex(a, b))
            elif fmt == "DB":
                v.append(cmath.rect(10 ** (a / 20), math.radians(b)))
            else:
                v.append(cmath.rect(a, math.radians(b)))
        # version 1 2-port order: S11 S21 S12 S22
        s.append([[v[0], v[2]], [v[1], v[3]]])
    return f, s, z0


def mu(s):
    s11, s12, s21, s22 = s[0][0], s[0][1], s[1][0], s[1][1]
    d = s11 * s22 - s12 * s21
    den = abs(s22 - d * s11.conjugate()) + abs(s12 * s21)
    return (1 - abs(s11) ** 2) / den if den > 0 else math.inf


def z_of(gamma, z0):
    return z0 * (1 + gamma) / (1 - gamma) if gamma != 1 else complex(math.inf, 0)


def cplx(z):
    return None if z is None or not (math.isfinite(z.real) and math.isfinite(z.imag)) else [z.real, z.imag]


def mu_summary(f, s, z0, band):
    pts = [(fk, mu(sk), sk) for fk, sk in zip(f, s) if band[0] <= fk <= band[1]]
    if not pts:
        return None
    fw, mw, sw = min(pts, key=lambda p: p[1])
    bands, start, prev = [], None, None
    for fk, mk, _ in pts:
        if mk < 1 and start is None:
            start = fk
        if mk >= 1 and start is not None:
            bands.append([start, prev])
            start = None
        prev = fk
    if start is not None:
        bands.append([start, prev])
    return {"f_hz": fw, "mu": mw, "bands_below_1_hz": bands, "s11": cplx(sw[0][0]), "s22": cplx(sw[1][1]),
            "zin_ohm": cplx(z_of(sw[0][0], z0)), "zout_ohm": cplx(z_of(sw[1][1], z0)), "z0_ohm": z0}


def fields(line):
    return line.split()


def subckt_table(lines):
    """{name: (pins, body lines)} of the inlined deck."""
    subs, cur = {}, None
    for line in lines:
        w = fields(line)
        if not w or w[0].startswith("*"):
            continue
        head = w[0].lower()
        if head == ".subckt":
            cur = w[1].lower()
            subs[cur] = ([x.lower() for x in w[2:] if "=" not in x], [])
        elif head == ".ends":
            cur = None
        elif cur is not None and not head.startswith("."):
            subs[cur][1].append(line)
    return subs


def top_lines(lines):
    out, depth, control = [], 0, False
    for line in lines:
        w = fields(line)
        if not w or w[0].startswith("*"):
            continue
        head = w[0].lower()
        if head == ".control":
            control = True
            continue
        if head == ".endc":
            control = False
            continue
        if control:
            continue
        if head == ".subckt":
            depth += 1
        elif head == ".ends":
            depth -= 1
        elif depth == 0 and not head.startswith("."):
            out.append(line)
    return out


def x_target(w):
    plain = [x for x in w if "=" not in x]
    return plain[-1].lower(), plain[1:-1], {x.split("=")[0].lower(): x.split("=", 1)[1] for x in w if "=" in x}


def element_nodes(w):
    """(kind, nodes, value text) of an element line (X lines handled by the caller)."""
    k = w[0][0].lower()
    if k in "rlc":
        return k, w[1:3], w[3] if len(w) > 3 else ""
    if k in "vi":
        return k, w[1:3], ""
    if k in "efgh":
        return k, w[1:3], " ".join(w[3:])
    return k, [], ""


def walk(lines, subs):
    """The elements of the design, flattened: [{name, kind, nodes (hierarchical), value, device, params, block}], and
    the counted nodes."""
    elements, counted = [], set()

    def block_counts(body):
        return any(fields(line)[0][0].lower() == "x" and x_target(fields(line))[0] not in subs for line in body)

    def visit(body, prefix, mapping, block):
        local = lambda n: "0" if n == "0" else mapping.get(n.lower(), prefix + n.lower())
        counts = block is None or block_counts(body)
        for line in body:
            w = fields(line)
            name = prefix + w[0].lower()
            if w[0][0].lower() == "x":
                target, nodes, params = x_target(w)
                hn = [local(n) for n in nodes]
                if target in subs:
                    pins, inner = subs[target]
                    elements.append({"name": name, "kind": "x", "nodes": hn, "value": "", "device": None,
                                     "subckt": target, "params": params, "block": block, "design": counts})
                    visit(inner, name + ".", dict(zip(pins, hn)), target)
                else:
                    elements.append({"name": name, "kind": "x", "nodes": hn, "value": "", "device": target,
                                     "subckt": None, "params": params, "block": block, "design": counts})
                if counts:
                    counted.update(n for n in hn if n != "0")
                continue
            kind, nodes, value = element_nodes(w)
            hn = [local(n) for n in nodes]
            elements.append({"name": name, "kind": kind, "nodes": hn, "value": value, "device": None, "subckt": None,
                             "params": {}, "block": block, "design": counts})
            if counts and kind in "rlc":
                counted.update(n for n in hn if n != "0")

    visit(top_lines(lines), "", {}, None)
    return elements, counted


def number(text, params):
    v = na.spice_number(text)
    if v is not None:
        return v
    m = re.match(r"^\{?([A-Za-z_]\w*)\}?$", text or "")
    return params.get(m.group(1).lower()) if m else None


def capacitance(e, params):
    if e["kind"] == "c":
        return number(e["value"], params)
    if e["device"] in ("cap_cmim", "cap_rfcmim"):
        w, l = number(e["params"].get("w", ""), params), number(e["params"].get("l", ""), params)
        if w and l:
            m = number(e["params"].get("m", "1"), params) or 1
            return MIM_F_PER_M2 * w * l * m
    return None


def deck_params(lines):
    out = {}
    for line in lines:
        if re.match(r"^\s*\.param\s", line, re.IGNORECASE):
            for k, v in re.findall(r"([A-Za-z_]\w*)\s*=\s*(\S+)", line):
                n = na.spice_number(v.strip("{}"))
                if n is not None:
                    out[k.lower()] = n
    return out


def port_lines(circuit):
    """The circuit with each RF port source as a DC source in series with its Z0 resistor; and the port count."""
    out, ports = [], 0
    for line in circuit:
        w = fields(line)
        if w and w[0][:1].lower() == "v" and PORT.search(line):
            ports += 1
            z = Z0.search(line)
            z0 = na.spice_number(z.group(1)) if z else 50.0
            dc = re.search(r"\bdc\s+(\S+)", line, re.IGNORECASE)
            mid = "simra_port_{}".format(w[0].lower())
            out.append("{} {} {} dc {}".format(w[0], w[1], mid, dc.group(1) if dc else "0"))
            out.append("R{}_z0 {} {} {} noisy=0".format(w[0], mid, w[2], z0 or 50.0))
        else:
            out.append(line)
    return out, ports


def stability_diagnosis(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    deck_path, libs, error = na.deck_and_libs(root, inputs)
    if error:
        return na.failure(tool, error)
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    ts = inputs.get("touchstone")
    if not isinstance(ts, str) or not os.path.isfile(os.path.join(root, ts)):
        return na.failure(tool, "input 'touchstone' is required: the 2-port that the bench wrote (path relative to the design root; run the bench first)")
    f, s, z0 = read_touchstone(os.path.join(root, ts))
    if not f:
        return na.failure(tool, "no 2-port data in {}".format(ts))
    band = inputs.get("band_hz") or [f[0], f[-1]]
    window = float(inputs.get("window", 0.15))
    points = int(inputs.get("points", 31))
    max_nodes = int(inputs.get("max_nodes", 200))
    summary = mu_summary(f, s, z0, band)
    if summary is None:
        return na.failure(tool, "no data point of {} in the band {} Hz to {} Hz".format(ts, band[0], band[1]))

    lines = inline_deck(deck_path, root)
    subs = subckt_table(lines)
    elements, counted = walk(lines, subs)
    params = deck_params(lines)
    nodes = sorted(counted)[:max_nodes]
    fmu = summary["f_hz"]
    lo, hi = fmu * (1 - window), fmu * (1 + window)

    circuit, nports = port_lines(na.circuit_lines(deck_path))
    head = ["* simra ngspice adapter: stability diagnosis for experiment {}".format(request.get("experiment"))]
    head += ['.lib "{}"{}'.format(p, " " + sec if sec else "") for p, sec in libs]
    inj = ["Isimra_inj{} 0 {} dc 0 ac 0".format(i, n) for i, n in enumerate(nodes)]
    ctl = [".control", "set num_threads=1", "op"]
    for i, n in enumerate(nodes):
        ctl += ["alter @isimra_inj{}[acmag]=1".format(i), "ac lin {} {} {}".format(points, lo, hi),
                "echo simra_node {}".format(i), "print v({})".format(n), "alter @isimra_inj{}[acmag]=0".format(i)]
    ctl += [".endc", ".end"]
    deck = os.path.join(work, "stability.cir")
    with open(deck, "w") as fh:
        fh.write("\n".join(head + circuit + settings + inj + ctl) + "\n")
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    log_path = os.path.join(work, "stability.log")
    with open(log_path, "w") as log:
        code = subprocess.call(["ngspice", "-b", "stability.cir"], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
    z = {}
    cur = None
    with open(log_path, errors="replace") as fh:
        for line in fh:
            m = re.match(r"^simra_node (\d+)", line)
            if m:
                cur = nodes[int(m.group(1))]
                z[cur] = []
                continue
            m = PRINT_ROW.match(line)
            if m and cur is not None:
                z[cur].append((float(m.group(1)), complex(float(m.group(2)), float(m.group(3)))))

    node_rows = []
    for n in nodes:
        data = z.get(n) or []
        if not data:
            node_rows.append({"node": n, "z_ohm": None, "status": "not_measured"})
            continue
        fz, zz = min(data, key=lambda p: abs(p[0] - fmu))
        re_min = min(data, key=lambda p: p[1].real)
        cross = None
        for (f1, z1), (f2, z2) in zip(data, data[1:]):
            y1, y2 = 1 / z1 if z1 else 0, 1 / z2 if z2 else 0
            if (y1.imag > 0) != (y2.imag > 0):
                t = y1.imag / (y1.imag - y2.imag)
                cross = f1 + t * (f2 - f1)
                break
        peak = max(data, key=lambda p: abs(p[1]))
        node_rows.append({"node": n, "z_ohm": cplx(zz), "f_hz": fz, "re_z_min_ohm": re_min[1].real,
                          "f_re_z_min_hz": re_min[0], "abs_z_peak_ohm": abs(peak[1]), "f_abs_z_peak_hz": peak[0],
                          "resonance_hz": cross, "negative_resistance": re_min[1].real < 0, "status": "measured"})
    negative = sorted((r for r in node_rows if r.get("negative_resistance")), key=lambda r: r["re_z_min_ohm"])
    resonant = [r for r in node_rows if r.get("resonance_hz") and not r.get("negative_resistance")]
    suspects = [r["node"] for r in negative] + [r["node"] for r in sorted(resonant, key=lambda r: -r["abs_z_peak_ohm"])][:10]

    on_node = {}
    for e in elements:
        if not e["design"]:
            continue  # the inside of a line or fitted model: its instance line is listed instead
        for n in e["nodes"]:
            on_node.setdefault(n, []).append(e)
    def describe(e):
        if e["kind"] == "x":
            what = e["device"] or e["subckt"]
            ps = " ".join("{}={}".format(k, v) for k, v in sorted(e["params"].items()))
            return "{} {}{}".format(e["name"], what, " " + ps if ps else "")
        return "{} {}".format(e["name"], e["value"])
    suspect_rows, pairs = [], []
    for n in suspects:
        els = on_node.get(n, [])
        suspect_rows.append({"node": n, "elements": [describe(e) for e in els]})
        ls = [(e, number(e["value"], params)) for e in els if e["kind"] == "l"]
        cs = [(e, capacitance(e, params)) for e in els if e["kind"] == "c" or e["device"] in ("cap_cmim", "cap_rfcmim")]
        for le, lv in ls:
            for ce, cv in cs:
                if lv and cv and lv > 0 and cv > 0:
                    fr = 1 / (2 * math.pi * math.sqrt(lv * cv))
                    if abs(fr / fmu - 1) <= 0.3:
                        pairs.append({"node": n, "l": describe(le), "c": describe(ce), "l_h": lv, "c_f": cv, "f_res_hz": fr})

    result = {"schema": SCHEMA, "touchstone": ts, "band_hz": band, "mu": summary, "window_hz": [lo, hi], "ports": nports,
              "nodes": node_rows, "negative_resistance_nodes": [r["node"] for r in negative],
              "resonant_nodes": [r["node"] for r in resonant], "suspects": suspect_rows, "element_pairs": pairs}
    path = os.path.join(work, "stability.json")
    with open(path, "w") as fh:
        json.dump(result, fh, indent=1)
        fh.write("\n")
    status = "completed" if code == 0 and any(r["status"] == "measured" for r in node_rows) else "failed"
    diagnostics = []
    if status == "failed":
        diagnostics.append({"severity": "error", "source": "work/stability.log", "message": "the impedance run gave no node impedance (exit code {})".format(code)})
    if nports != 2:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": "the deck has {} RF ports (portnum); the method expects 2".format(nports)})
    head_msg = "mu min {:.4g} at {:.4g} GHz".format(summary["mu"], fmu / 1e9)
    if summary["mu"] >= 1:
        head_msg += " (mu >= 1 in the band: nothing to diagnose; the nodes are at the worst frequency)"
    ports = []
    for side, key in (("input", "zin_ohm"), ("output", "zout_ohm")):
        zz = summary[key]
        if zz and zz[0] < 0:
            ports.append("{} port Re Z {:.3g} ohm (negative resistance, the other port in Z0)".format(side, zz[0]))
    if ports:
        head_msg += "; " + "; ".join(ports)
    near = sorted((r for r in resonant if abs(r["resonance_hz"] / fmu - 1) <= window), key=lambda r: abs(r["resonance_hz"] / fmu - 1))
    if near:
        head_msg += "; nodes that resonate near f_mu: {}".format(", ".join("{} ({:.4g} GHz)".format(r["node"], r["resonance_hz"] / 1e9) for r in near[:6]))
        head_msg += "; the elements of each node are in suspects of work/stability.json"
    if negative:
        head_msg += "; negative Re Z at {}".format(", ".join("{} ({:.3g} ohm at {:.4g} GHz)".format(r["node"], r["re_z_min_ohm"], r["f_re_z_min_hz"] / 1e9) for r in negative[:5]))
    if pairs:
        head_msg += "; L-C pairs near f_mu: {}".format("; ".join("{} with {} ({:.4g} GHz)".format(p["l"], p["c"], p["f_res_hz"] / 1e9) for p in pairs[:5]))
    diagnostics.append({"severity": "info", "source": "work/stability.json", "message": head_msg})
    return {"contract": na.CONTRACT, "status": status, "tool": tool, "input_files": None,
            "outputs": [{"path": na.display_path(path, root), "sha256": na.sha256(path), "bytes": os.path.getsize(path), "role": "stability_diagnosis"},
                        {"path": na.display_path(deck, root), "sha256": na.sha256(deck), "bytes": os.path.getsize(deck), "role": "deck"},
                        {"path": na.display_path(log_path, root), "sha256": na.sha256(log_path), "bytes": os.path.getsize(log_path), "role": "log"}],
            "measurements": {
                "mu_min": {"value": summary["mu"], "unit": None, "status": "measured"},
                "f_mu_min_hz": {"value": fmu, "unit": "Hz", "status": "measured"},
                "bands_mu_below_1": {"value": len(summary["bands_below_1_hz"]), "unit": None, "status": "measured"},
                "negative_resistance_nodes": {"value": len(negative), "unit": None, "status": "measured" if status == "completed" else "missing"},
                "resonant_nodes": {"value": len(resonant), "unit": None, "status": "measured" if status == "completed" else "missing"},
                "element_pairs": {"value": len(pairs), "unit": None, "status": "measured" if status == "completed" else "missing"}},
            "diagnostics": diagnostics}
