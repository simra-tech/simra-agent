"""Operation "assemble_dc" of the ngspice adapter: the DC operating point of a large deck (a whole chip of blocks)
from the operating points of its parts.

Method (clamp homotopy with seeds):
  1. Seeds: node voltages from earlier runs (block-alone operating points, or an earlier assembly), with a name map from
     the testbench names of a block to the names in the deck (for example "x1." to "xcore.xif."). Later seeds win.
  2. Each seeded node gets a clamp current I = g (V - V_seed) with g = 10^(-decades (1 - x)) S. A .dc sweep of x from N
     to 0 (N = number of phases) releases the clamps: the nodes of phase k (by node-name prefix) go from g = 1 S to
     g = 10^-decades S while x goes from N - k + 1 to N - k. Each sweep point starts from the solution of the point
     before. Phase 1 is released first; nodes that match no phase are released after the listed phases.
  3. Free operating point: a plain op without clamps, with .nodeset from the end of the sweep. Its node voltages are the
     DC point (dc_point.json, usable as a seed of the next assembly). The adapter reports the largest change between the
     end of the sweep and the free op.

The sparse solver is the default (KLU failed on a large mixed bipolar and PSP deck where sparse passed).
"""

import json
import math
import os
import re
import subprocess

import ngspice_adapter as na

V_KEY = re.compile(r"^v\((.+)\)$", re.IGNORECASE)


def node_key(name):
    """'V(XCORE.N1)' or 'xcore.n1' -> 'xcore.n1'."""
    m = V_KEY.match(name.strip())
    return (m.group(1) if m else name).strip().lower()


def read_seeds(seeds, root):
    """{node: volts} from the seed list: [{file, from_prefix, to_prefix, only_prefix}]; later seeds win. A file is
    {"v(node)": volts, ...} (or {"nodes": {...}}, as dc_point.json); keys that are not node voltages (i(...), x) are
    left out. Raises ValueError with the reason."""
    if not isinstance(seeds, list) or not seeds:
        raise ValueError("input 'seeds' is required: a list of {file, from_prefix, to_prefix, only_prefix}")
    out = {}
    for n, s in enumerate(seeds, 1):
        if not isinstance(s, dict) or not isinstance(s.get("file"), str):
            raise ValueError("seed %d: file is required" % n)
        path = s["file"] if os.path.isabs(s["file"]) else os.path.join(root, s["file"])
        if not os.path.isfile(path):
            raise ValueError("seed %d: file not found: %s" % (n, s["file"]))
        with open(path) as fh:
            doc = json.load(fh)
        values = doc.get("nodes", doc) if isinstance(doc, dict) else None
        if not isinstance(values, dict):
            raise ValueError("seed %d: %s is not an object of node voltages" % (n, s["file"]))
        src, dst, only = (s.get("from_prefix") or "").lower(), (s.get("to_prefix") or "").lower(), (s.get("only_prefix") or "").lower()
        for k, v in values.items():
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                continue
            kl = k.strip().lower()
            if kl.startswith("i(") or "#" in kl or not (V_KEY.match(kl) or "(" not in kl):
                continue
            node = node_key(kl)
            if node in ("0", "gnd"):
                continue
            if src:
                if not node.startswith(src):
                    continue
                node = dst + node[len(src):]
            elif dst:
                node = dst + node
            if only and not node.startswith(only):
                continue
            out[node] = float(v)
    if not out:
        raise ValueError("the seeds give no node voltage (check the prefixes)")
    return out


def phase_of(node, phases):
    """The phase of a node: the first phase with a matching prefix, or else one phase after the listed phases."""
    for k, prefixes in enumerate(phases, 1):
        if any(node.startswith(p.lower()) for p in prefixes):
            return k
    return len(phases) + 1


def clamp_lines(seed, phases, decades):
    """The clamp sources and the sweep source; returns (lines, x_start)."""
    n = max(phase_of(node, phases) for node in seed) if seed else 1
    n = max(n, len(phases))
    a = decades * math.log(10.0)
    lines = ["* simra assemble_dc: clamp homotopy, %d nodes, %d phase(s), %g decades" % (len(seed), n, decades),
             "Vsimra_gcl simra_gcl 0 %d" % n]
    for i, (node, v) in enumerate(sorted(seed.items())):
        k = phase_of(node, phases)
        x = "min(max(v(simra_gcl)-%d,0),1)" % (n - k) if n > 1 else "min(v(simra_gcl),1)"
        lines.append("Bsimra_cl%d %s 0 I=exp(%.9g*(%s-1))*(v(%s)-(%.9g))" % (i, node, a, x, node, v))
    return lines, n


