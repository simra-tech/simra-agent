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
NOISE_REL_BAND = 0.05
BOLTZMANN = 1.380649e-23


def use_points(used, f):
    """The data points in the band of use: the points inside [low, high] of a band (at least the nearest point to each
    end), or the nearest point to each harmonic."""
    import numpy as np
    mask = np.zeros(len(f), dtype=bool)
    labels = [label for label, _ in used]
    if labels and labels[0] == "band low end":
        lo, hi = used[0][1], used[1][1]
        mask |= (f >= lo * (1 - REL_TOL)) & (f <= hi * (1 + REL_TOL))
    for _, x in used:
        mask[int(np.argmin(np.abs(f - x)))] = True
    return mask


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
    names += [("passivity_margin", None), ("enforcement_max_abs_ds", None), ("band_min_hz", "Hz"), ("band_max_hz", "Hz"),
              ("use_max_abs_ds", None), ("use_max_abs_db", "dB"), ("noise_f0_hz", "Hz"), ("noise_verify_max_rel_error", None)]
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


def noise_check(lib, name, n, z0, model, f0, work_dir):
    """Thermal equilibrium check of the port noise: every port terminated in its Z0 (noisy resistors, the same
    temperature as the model), the noise voltage at port k must be 4kT Re Z_kk, Z the impedance matrix of the model in
    parallel with the terminations. Returns (max relative PSD error, commands, error message or None)."""
    import numpy as np
    import rational
    temp_k = 300.15
    y = rational.y_from_s(model.response(np.array([f0]))[0], z0) + np.diag(1.0 / np.asarray(z0, dtype=float))
    zt = np.linalg.inv(y)
    deck = os.path.join(work_dir, "noise_check.cir")
    body = ["* simra touchstone adapter: noise check of %s at %.9g Hz" % (name, f0), '.include "%s"' % lib]
    for k in range(n):
        body.append("rt%d n%d 0 %.12g" % (k + 1, k + 1, z0[k]))
    body += ["vdum n1 nd dc 0 ac 1", "rdum nd 0 1e15 noisy=0", "xdut %s %s" % (" ".join("n%d 0" % (k + 1) for k in range(n)), name), ".control"]
    for k in range(n):
        # "destroy all" after each run, so the spectrum of the next run is plot noise1 again
        body += ["noise v(n%d) vdum lin 1 %.12g %.12g" % (k + 1, f0, f0),
                 "let onk%d = noise1.onoise_spectrum" % (k + 1), "print onk%d" % (k + 1), "destroy all"]
    body += [".endc", ".end"]
    with open(deck, "w") as fh:
        fh.write("\n".join(body) + "\n")
    t0 = time.time()
    log = os.path.join(work_dir, "noise_check.log")
    with open(log, "w") as fh:
        code = subprocess.call(["ngspice", "-b", "noise_check.cir"], cwd=work_dir, stdout=fh, stderr=subprocess.STDOUT,
                               env=dict(os.environ, OMP_NUM_THREADS="1"))
    commands = [{"argv": ["ngspice", "-b", "noise_check.cir"], "exit_code": code, "runtime_s": round(time.time() - t0, 3)}]
    with open(log) as fh:
        found = dict(re.findall(r"^onk(\d+)\s*=\s*(\S+)", fh.read(), re.M))
    values = [float(found[str(k + 1)]) for k in range(n) if str(k + 1) in found]
    if code != 0 or len(values) != n:
        return None, commands, "ngspice exited with code %d and gave %d of %d values (see work/noise_check.log)" % (code, len(values), n)
    rel = max(abs(values[k] ** 2 / (4 * BOLTZMANN * temp_k * zt[k, k].real) - 1) for k in range(n))
    return float(rel), commands, None


# -------------------------------------------------------------------------------------------------------- operation
CHECK_KINDS = ("q", "re_z")


