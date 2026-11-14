#!/usr/bin/env python3
"""Touchstone adapter for Simra Agent (contract simra.adapter/0).

Usage: touchstone_adapter.py <request.json>

Operation "fit_to_spice": a Touchstone file (S-parameters of a passive N-port, for example from an EM simulation) in,
a passive SPICE subcircuit out, with a typed error report. See README.md and rational.py for the method.

The adapter refuses (status "failed", an error diagnostic with the reason, every measurement failed) when:
  - the caller does not say which frequencies the simulation will use (input "uses");
  - the data band does not cover these frequencies (for example the harmonics of a harmonic-balance run);
  - the simulation solves a DC point and the data has no DC point, unless the caller accepts the DC value of the
    model (dc_policy "model");
  - the fit does not meet the limits;
  - the model is not passive after enforcement.
A rejected model is not written as a subcircuit.

numpy is required. ngspice and Xyce are used for the re-simulation (input "verify") when they are on the PATH.
"""

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

CONTRACT = "simra.adapter/0"
REL_TOL = 1e-9


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


def failure(tool, message, measurements=None, input_files=None, outputs=None, report=None):
    response = {"contract": CONTRACT, "status": "failed", "tool": tool, "input_files": input_files, "outputs": outputs or [],
                "measurements": measurements or {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}
    if report:
        response["report"] = report
    return response


def entry_name(i, j, n):
    return "s%d%d" % (i + 1, j + 1) if n <= 9 else "s%d_%d" % (i + 1, j + 1)


def measurement_names(n, lq):
    names = [("order", None), ("fit_max_abs_ds", None), ("fit_rms_abs_ds", None)]
    for i in range(n):
        for j in range(n):
            names += [(entry_name(i, j, n) + "_max_abs_ds", None), (entry_name(i, j, n) + "_rms_abs_ds", None)]
    if lq:
        names += [("l_max_rel_error", None), ("q_max_rel_error", None)]
    names += [("passivity_margin", None), ("enforcement_max_abs_ds", None), ("band_min_hz", "Hz"), ("band_max_hz", "Hz")]
    for sim in ("ngspice", "xyce"):
        names += [("verify_%s_max_abs_ds" % sim, None), ("verify_%s_model_max_abs_ds" % sim, None)]
    return names


def all_failed(n, lq, status="failed"):
    return {name: {"value": None, "unit": unit, "status": status} for name, unit in measurement_names(n, lq)}


def used_frequencies(uses):
    """(list of (label, f_hz) that the simulation uses above DC, dc (bool), error message or None)."""
    if not isinstance(uses, dict):
        return None, None, ("input 'uses' is required: the frequencies at which the simulation will use the model, "
                            "{\"band_hz\": [f_lo, f_hi]} or {\"f0_hz\": f0, \"harmonics\": H}, and \"dc\" (default true: "
                            "the simulation solves a DC point through the model, as every SPICE analysis does)")
    dc = uses.get("dc", True)
    if not isinstance(dc, bool):
        return None, None, "input 'uses.dc' must be true or false"
    if "band_hz" in uses:
        band = uses["band_hz"]
        if not (isinstance(band, list) and len(band) == 2 and all(isinstance(x, (int, float)) for x in band) and 0 < band[0] <= band[1]):
            return None, None, "input 'uses.band_hz' must be [f_lo, f_hi] with 0 < f_lo <= f_hi"
        return [("band low end", float(band[0])), ("band high end", float(band[1]))], dc, None
    f0, h = uses.get("f0_hz"), uses.get("harmonics", 1)
    if not isinstance(f0, (int, float)) or f0 <= 0 or not isinstance(h, int) or h < 1:
        return None, None, "input 'uses' needs band_hz, or f0_hz (> 0) with harmonics (an integer >= 1)"
    return [("harmonic %d" % k, float(k * f0)) for k in range(1, h + 1)], dc, None


def coverage(used, dc, data_f, dc_policy):
    """Error message when the data does not cover the used frequencies, else None. Also the DC note."""
    lo, hi = float(data_f[0]), float(data_f[-1])
    outside = [(label, f) for label, f in used if f < lo * (1 - REL_TOL) or f > hi * (1 + REL_TOL)]
    if outside:
        listed = ", ".join("%s %.6g Hz" % (label, f) for label, f in outside[:6])
        more = "" if len(outside) <= 6 else " and %d more" % (len(outside) - 6)
        return ("refused: the data covers %.6g Hz to %.6g Hz; the simulation uses %s%s outside it. A rational model "
                "outside its data band is an extrapolation, so the result would not be supported by the data. Give data "
                "that covers every frequency the simulation uses, or reduce the harmonics or the band" % (lo, hi, listed, more))
    if dc and lo > 0 and dc_policy != "model":
        return ("refused: the data has no point at 0 Hz (it starts at %.6g Hz), and the simulation solves a DC point "
                "through the model. The DC behaviour of the model (for example a DC path that the structure does not have) "
                "is not supported by the data. Give data with a DC point, set uses.dc to false when no DC current or "
                "voltage of the circuit depends on this element, or set dc_policy to \"model\" to accept the DC value of "
                "the model (the response then reports it)" % lo)
    return None


# ---------------------------------------------------------------------------------------------------- re-simulation
def tool_version(sim):
    try:
        if sim == "ngspice":
            out = subprocess.check_output(["ngspice", "--version"], stderr=subprocess.STDOUT, universal_newlines=True)
            m = re.search(r"ngspice-(\S+)", out)
        else:
            out = subprocess.check_output(["Xyce", "-v"], stderr=subprocess.STDOUT, universal_newlines=True)
            m = re.search(r"Xyce Release (\S+)", out) or re.search(r"(\d+\.\d+\S*)", out)
        return m.group(1) if m else None
    except (OSError, subprocess.CalledProcessError):
        return None


def ac_grid(f):
    """(f1, f2, points, uniform): the AC grid. The data points when they are a uniform grid above 0 Hz."""
    import numpy as np
    fp = f[f > 0]
    steps = np.diff(fp)
    if len(fp) >= 2 and np.allclose(steps, steps[0], rtol=1e-6):
        return float(fp[0]), float(fp[-1]), len(fp), True
    return float(fp[0]), float(fp[-1]), 401, False


def resimulate(sim, lib, name, n, z0, grid, work_dir):
    """S (K, n, n) of the subcircuit from an AC run per driven port, the commands, and an error message or None.
    The driven port has a 2 V source behind Z0; every port is terminated in its Z0. Then S_kj = V_k sqrt(Z0_j / Z0_k)
    for k != j and S_jj = V_j - 1."""
    import numpy as np
    f1, f2, npts, _ = grid
    s = np.zeros((npts, n, n), dtype=complex)
    commands = []
    env = dict(os.environ, OMP_NUM_THREADS="1")
    nodes = " ".join("n%d 0" % (k + 1) for k in range(n))
    for j in range(n):
        tag = "verify_%s_p%d" % (sim, j + 1)
        deck = os.path.join(work_dir, tag + ".cir")
        data = os.path.join(work_dir, tag + (".dat" if sim == "ngspice" else ".csv"))
        body = ["* simra touchstone adapter: %s re-simulation of %s, port %d driven" % (sim, name, j + 1),
                '.include "%s"' % lib]
        for k in range(n):
            if k == j:
                body += ["vs%d src%d 0 dc 0 ac 2" % (k + 1, k + 1), "rs%d src%d n%d %.12g" % (k + 1, k + 1, k + 1, z0[k])]
            else:
                body.append("rs%d n%d 0 %.12g" % (k + 1, k + 1, z0[k]))
        body.append("xdut %s %s" % (nodes, name))
        if sim == "ngspice":
            body += [".control", "ac lin %d %.12g %.12g" % (npts, f1, f2),
                     "wrdata %s %s" % (os.path.basename(data), " ".join("v(n%d)" % (k + 1) for k in range(n))), ".endc", ".end"]
            argv = ["ngspice", "-b", os.path.basename(deck)]
        else:
            body += [".ac lin %d %.12g %.12g" % (npts, f1, f2),
                     ".print ac format=csv file=%s %s" % (os.path.basename(data), " ".join("vr(n%d) vi(n%d)" % (k + 1, k + 1) for k in range(n))),
                     ".end"]
            argv = ["Xyce", os.path.basename(deck)]
        with open(deck, "w") as fh:
            fh.write("\n".join(body) + "\n")
        t0 = time.time()
        with open(os.path.join(work_dir, tag + ".log"), "w") as log:
            code = subprocess.call(argv, cwd=work_dir, stdout=log, stderr=subprocess.STDOUT, env=env)
        commands.append({"argv": argv, "exit_code": code, "runtime_s": round(time.time() - t0, 3)})
        if code != 0 or not os.path.isfile(data):
            return None, commands, "%s exited with code %d (see work/%s.log)" % (sim, code, tag)
        if sim == "ngspice":
            a = np.loadtxt(data, ndmin=2)
            freq = a[:, 0]
            v = [a[:, 3 * k + 1] + 1j * a[:, 3 * k + 2] for k in range(n)]
        else:
            a = np.loadtxt(data, delimiter=",", skiprows=1, ndmin=2)
            freq = a[:, 0]
            v = [a[:, 1 + 2 * k] + 1j * a[:, 2 + 2 * k] for k in range(n)]
        if len(freq) != npts:
            return None, commands, "%s gave %d of %d frequency points (see work/%s.log)" % (sim, len(freq), npts, tag)
        for k in range(n):
            s[:, k, j] = v[k] * math.sqrt(z0[j] / z0[k])
        s[:, j, j] -= 1.0
    return s, commands, None


# -------------------------------------------------------------------------------------------------------- operation
def fit_to_spice(request):
    root, work_dir = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "simra-touchstone", "version": "0.1.0"}
    try:
        import numpy as np
        import rational
    except ImportError as e:
        return failure(tool, "numpy is required: %s" % e)
    tool["numpy"] = np.__version__
    path = inputs.get("touchstone")
    if not isinstance(path, str):
        return failure(tool, "input 'touchstone' is required (the Touchstone file, relative to the design root)")
    full = path if os.path.isabs(path) else os.path.join(root, path)
    if not os.path.isfile(full):
        return failure(tool, "file not found: %s" % path)
    files = {"files": [file_entry(full, root, "touchstone")], "complete": True}
    try:
        data = rational.read_touchstone(full)
    except (ValueError, IndexError) as e:
        return failure(tool, "the Touchstone file cannot be read: %s" % e, input_files=files)
    n, z0 = data["nports"], data["z0"]
    f, s = data["f"], data["s"]
    lq_band = inputs.get("lq_band_hz")
    lq = isinstance(lq_band, list) and len(lq_band) == 2 and n <= 2
    if lq_band is not None and not lq:
        return failure(tool, "input 'lq_band_hz' must be [f_lo, f_hi] and needs a 1-port or a 2-port", all_failed(n, False), files)
    measurements = all_failed(n, lq)
    band = inputs.get("fit_band_hz")
    if band is not None:
        if not (isinstance(band, list) and len(band) == 2 and band[0] < band[1]):
            return failure(tool, "input 'fit_band_hz' must be [f_lo, f_hi]", measurements, files)
        keep = (f >= band[0] * (1 - REL_TOL)) & (f <= band[1] * (1 + REL_TOL))
        f, s = f[keep], s[keep]
        if len(f) < 4:
            return failure(tool, "fit_band_hz keeps %d data points; at least 4 are needed" % len(f), measurements, files)
    measurements["band_min_hz"] = {"value": float(f[0]), "unit": "Hz", "status": "measured"}
    measurements["band_max_hz"] = {"value": float(f[-1]), "unit": "Hz", "status": "measured"}

    # The guard comes first: a model that the simulation would use outside its data is not made.
    used, dc, error = used_frequencies(inputs.get("uses"))
    if error:
        return failure(tool, error, measurements, files)
    dc_policy = inputs.get("dc_policy")
    if dc_policy not in (None, "model"):
        return failure(tool, "input 'dc_policy' must be \"model\" or left out", measurements, files)
    error = coverage(used, dc, f, dc_policy)
    if error:
        return failure(tool, error, measurements, files,
                       report=["band %.6g to %.6g Hz, used up to %.6g Hz, dc %s" % (f[0], f[-1], max(x for _, x in used), dc)])

    limits = inputs.get("limits") or {}
    max_ds = float(limits.get("max_abs_ds", 0.01))
    name = inputs.get("name") or re.sub(r"\W", "_", os.path.splitext(os.path.basename(path))[0])
    if not re.match(r"^[A-Za-z_]\w*$", name):
        return failure(tool, "input 'name' must be a SPICE name (letters, digits, _)", measurements, files)
    order_in = inputs.get("order")
    max_order = int(inputs.get("max_order", 40))
    if order_in is not None and (not isinstance(order_in, int) or order_in < 1):
        return failure(tool, "input 'order' must be a positive integer (the number of poles)", measurements, files)
    candidates = [order_in] if order_in else list(range(2, max_order + 1, 2))

    t0 = time.time()
    search, model, err = [], None, None
    for order in candidates:
        try:
            m = rational.fit(f, s, order)
        except np.linalg.LinAlgError as e:
            search.append({"order": order, "error": str(e)})
            continue
        e = rational.errors(s, m.response(f))
        search.append({"order": m.order, "max_abs_ds": e["max"], "rms_abs_ds": e["rms"]})
        if err is None or e["max"] < err["max"]:
            model, err = m, e
        if e["max"] <= max_ds:
            model, err = m, e
            break
    if model is None:
        return failure(tool, "the vector fit failed at every order: %s" % search, measurements, files)
    fit_s = time.time() - t0

    # Passivity: the Hamiltonian test, then enforcement when it fails.
    before = rational.violation_bands(model)
    s_before = model.response(f)
    enforced, iterations, passed, d_clipped = False, 0, before is not None and not before, False
    if not passed:
        model, iterations, passed, d_clipped = rational.enforce(model, f)
        enforced = True
    s_fit = model.response(f)
    err = rational.errors(s, s_fit)
    grid = rational.check_grid(model, float(f[-1]))
    sig = rational.sigma_max(model, grid)
    margin = 1.0 - float(np.max(sig))
    crossings = rational.crossings(model)
    passive = passed and margin >= 0 and crossings is not None and len(crossings) == 0
    measurements["order"] = {"value": model.order, "unit": None, "status": "measured"}
    measurements["fit_max_abs_ds"] = {"value": err["max"], "unit": None, "status": "measured"}
    measurements["fit_rms_abs_ds"] = {"value": err["rms"], "unit": None, "status": "measured"}
    for i in range(n):
        for j in range(n):
            measurements[entry_name(i, j, n) + "_max_abs_ds"] = {"value": err["entry_max"][i][j], "unit": None, "status": "measured"}
            measurements[entry_name(i, j, n) + "_rms_abs_ds"] = {"value": err["entry_rms"][i][j], "unit": None, "status": "measured"}
    measurements["passivity_margin"] = {"value": margin, "unit": None, "status": "measured"}
    measurements["enforcement_max_abs_ds"] = {"value": float(np.max(np.abs(s_fit - s_before))), "unit": None, "status": "measured"}
    lq_err = None
    if lq:
        m = (f >= lq_band[0]) & (f <= lq_band[1])
        l0, q0 = rational.series_lq(s[m], f[m], z0)
        l1, q1 = rational.series_lq(s_fit[m], f[m], z0)
        if np.any(m):
            lq_err = {"l": float(np.max(np.abs(l1 / l0 - 1))), "q": float(np.max(np.abs(q1 / q0 - 1)))}
            measurements["l_max_rel_error"] = {"value": lq_err["l"], "unit": None, "status": "measured"}
            measurements["q_max_rel_error"] = {"value": lq_err["q"], "unit": None, "status": "measured"}
    s_dc = model.response(np.array([0.0]))[0]

    poles_hz = [[float(p.real * model.w / (2 * math.pi)), float(p.imag * model.w / (2 * math.pi))] for p in model.poles]
    report_json = {
        "numbers": "simulated (a rational fit of the data)",
        "input": display_path(full, root), "nports": n, "z0_ohm": z0.tolist(),
        "band_hz": [float(f[0]), float(f[-1])], "points": int(len(f)), "dc_point_in_data": bool(f[0] == 0),
        "uses": inputs.get("uses"), "dc_policy": dc_policy,
        "fit": {"order": model.order, "poles_hz": poles_hz, "search": search, "seconds": round(fit_s, 2),
                "error_vs_data": err, "limits": {"max_abs_ds": max_ds}, "lq": lq_err},
        "passivity": {"passive_before": bool(before is not None and not before), "enforced": enforced,
                      "iterations": iterations, "d_clipped": d_clipped, "passive": bool(passive),
                      "max_singular_value_sampled": float(np.max(sig)), "at_hz": float(grid[int(np.argmax(sig))]),
                      "sampled_band_hz": [0.0, float(grid[-1])], "hamiltonian_crossings": crossings},
        "s_at_dc_model": [[[float(x.real), float(x.imag)] for x in row] for row in s_dc],
    }
    rpt = ["model %s: %d ports, order %d, band %.6g to %.6g Hz (%d points)" % (name, n, model.order, f[0], f[-1], len(f)),
           "fit max |dS| %.3g, rms %.3g (limit %.3g)" % (err["max"], err["rms"], max_ds),
           "passive %s (enforced %s, margin %.3g, max singular value %.6f at %.6g Hz)" % (
               passive, enforced, margin, float(np.max(sig)), report_json["passivity"]["at_hz"])]
    diagnostics = []
    if dc and f[0] > 0:
        diag = ", ".join("S%d%d(0) = %.4g" % (i + 1, i + 1, s_dc[i, i].real) for i in range(n))
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "the data has no DC point; the simulation will use the DC value of the model (dc_policy \"model\"): %s. "
            "S = -1 is a short to the reference, +1 is open" % diag)})
        rpt.append("DC (model, not data): " + diag)
    report_path = os.path.join(work_dir, "fit.json")
    outputs = []
    problem = None
    if err["max"] > max_ds:
        problem = "refused: the best fit has max |dS| %.3g (order %d), above the limit %.3g" % (err["max"], model.order, max_ds)
    elif lq_err and "l_rel_error" in limits and lq_err["l"] > float(limits["l_rel_error"]):
        problem = "refused: the L error %.3g is above the limit %.3g" % (lq_err["l"], float(limits["l_rel_error"]))
    elif lq_err and "q_rel_error" in limits and lq_err["q"] > float(limits["q_rel_error"]):
        problem = "refused: the Q error %.3g is above the limit %.3g" % (lq_err["q"], float(limits["q_rel_error"]))
    elif not passive:
        problem = "refused: the model is not passive after enforcement (margin %.3g); a non-passive model can oscillate in one circuit and not in another" % margin
    commands = []
    if problem is None:
        header = ["%s: rational model of %s (S-parameters, %d ports), simra touchstone adapter, fit_to_spice" % (
                      name, os.path.basename(path), n),
                  "valid band: %.9g Hz to %.9g Hz (the data). Outside this band the model is an extrapolation." % (f[0], f[-1]),
                  "order %d; max |dS| %.3g against the data; passive (margin %.3g, sampled to %.3g Hz, Hamiltonian test)" % (
                      model.order, err["max"], margin, grid[-1]),
                  "DC: %s" % ("in the data" if f[0] == 0 else "from the model, not from the data"),
                  "pins: p1 p1_ref p2 p2_ref ...; one netlist for ngspice and Xyce (R, C, G, F, V elements only)"]
        lib = os.path.join(work_dir, name + ".lib")
        with open(lib, "w") as fh:
            fh.write(rational.subcircuit(model, z0, name, header))
        model_ts = os.path.join(work_dir, "%s.model.s%dp" % (name, n))
        rational.write_touchstone(model_ts, f, s_fit, z0, ["S of the rational model %s at the data frequencies (simulated)" % name])
        # Re-simulation of the subcircuit in each simulator, against the model and the data.
        verify = inputs.get("verify", ["ngspice", "xyce"])
        grid_ac = ac_grid(f) if np.any(f > 0) else None
        report_json["verify"] = {}
        for sim in ("ngspice", "xyce"):
            key = "verify_%s" % sim
            if sim not in verify:
                report_json["verify"][sim] = {"status": "not run", "reason": "not requested"}
                measurements[key + "_max_abs_ds"]["status"] = "missing"
                measurements[key + "_model_max_abs_ds"]["status"] = "missing"
                continue
            exe = "ngspice" if sim == "ngspice" else "Xyce"
            if shutil.which(exe) is None or grid_ac is None:
                reason = "%s is not on the PATH" % exe if grid_ac is not None else "no data above 0 Hz"
                report_json["verify"][sim] = {"status": "not run", "reason": reason}
                diagnostics.append({"severity": "warning", "source": "adapter", "message": "re-simulation in %s not run: %s" % (sim, reason)})
                continue
            tool[sim] = tool_version(sim)
            s_sim, cmds, why = resimulate(sim, lib, name, n, z0, grid_ac, work_dir)
            commands += cmds
            if s_sim is None:
                report_json["verify"][sim] = {"status": "failed", "reason": why}
                diagnostics.append({"severity": "error", "source": "adapter", "message": "re-simulation in %s failed: %s" % (sim, why)})
                continue
            f_ac = np.linspace(grid_ac[0], grid_ac[1], grid_ac[2])
            vs_model = rational.errors(model.response(f_ac), s_sim)
            measurements[key + "_model_max_abs_ds"] = {"value": vs_model["max"], "unit": None, "status": "measured"}
            entry = {"status": "completed", "vs_model": vs_model}
            if grid_ac[3]:
                vs_data = rational.errors(s[f > 0], s_sim)
                measurements[key + "_max_abs_ds"] = {"value": vs_data["max"], "unit": None, "status": "measured"}
                entry["vs_data"] = vs_data
            else:
                measurements[key + "_max_abs_ds"]["status"] = "missing"
                entry["vs_data"] = "not run: the data grid is not uniform, so the AC run cannot use the data points"
            report_json["verify"][sim] = entry
            rpt.append("%s re-simulation: max |dS| %.3g against the model%s" % (
                sim, vs_model["max"], "" if not grid_ac[3] else ", %.3g against the data" % entry["vs_data"]["max"]))
            if vs_model["max"] > 1e-4:
                diagnostics.append({"severity": "error", "source": "adapter", "message": (
                    "the %s result of the subcircuit differs from the rational model by %.3g (max |dS|); the netlist or the "
                    "simulator does not reproduce the model" % (sim, vs_model["max"]))})
        outputs.append(file_entry(lib, root, "subckt"))
        outputs.append(file_entry(model_ts, root, "touchstone"))
    else:
        report_json["refused"] = problem
        rpt.append(problem)
    with open(report_path, "w") as fh:
        json.dump(report_json, fh, indent=1)
        fh.write("\n")
    outputs.append(file_entry(report_path, root, "report"))
    for name_ in sorted(os.listdir(work_dir)):
        p = os.path.join(work_dir, name_)
        if os.path.isfile(p) and not any(o["path"] == display_path(p, root) for o in outputs):
            outputs.append(file_entry(p, root))
    status = "completed"
    if problem:
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": problem})
        status = "failed"
    elif any(d["severity"] == "error" for d in diagnostics):
        status = "failed"
    response = {"contract": CONTRACT, "status": status, "tool": tool, "input_files": files, "outputs": outputs,
                "measurements": measurements, "diagnostics": diagnostics, "report": rpt}
    if commands:
        response["commands"] = commands
    return response


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: touchstone_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    operation = {"fit_to_spice": fit_to_spice}.get(request.get("operation"))
    response = operation(request) if operation else failure(None, "unknown operation: {}".format(request.get("operation")))
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=2)
        f.write("\n")
    os.rename(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