def read_raw_ascii(path):
    """(names, points) of an ngspice ASCII raw file (the last plot): points is a list of value lists. Names of
    variables that are not node voltages (currents, internal device nodes with "#") start with "#"."""
    with open(path, errors="replace") as fh:
        lines = fh.read().splitlines()
    starts = [i for i, l in enumerate(lines) if l.startswith("Title:")]
    if not starts:
        raise ValueError("not an ASCII raw file")
    lines = lines[starts[-1]:]
    nvars = npts = None
    names, values_at = [], None
    for i, l in enumerate(lines):
        if l.startswith("No. Variables:"):
            nvars = int(l.split(":")[1])
        elif l.startswith("No. Points:"):
            npts = int(l.split(":")[1])
        elif l.startswith("Variables:"):
            for l2 in lines[i + 1:i + 1 + nvars]:
                parts = l2.split()
                voltage = len(parts) > 2 and parts[2].lower() == "voltage" and "#" not in parts[1]
                names.append(parts[1] if voltage else "#" + parts[1])
        elif l.startswith("Values:"):
            values_at = i + 1
            break
    if values_at is None or nvars is None:
        raise ValueError("no values in the raw file")
    tokens = " ".join(lines[values_at:]).split()
    points, k = [], 0
    while k < len(tokens) and len(points) < (npts or 10 ** 9):
        k += 1  # point index
        row = []
        for _ in range(nvars):
            t = tokens[k]
            row.append(float(t.split(",")[0]))
            k += 1
        points.append(row)
    return names, points


def solver_lines(inputs):
    solver = inputs.get("solver", "sparse")
    if solver not in ("sparse", "klu"):
        raise ValueError("input 'solver' must be sparse or klu")
    # The ngspice default is the Sparse 1.3 solver; KLU is chosen with ".option klu".
    lines = [".option klu"] if solver == "klu" else []
    opts = inputs.get("options")
    if opts is not None:
        if not isinstance(opts, str) or "\n" in opts:
            raise ValueError("input 'options' must be one line of ngspice options, for example 'reltol=1e-3 itl1=1000'")
        lines.append(".options %s" % opts)
    return lines


def write_deck(path, title, libs, circuit, settings, extra, control):
    with open(path, "w") as f:
        f.write("* %s\n" % title)
        for p, section in libs:
            f.write('.lib "{}"{}\n'.format(p, " " + section if section else ""))
        f.write("\n".join(circuit) + "\n")
        for l in settings + extra:
            f.write(l + "\n")
        f.write(".control\n%s\n.endc\n.end\n" % "\n".join(control))