def parse_checks(checks, n):
    """(list of checks, None) or (None, message). A check: {name, kind "q" or "re_z", ports [i] or [i, j], band_hz
    [f_lo, f_hi], tol_rel, short (optional list of ports)}."""
    if checks is None:
        return [], None
    if not isinstance(checks, list):
        return None, "input 'checks' must be a list"
    out, names = [], set()
    for c in checks:
        if not isinstance(c, dict):
            return None, "input 'checks': each check is an object"
        name = c.get("name")
        if not isinstance(name, str) or not re.match(r"^[A-Za-z_]\w*$", name) or name in names:
            return None, "input 'checks': each check needs its own 'name' (letters, digits, _)"
        names.add(name)
        ports, short, band, tol = c.get("ports"), c.get("short") or [], c.get("band_hz"), c.get("tol_rel")
        ok_port = lambda p: isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= n
        if c.get("kind") not in CHECK_KINDS:
            return None, "check '%s': kind must be \"q\" (|Im Z| / Re Z) or \"re_z\" (Re Z)" % name
        if not (isinstance(ports, list) and len(ports) in (1, 2) and all(ok_port(p) for p in ports) and len(set(ports)) == len(ports)):
            return None, "check '%s': ports must be [i] or [i, j], port numbers from 1 to %d" % (name, n)
        if not (isinstance(short, list) and all(ok_port(p) for p in short) and not set(short) & set(ports)):
            return None, "check '%s': short must list ports other than the ports of the check" % name
        if not (isinstance(band, list) and len(band) == 2 and all(isinstance(x, (int, float)) for x in band) and 0 < band[0] <= band[1]):
            return None, "check '%s': band_hz must be [f_lo, f_hi] with 0 < f_lo <= f_hi" % name
        if not (isinstance(tol, (int, float)) and not isinstance(tol, bool) and tol > 0):
            return None, "check '%s': tol_rel must be a positive number (for example 0.05)" % name
        out.append({"name": name, "kind": c["kind"], "ports": ports, "short": short, "band": [float(band[0]), float(band[1])], "tol": float(tol)})
    return out, None


