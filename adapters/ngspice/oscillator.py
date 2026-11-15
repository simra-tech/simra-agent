"""Operation "oscillator" of the ngspice adapter: steady-state frequency, amplitude and phase noise of an oscillator by
the impulse sensitivity function (ISF; Hajimiri and Lee) from ngspice transients.

Method:
  1. Reference transient to ref_stop_s with a fixed step tstep_s (the deck must start by itself, for example with a
     short current kick). f0 from the rising zero crossings of the output v(p) - v(n) after settle_s; the amplitude is
     half of the peak-to-peak output there.
  2. For each noise source and each of N phases tau_k = t0 + k T / N (t0 = the first zero crossing after settle_s):
     inject +q and -q with a short triangular pulse (a current between two nodes, charge dq_c, or a voltage in a series
     source of value 0, flux dl_vs), continue, and read the shift of the output zero crossings in the window
     [window_periods[0], window_periods[1]] periods after the injection: v_k = (t(+q) - t(-q)) / (2 q). The amplitude
     settles before the window; the phase shift stays.
  3. A white source with one-sided PSD S gives L(df) = mult * 1/2 * (f0/df)^2 * mean_k(v_k^2 S_k). S_k is a constant
     (psd_a2_hz for a current, psd_v2_hz for a series voltage), or the shot noise 2 q |i(tau_k)| of a vector of the
     reference run (input shot), or a list of one PSD per phase (a cyclostationary PSD from elsewhere). A shot vector
     must be a conduction current: in a transient, the terminal currents of a bipolar model (and @q[ib] of VBIC)
     include the charge currents, which are not noise. mult counts identical sources by symmetry. The total is the sum over the sources.
     output_multiplier N (a frequency multiplier after the oscillator) adds 20 log10(N).
Not included: flicker noise, noise of the bias circuits that is not a listed source, AM-to-PM conversion after the
oscillator.
"""

import json
import math
import os
import re
import subprocess
from multiprocessing import Pool

import ngspice_adapter as na

Q_E = 1.602176634e-19


def tri(amp, td, w):
    """A triangle pulse as PWL. Not pulse(): ngspice replaces a zero pulse width by TSTOP (a step)."""
    return "pwl(0 0 %.12g 0 %.12g %.6g %.12g 0)" % (td, td + w, amp, td + 2 * w)


def deck_text(libs, circuit, settings, extra, tstep, tstop, vectors, data):
    lines = ["* simra ngspice adapter: oscillator"]
    lines += ['.lib "{}"{}'.format(p, " " + s if s else "") for p, s in libs]
    lines += circuit + settings + extra
    lines += [".control", "set num_threads=1", "save " + " ".join(vectors),
              "tran %.6g %.6g 0 %.6g" % (tstep, tstop, tstep), "wrdata %s %s" % (data, " ".join(vectors)), ".endc", ".end"]
    return "\n".join(lines) + "\n"


def read_wrdata(path, n):
    """wrdata writes 't v1 t v2 ...'. Returns (t, [v1..vn])."""
    t, vals = [], [[] for _ in range(n)]
    with open(path) as fh:
        for line in fh:
            parts = line.split()
            if len(parts) < 2 * n:
                continue
            try:
                row = [float(x) for x in parts]
            except ValueError:
                continue
            t.append(row[0])
            for j in range(n):
                vals[j].append(row[2 * j + 1])
    return t, vals