def assemble_dc(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    deck_path, libs, error = na.deck_and_libs(root, inputs)
    if error:
        return na.failure(tool, error)
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    phases = inputs.get("phases") or []
    if not (isinstance(phases, list) and all(isinstance(p, list) and p and all(isinstance(x, str) for x in p) for p in phases)):
        return na.failure(tool, "input 'phases' must be a list of node-name prefix lists, for example [[\"xcore.xbias.\"], [\"xcore.\"]]")
    decades = float(inputs.get("decades", 12))
    steps = int(inputs.get("steps", 50))
    try:
        seed = read_seeds(inputs.get("seeds"), root)
        solver = solver_lines(inputs)
    except ValueError as e:
        return na.failure(tool, str(e))
    if steps < 2 or decades <= 0:
        return na.failure(tool, "input 'steps' must be >= 2 and 'decades' > 0")
    circuit = na.circuit_lines(deck_path)
    clamp, n = clamp_lines(seed, phases, decades)
    total = n * steps + 1
    write_deck(os.path.join(work, "clamp.cir"), "simra ngspice adapter: assemble_dc clamp sweep", libs, circuit, settings,
               solver + clamp, ["set num_threads=1", "set filetype=ascii", "dc Vsimra_gcl %d 0 %.9g" % (n, -1.0 / steps),
                                "write clamp.raw"])
    response = na.run(request, tool, "clamp.cir", deck_path, libs, None)
    diagnostics = response["diagnostics"]
    m = response["measurements"] = {}
    m["nodes_seeded"] = {"value": len(seed), "unit": None, "status": "measured"}
    m["clamp_points_total"] = {"value": total, "unit": None, "status": "measured"}
    names, points = [], []
    raw = os.path.join(work, "clamp.raw")
    if os.path.isfile(raw):
        try:
            names, points = read_raw_ascii(raw)
        except (ValueError, IndexError) as e:
            diagnostics.append({"severity": "warning", "source": "adapter", "message": "clamp.raw cannot be read: %s" % e})
    keys = [node_key(x) for x in names]
    xi = keys.index("simra_gcl") if "simra_gcl" in keys else None
    x_last = points[-1][xi] if points and xi is not None else None
    reached = bool(points) and x_last is not None and abs(x_last) < 1e-9 and len(points) >= total
    m["clamp_points_done"] = {"value": len(points), "unit": None, "status": "measured"}
    m["clamp_x_last"] = {"value": x_last, "unit": None, "status": "measured" if x_last is not None else "missing"}
    m["clamp_reached_end"] = {"value": 1 if reached else 0, "unit": None, "status": "measured"}
    summary = {"seeded": len(seed), "phases": phases, "decades": decades, "steps_per_phase": steps,
               "clamp_points": len(points), "clamp_points_total": total, "clamp_x_last": x_last, "clamp_reached_end": reached}
    end = {}
    if points:
        end = {k: points[-1][i] for i, k in enumerate(keys) if i > 0 and not names[i].startswith("#")}
        end.pop("simra_gcl", None)
    if not reached:
        phase = None if x_last is None else n - int(math.floor(x_last)) if x_last < n else 1
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": (
            "the clamp sweep stopped at x = %s (%d of %d points)%s; the nodes of that phase do not reach a DC point without "
            "their clamps. Add a seed for them, split the phase, or use more steps" % (
                x_last, len(points), total, "" if phase is None else ", in phase %d" % phase))})
        response["status"] = "failed"
    free_ok = None
    dc = end
    if reached and inputs.get("free_op", True):
        nodeset = [".nodeset %s" % " ".join("v(%s)=%.9g" % (k, v) for k, v in sorted(end.items())[i:i + 50])
                   for i in range(0, len(end), 50)]
        write_deck(os.path.join(work, "free.cir"), "simra ngspice adapter: assemble_dc free operating point", libs, circuit,
                   settings, solver + nodeset, ["set num_threads=1", "set filetype=ascii", "op", "write free.raw"])
        with open(os.path.join(work, "free.log"), "w") as log:
            env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
            code = subprocess.call(["ngspice", "-b", "free.cir"], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
        free = {}
        fr = os.path.join(work, "free.raw")
        if code == 0 and os.path.isfile(fr):
            try:
                fn, fp = read_raw_ascii(fr)
                free = {node_key(x): fp[0][i] for i, x in enumerate(fn) if not x.startswith("#")}
            except (ValueError, IndexError):
                free = {}
        free_ok = bool(free)
        m["free_op_converged"] = {"value": 1 if free_ok else 0, "unit": None, "status": "measured"}
        if free_ok:
            common = [k for k in free if k in end]
            dv = max((abs(free[k] - end[k]) for k in common), default=0.0)
            m["free_op_max_dv_v"] = {"value": dv, "unit": "V", "status": "measured"}
            lost = sorted(k for k in seed if k not in free)
            m["seeds_not_in_circuit"] = {"value": len(lost), "unit": None, "status": "measured"}
            if lost:
                diagnostics.append({"severity": "warning", "source": "adapter", "message": (
                    "%d seeded nodes are not nodes of the circuit (first: %s): check the seed prefixes" % (len(lost), ", ".join(lost[:5])))})
            summary.update(free_op_max_dv_v=dv, seeds_not_in_circuit=len(lost))
            dc = free
        else:
            diagnostics.insert(0, {"severity": "error", "source": "work/free.log", "message": (
                "the free operating point (no clamps, .nodeset from the end of the sweep) did not converge (exit code %s); "
                "dc_point.json has the end of the clamp sweep, which is not a DC point of the circuit" % code)})
            response["status"] = "failed"
        for src in inputs.get("currents") or []:
            val = None
            if free_ok:
                fn, fp = read_raw_ascii(fr)
                for i, x in enumerate(fn):
                    if x.lower() in ("#i(%s)" % src.lower(), "#%s#branch" % src.lower()):
                        val = fp[0][i]
            m["i_%s_a" % src.lower()] = {"value": val, "unit": "A", "status": "measured" if val is not None else "missing"}
    summary["free_op_converged"] = free_ok
    dc_path = os.path.join(work, "dc_point.json")
    with open(dc_path, "w") as fh:
        json.dump({"source": "free op" if free_ok else "end of the clamp sweep", "nodes": {"v(%s)" % k: v for k, v in sorted(dc.items())}}, fh, indent=0)
    with open(os.path.join(work, "assemble.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    response["outputs"] = []
    for name in sorted(os.listdir(work)):
        p = os.path.join(work, name)
        if os.path.isfile(p):
            e = {"path": na.display_path(p, root), "sha256": na.sha256(p), "bytes": os.path.getsize(p)}
            if name == "dc_point.json":
                e["role"] = "dc_point"
            response["outputs"].append(e)
    response["report"] = ["assemble_dc: %d seeded nodes, %d phase(s), clamp sweep %s (%d of %d points, x = %s)%s" % (
        len(seed), n, "reached the end" if reached else "STOPPED", len(points), total, x_last,
        "" if free_ok is None else "; free op %s" % ("converged, max change %.3g V" % summary.get("free_op_max_dv_v", 0) if free_ok else "FAILED"))]
    return response