def run_checks(checks, rational, f, s, s_fit, z0):
    """The band-of-use checks: for each, the quantity from the data and from the model at the data points of its band,
    and the largest relative error. Returns (results, first problem or None)."""
    import numpy as np
    results, problem = [], None
    for c in checks:
        m = (f >= c["band"][0] * (1 - REL_TOL)) & (f <= c["band"][1] * (1 + REL_TOL)) & (f > 0)
        what = "%s of port%s %s" % ("Q" if c["kind"] == "q" else "Re Z", "s" if len(c["ports"]) == 2 else "", " and ".join(str(p) for p in c["ports"]))
        r = {"name": c["name"], "kind": c["kind"], "ports": c["ports"], "short": c["short"], "band_hz": c["band"], "tol_rel": c["tol"],
             "points": int(np.sum(m)), "status": "not run", "max_rel_error": None}
        results.append(r)
        if not np.any(m):
            r["reason"] = "no data point in the band"
            problem = problem or "refused: check '%s' (%s): the data has no point from %.6g Hz to %.6g Hz" % (c["name"], what, c["band"][0], c["band"][1])
            continue
        zd = rational.port_impedance(s[m], z0, c["ports"], c["short"])
        zm = rational.port_impedance(s_fit[m], z0, c["ports"], c["short"])
        qd, qm = (np.abs(zd.imag) / zd.real, np.abs(zm.imag) / zm.real) if c["kind"] == "q" else (zd.real, zm.real)
        if not np.all(np.isfinite(qd)) or np.any(qd == 0) or not np.all(np.isfinite(qm)):
            r["reason"] = "the quantity is not finite or zero in the data"
            problem = problem or "refused: check '%s' (%s): the quantity is zero or not finite in the band" % (c["name"], what)
            continue
        rel = np.abs(qm / qd - 1)
        k = int(np.argmax(rel))
        r.update({"status": "pass" if rel[k] <= c["tol"] else "fail", "max_rel_error": float(rel[k]), "at_hz": float(f[m][k]),
                  "data": float(qd[k]), "model": float(qm[k])})
        if rel[k] > c["tol"]:
            problem = problem or ("refused: check '%s': %s is %.4g in the model and %.4g in the data at %.6g Hz, a relative error of %.3g, above "
                                  "the tolerance %.3g. The limit on max |dS| does not bound this quantity; fit a narrower band (fit_band_hz) "
                                  "or another order" % (c["name"], what, qm[k], qd[k], f[m][k], rel[k], c["tol"]))
    return results, problem


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

    noise_band = (inputs.get("uses") or {}).get("noise_band_hz")
    noise_f0 = None
    if noise_band is not None:
        if not (isinstance(noise_band, list) and len(noise_band) == 2 and all(isinstance(x, (int, float)) for x in noise_band)
                and 0 < noise_band[0] <= noise_band[1]):
            return failure(tool, "input 'uses.noise_band_hz' must be [f_lo, f_hi] with 0 < f_lo <= f_hi", measurements, files)
        noise_f0 = math.sqrt(noise_band[0] * noise_band[1])
        if (noise_band[1] - noise_band[0]) / noise_f0 > NOISE_REL_BAND:
            return failure(tool, ("refused: the port noise of a fitted passive is exact at one frequency f0 (Twiss); "
                                  "uses.noise_band_hz %.6g Hz to %.6g Hz is wider than %.0f %% of f0. Give a narrow band "
                                  "around the noise frequencies, or fit one model per noise band" % (
                                      noise_band[0], noise_band[1], 100 * NOISE_REL_BAND)), measurements, files)
        error = coverage([("noise band low end", float(noise_band[0])), ("noise band high end", float(noise_band[1]))], False, f, dc_policy)
        if error:
            return failure(tool, error, measurements, files)

    checks, error = parse_checks(inputs.get("checks"), n)
    if error:
        return failure(tool, error, measurements, files)
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
    # The error in the band of use: the acceptance test is the error against the data where the simulation uses the model.
    use_mask = use_points(used, f)
    use_err = None
    if np.any(use_mask):
        ue = rational.errors(s[use_mask], s_fit[use_mask])
        mag_d, mag_m = np.abs(s[use_mask]), np.abs(s_fit[use_mask])
        big = mag_d >= 0.1
        db = float(np.max(np.abs(20 * np.log10(np.maximum(mag_m[big], 1e-12)) - 20 * np.log10(mag_d[big])))) if np.any(big) else 0.0
        use_err = {"points": int(np.sum(use_mask)), "max_abs_ds": ue["max"], "max_abs_db": db}
        measurements["use_max_abs_ds"] = {"value": ue["max"], "unit": None, "status": "measured"}
        measurements["use_max_abs_db"] = {"value": db, "unit": "dB", "status": "measured"}

    check_results, check_problem = run_checks(checks, rational, f, s, s_fit, z0)
    for r in check_results:
        if r["max_rel_error"] is not None:
            measurements["check_%s_max_rel_error" % r["name"]] = {"value": r["max_rel_error"], "unit": None, "status": "measured"}
            measurements["check_%s_data" % r["name"]] = {"value": r["data"], "unit": None if r["kind"] == "q" else "ohm", "status": "measured"}
            measurements["check_%s_model" % r["name"]] = {"value": r["model"], "unit": None if r["kind"] == "q" else "ohm", "status": "measured"}

    poles_hz = [[float(p.real * model.w / (2 * math.pi)), float(p.imag * model.w / (2 * math.pi))] for p in model.poles]
    report_json = {
        "numbers": "simulated (a rational fit of the data)",
        "input": display_path(full, root), "nports": n, "z0_ohm": z0.tolist(),
        "band_hz": [float(f[0]), float(f[-1])], "points": int(len(f)), "dc_point_in_data": bool(f[0] == 0),
        "uses": inputs.get("uses"), "dc_policy": dc_policy, "use_error": use_err, "checks": check_results,
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
    for r in check_results:
        if r["max_rel_error"] is not None:
            rpt.append("check %s (%s, ports %s): model %.4g, data %.4g at %.6g Hz, relative error %.3g (tolerance %.3g): %s" % (
                r["name"], "Q" if r["kind"] == "q" else "Re Z", r["ports"], r["model"], r["data"], r["at_hz"], r["max_rel_error"], r["tol_rel"], r["status"]))
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
    use_ds_limit = float(limits.get("use_max_abs_ds", max_ds))
    if err["max"] > max_ds:
        problem = "refused: the best fit has max |dS| %.3g (order %d), above the limit %.3g" % (err["max"], model.order, max_ds)
    elif use_err and use_err["max_abs_ds"] > use_ds_limit:
        problem = "refused: in the band of use the fit has max |dS| %.3g against the data, above the limit %.3g" % (use_err["max_abs_ds"], use_ds_limit)
    elif use_err and "use_max_abs_db" in limits and use_err["max_abs_db"] > float(limits["use_max_abs_db"]):
        problem = "refused: in the band of use the fit has a magnitude error of %.3g dB against the data, above the limit %.3g dB" % (
            use_err["max_abs_db"], float(limits["use_max_abs_db"]))
    elif lq_err and "l_rel_error" in limits and lq_err["l"] > float(limits["l_rel_error"]):
        problem = "refused: the L error %.3g is above the limit %.3g" % (lq_err["l"], float(limits["l_rel_error"]))
    elif lq_err and "q_rel_error" in limits and lq_err["q"] > float(limits["q_rel_error"]):
        problem = "refused: the Q error %.3g is above the limit %.3g" % (lq_err["q"], float(limits["q_rel_error"]))
    elif check_problem:
        problem = check_problem
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
                  "pins: p1 p1_ref p2 p2_ref ...; one netlist for ngspice and Xyce (C, G, F, L, R, V elements)",
                  ("noise: port noise (Twiss) exact at %.9g Hz, for noise analyses from %.9g Hz to %.9g Hz" % (noise_f0, noise_band[0], noise_band[1])
                   if noise_f0 else "noise: none (the model is noiseless; a noise analysis leaves out the loss noise of the passive)"),
                  "simra-fit: name=%s uses_band_hz=%.9g,%.9g dc=%d noise_band_hz=%s data_band_hz=%.9g,%.9g" % (
                      name, min(x for _, x in used), max(x for _, x in used), int(bool(dc)),
                      ("%.9g,%.9g" % tuple(noise_band)) if noise_f0 else "none", f[0], f[-1])]
        extra, noise_lam = (rational.noise_sources(model, z0, noise_f0) if noise_f0 else (None, None))
        if noise_f0:
            measurements["noise_f0_hz"] = {"value": noise_f0, "unit": "Hz", "status": "measured"}
            report_json["noise"] = {"f0_hz": noise_f0, "band_hz": noise_band, "re_y_eigenvalues_s": noise_lam}
        lib = os.path.join(work_dir, name + ".lib")
        with open(lib, "w") as fh:
            fh.write(rational.subcircuit(model, z0, name, header, extra))
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
        if noise_f0:
            if "ngspice" in verify and shutil.which("ngspice"):
                rel, cmds, why = noise_check(lib, name, n, z0, model, noise_f0, work_dir)
                commands += cmds
                if rel is None:
                    report_json["noise"]["verify"] = {"status": "failed", "reason": why}
                    diagnostics.append({"severity": "error", "source": "adapter", "message": "noise check in ngspice failed: %s" % why})
                else:
                    measurements["noise_verify_max_rel_error"] = {"value": rel, "unit": None, "status": "measured"}
                    report_json["noise"]["verify"] = {"status": "completed", "max_rel_error": rel}
                    rpt.append("noise check (thermal equilibrium at %.6g Hz, every port): max relative PSD error %.3g" % (noise_f0, rel))
                    if rel > 0.02:
                        diagnostics.append({"severity": "error", "source": "adapter", "message": (
                            "the port noise of the subcircuit differs from thermal equilibrium by %.3g (relative PSD); the "
                            "noise sources do not reproduce 4kT Re Z" % rel)})
            else:
                report_json["noise"]["verify"] = {"status": "not run", "reason": "ngspice not requested or not on the PATH"}
                measurements["noise_verify_max_rel_error"]["status"] = "missing"
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