def run_isf(args):
    """One ISF transient in its own file set. Returns (name, t, output) or (name, None, None)."""
    work, root, name, text, n = args
    with open(os.path.join(work, name + ".cir"), "w") as fh:
        fh.write(text)
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    with open(os.path.join(work, name + ".log"), "w") as log:
        code = subprocess.call(["ngspice", "-b", name + ".cir"], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
    data = os.path.join(work, name + ".dat")
    if code != 0 or not os.path.isfile(data):
        return name, None, None
    t, vals = read_wrdata(data, n)
    os.remove(data)
    os.remove(os.path.join(work, name + ".cir"))
    os.remove(os.path.join(work, name + ".log"))
    y = [a - b for a, b in zip(vals[0], vals[1])] if n == 2 else vals[0]
    return name, t, y


def crossings(t, y):
    """Times of the rising zero crossings (linear interpolation)."""
    out = []
    for i in range(1, len(y)):
        if y[i - 1] < 0 <= y[i] and y[i] != y[i - 1]:
            out.append(t[i - 1] + (t[i] - t[i - 1]) * (-y[i - 1]) / (y[i] - y[i - 1]))
    return out


def interp(t, y, x):
    lo, hi = 0, len(t) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if t[mid] <= x:
            lo = mid
        else:
            hi = mid
    return y[lo] if t[hi] == t[lo] else y[lo] + (y[hi] - y[lo]) * (x - t[lo]) / (t[hi] - t[lo])


def series_line(circuit, name):
    """The index of the line 'name n+ n- 0' (or 'dc 0') in the circuit, or None."""
    for i, line in enumerate(circuit):
        f = line.split()
        if f and f[0].lower() == name.lower() and f[0][0].lower() == "v" and len(f) >= 4:
            if [x.lower() for x in f[3:]] in (["0"], ["dc", "0"]):
                return i
    return None


def check_sources(sources, circuit, phases=32):
    """An error message, or None. A series source must be a voltage source of the deck with value 0."""
    names = set()
    if not isinstance(sources, list) or not sources:
        return "isf.sources must be a non-empty list"
    for s in sources:
        if not isinstance(s, dict) or not isinstance(s.get("name"), str) or not re.match(r"^\w+$", s["name"]):
            return "each isf source needs a name of letters, digits and _"
        if s["name"] in names:
            return "isf source %s is given twice" % s["name"]
        names.add(s["name"])
        if "vsource" in s:
            if series_line(circuit, s["vsource"]) is None:
                return "isf source %s: no voltage source %s with value 0 in the deck" % (s["name"], s["vsource"])
            if not isinstance(s.get("psd_v2_hz"), (int, float)):
                return "isf source %s: a series source needs psd_v2_hz" % s["name"]
        else:
            if len((s.get("nodes") or "").split()) != 2:
                return "isf source %s: nodes must be two node names, 'n+ n-'" % s["name"]
            psd = s.get("psd_a2_hz")
            if not isinstance(psd, (int, float, list)) and not isinstance(s.get("shot"), str):
                return "isf source %s: give psd_a2_hz or shot (a current vector of the deck)" % s["name"]
            if isinstance(psd, list) and (len(psd) != phases or not all(isinstance(x, (int, float)) for x in psd)):
                return "isf source %s: a psd_a2_hz list needs one number per phase (%d)" % (s["name"], phases)
    return None


def oscillator(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    deck_path, libs, error = na.deck_and_libs(root, inputs)
    if error:
        return na.failure(tool, error)
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    out = inputs.get("output") or {}
    p, n = out.get("p"), out.get("n")
    if not isinstance(p, str):
        return na.failure(tool, "input 'output' is required: {p: node, n: node (optional)}")
    try:
        tstep = float(inputs["tstep_s"])
        settle = float(inputs["settle_s"])
        ref_stop = float(inputs.get("ref_stop_s", 1.25 * settle))
    except (KeyError, TypeError, ValueError):
        return na.failure(tool, "inputs 'tstep_s' (the fixed time step) and 'settle_s' (the start-up time) are required")
    if not 0 < tstep < settle < ref_stop:
        return na.failure(tool, "the inputs must give 0 < tstep_s < settle_s < ref_stop_s")
    isf = inputs.get("isf")
    mult_out = float(inputs.get("output_multiplier", 1))
    circuit = na.circuit_lines(deck_path)
    if isf is not None:
        error = check_sources(isf.get("sources"), circuit, int(isf.get("phases", 32)))
        if error:
            return na.failure(tool, error)
    probe = ["v(%s)" % p] + (["v(%s)" % n] if n else [])
    shots = [s["shot"] for s in (isf or {}).get("sources", []) if s.get("shot")]
    vectors = probe + shots

    # 1. reference run (hashed and logged by the common runner)
    with open(os.path.join(work, "ref.cir"), "w") as fh:
        fh.write(deck_text(libs, circuit, settings, [], tstep, ref_stop, vectors, "ref.dat"))
    response = na.run(request, tool, "ref.cir", deck_path, libs, None)
    diagnostics = response["diagnostics"]
    m = response["measurements"] = {}
    ref = os.path.join(work, "ref.dat")
    if response["status"] != "completed" or not os.path.isfile(ref):
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": "the reference transient failed (work/ngspice.log)"})
        response["status"] = "failed"
        return response
    t, vals = read_wrdata(ref, len(vectors))
    y = [a - b for a, b in zip(vals[0], vals[1])] if n else vals[0]
    zc = [z for z in crossings(t, y) if z > settle]
    if len(zc) < 4:
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": (
            "no steady oscillation between settle_s and ref_stop_s (%d rising zero crossings): the circuit does not "
            "start, or the run is too short" % len(zc))})
        response["status"] = "failed"
        return response
    per = [b - a for a, b in zip(zc, zc[1:])]
    T = (zc[-1] - zc[0]) / (len(zc) - 1)
    f0 = 1.0 / T
    seg = [v for tt, v in zip(t, y) if tt >= zc[0]]
    amp = (max(seg) - min(seg)) / 2
    spread = (max(per) - min(per)) / T
    m["f0_hz"] = {"value": f0, "unit": "Hz", "status": "measured"}
    m["f_out_hz"] = {"value": f0 * mult_out, "unit": "Hz", "status": "measured"}
    m["amplitude_v"] = {"value": amp, "unit": "V", "status": "measured"}
    m["period_spread_rel"] = {"value": spread, "unit": None, "status": "measured"}
    if spread > 1e-3:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "the period changes by %.2g %% after settle_s: the oscillator is not in steady state; raise settle_s" % (100 * spread))})
    if T / tstep < 100:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "%.0f time steps per period: the zero crossings are coarse; use a smaller tstep_s" % (T / tstep))})
    result = {"f0_hz": f0, "f_out_hz": f0 * mult_out, "amplitude_v": amp, "period_spread_rel": spread,
              "periods_measured": len(per)}

    # 2. ISF runs
    if isf is not None:
        sources = isf["sources"]
        nph = int(isf.get("phases", 32))
        win = [float(x) for x in isf.get("window_periods", [35, 45])]
        dq = float(isf.get("dq_c", 2e-17))
        dl = float(isf.get("dl_vs", 2e-16))
        w = float(isf.get("pulse_s", T / 160))
        offsets = [float(x) for x in isf.get("offsets_hz", [1e5, 1e6, 1e7])]
        procs = max(1, min(int(isf.get("parallel", len(os.sched_getaffinity(0)))), 64))
        t0 = float(isf["t0_s"]) if "t0_s" in isf else zc[0]
        if not settle <= t0 < ref_stop:
            return na.failure(tool, "isf.t0_s must be between settle_s and ref_stop_s")
        tstop = t0 + (win[1] + 2) * T
        jobs = []
        for s in sources:
            for k in range(nph):
                for sign in (1, -1):
                    td = t0 + k * T / nph - w
                    body, extra = list(circuit), []
                    if "vsource" in s:
                        i = series_line(body, s["vsource"])
                        f = body[i].split()
                        body[i] = "%s %s %s %s" % (f[0], f[1], f[2], tri(sign * dl / w, td, w))
                    else:
                        a, b = s["nodes"].split()
                        extra = ["Isimra_isf %s %s %s" % (a, b, tri(sign * dq / w, td, w))]
                    name = "isf_%s_%02d_%s" % (s["name"], k, "p" if sign > 0 else "m")
                    jobs.append((work, root, name, deck_text(libs, body, settings, extra, tstep, tstop, probe, name + ".dat"),
                                 len(probe)))
        with Pool(procs) as pool:
            runs = {name: (tt, yy) for name, tt, yy in pool.map(run_isf, jobs)}
        total = {df: 0.0 for df in offsets}
        per_source, failed = {}, []
        for s in sources:
            q = dl if "vsource" in s else dq
            v = []
            for k in range(nph):
                tinj = t0 + k * T / nph
                z = []
                for sign in ("p", "m"):
                    tt, yy = runs["isf_%s_%02d_%s" % (s["name"], k, sign)]
                    if tt is None or tt[-1] < tstop * 0.999:
                        failed.append("%s phase %d %s" % (s["name"], k, sign))
                        break
                    z.append([c for c in crossings(tt, yy) if tinj + win[0] * T < c < tinj + win[1] * T])
                if len(z) < 2 or not z[0] or not z[1]:
                    v.append(None)
                    continue
                # pair each crossing of the + run with the nearest crossing of the - run (a crossing near a window
                # edge can be in one list only)
                d = [(a - b) / 2 for a, b in ((a, min(z[1], key=lambda b: abs(b - a))) for a in z[0]) if abs(a - b) < T / 4]
                if not d:
                    v.append(None)
                    continue
                v.append(sum(d) / len(d) / q)
            if s.get("shot"):
                j = vectors.index(s["shot"])
                psd = [2 * Q_E * abs(interp(t, vals[j], t0 + k * T / nph)) for k in range(nph)]
            elif isinstance(s.get("psd_a2_hz"), list):
                psd = [float(x) for x in s["psd_a2_hz"]]
            else:
                psd = [float(s.get("psd_a2_hz", s.get("psd_v2_hz")))] * nph
            mult = float(s.get("mult", 1))
            ok = [k for k in range(nph) if v[k] is not None]
            mean = sum(v[k] ** 2 * psd[k] for k in ok) / len(ok) if ok else 0.0
            rec = {"isf": v, "isf_unit": "s/(V s)" if "vsource" in s else "s/C", "psd": psd, "mult": mult, "l_dbc_hz": {}}
            for df in offsets:
                lw = mult * 0.5 * (f0 / df) ** 2 * mean
                total[df] += lw
                rec["l_dbc_hz"]["%g" % df] = 10 * math.log10(lw) + 20 * math.log10(mult_out) if lw > 0 else None
            per_source[s["name"]] = rec
        if failed:
            diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": (
                "%d of %d ISF runs failed or stopped early (first: %s); see work/isf_*.log" % (len(failed), len(jobs), failed[0]))})
            response["status"] = "failed"
        for df in offsets:
            val = 10 * math.log10(total[df]) + 20 * math.log10(mult_out) if total[df] > 0 and not failed else None
            m["l_%g_hz_dbc" % df] = {"value": val, "unit": "dBc/Hz", "status": "measured" if val is not None else "missing"}
        result.update(phases=nph, window_periods=win, dq_c=dq, dl_vs=dl, pulse_s=w, output_multiplier=mult_out,
                      isf_runs=len(jobs), isf_runs_failed=len(failed), sources=per_source,
                      l_total_dbc_hz={"%g" % df: m["l_%g_hz_dbc" % df]["value"] for df in offsets})

    with open(os.path.join(work, "oscillator.json"), "w") as fh:
        json.dump(result, fh, indent=1)
        fh.write("\n")
    os.remove(ref)
    response["outputs"] = []
    for name in sorted(os.listdir(work)):
        pth = os.path.join(work, name)
        if os.path.isfile(pth):
            e = {"path": na.display_path(pth, root), "sha256": na.sha256(pth), "bytes": os.path.getsize(pth)}
            if name == "oscillator.json":
                e["role"] = "oscillator"
            response["outputs"].append(e)
    text = "oscillator: f0 %.6g Hz, amplitude %.4g V" % (f0, amp)
    if isf is not None:
        text += "; " + ", ".join("L(%g Hz) %s dBc/Hz" % (df, "-" if m["l_%g_hz_dbc" % df]["value"] is None else
                                                      "%.2f" % m["l_%g_hz_dbc" % df]["value"]) for df in offsets)
    response["report"] = [text]
    return response
