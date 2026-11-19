"""Operation "device_budget" of the ngspice adapter: the RF budget of one device at a bias and frequency.

Inputs: device (subcircuit name, for example "npn13G2"), instance_params (for example {"Nx": 4}), pins (the pin
names of the subcircuit in order; "c", "b", "e" are the collector, base and emitter, any other pin goes to ground;
default ["c", "b", "e", "bn"]), libs, params, temp_c (as simulate), vce (V), and the bias: ic_a (the collector
current; the base voltage is found from a DC sweep) or vbe (V). freq_hz (one frequency or a list; default 122e9),
ft_hz (the frequency of the fT and fmax extraction, default 20e9), z0 (default 50), noise (default true), zs (optional
list of [R, X] source impedances in ohm for the noise fit; default nine points around z0).

Method (common emitter, ideal bias tees: 1 H feeds, 1 F blocks, noiseless):
1. DC: a sweep of V_BE at the given V_CE; V_BE for ic_a by interpolation of log(I_C), then an operating point.
2. Two-port: an sp analysis at the frequencies. From S and Y: |h21|, Mason's U, MSG = |S21/S12|, MAG (when K > 1),
   the Rollett factor K and mu. fT = f_x |h21(f_x)| and fmax = f_x sqrt(U(f_x)) at f_x = ft_hz (the -20 dB per
   decade extrapolation; check that f_x lies on that slope).
3. Noise: a .noise analysis per source impedance Zs = R + jX (ideal L or C, noiseless R) into a noiseless z0 load;
   F = 1 + v_n,in^2 / (4 k T0 R), T0 = 290 K. A least-squares fit of F Gs = Rn |Ys|^2 + (Fmin - 2 Rn Gopt) Gs
   - 2 Rn Bopt Bs + Rn |Yopt|^2 gives Fmin, Rn and Yopt (Zopt = 1 / Yopt). The fit residual is reported.

Limits of the method: the VBIC model of the PDK has no correlated base-collector shot noise in ngspice, so NFmin is
optimistic; the device is the PDK subcircuit only (no wiring, no emitter inductance).

Output work/budget.json (role "device_budget"). Measurements (at the first frequency): ic_a, vbe_v, ft_hz,
fmax_hz, u_db, msg_db, mag_db (missing when K <= 1), k, mu, nfmin_db, zopt_re_ohm, zopt_im_ohm, rn_ohm,
noise_fit_rel_residual.
"""

import cmath
import json
import math
import os
import re
import subprocess

import ngspice_adapter as na

SCHEMA = "simra.device_budget/0"
K_B = 1.380649e-23
T0 = 290.0
NUM = na.NUMBER


def lib_lines(root, inputs):
    out = []
    for lib in inputs.get("libs") or []:
        path = os.path.expandvars(lib.get("path", ""))
        if not os.path.isabs(path):
            path = os.path.join(root, path)
        if not os.path.isfile(path):
            raise ValueError("library not found: {} (expanded: {})".format(lib.get("path"), path))
        out.append('.lib "{}"{}'.format(path, " " + lib["section"] if lib.get("section") else ""))
    return out


def device_line(inputs):
    pins = [p.lower() for p in inputs.get("pins") or ["c", "b", "e", "bn"]]
    nodes = [{"c": "c", "b": "b", "e": "0"}.get(p, "0") for p in pins]
    ps = " ".join("{}={}".format(k, v) for k, v in sorted((inputs.get("instance_params") or {}).items()))
    return "Xdut {} {}{}".format(" ".join(nodes), inputs.get("device", "npn13G2"), " " + ps if ps else "")


def run(work, name, text, env):
    path = os.path.join(work, name + ".cir")
    with open(path, "w") as fh:
        fh.write(text)
    log = os.path.join(work, name + ".log")
    with open(log, "w") as fh:
        code = subprocess.call(["ngspice", "-b", name + ".cir"], cwd=work, env=env, stdout=fh, stderr=subprocess.STDOUT)
    with open(log, errors="replace") as fh:
        return code, fh.read()


def two_port(s, z0):
    s11, s12, s21, s22 = s
    d = s11 * s22 - s12 * s21
    k = (1 - abs(s11) ** 2 - abs(s22) ** 2 + abs(d) ** 2) / (2 * abs(s12 * s21))
    mu = (1 - abs(s11) ** 2) / (abs(s22 - d * s11.conjugate()) + abs(s12 * s21))
    msg = abs(s21) / abs(s12)
    mag = msg * (k - math.sqrt(k * k - 1)) if k > 1 else None
    # Y from S (equal real z0)
    den = (1 + s11) * (1 + s22) - s12 * s21
    y11 = ((1 - s11) * (1 + s22) + s12 * s21) / den / z0
    y12 = -2 * s12 / den / z0
    y21 = -2 * s21 / den / z0
    y22 = ((1 + s11) * (1 - s22) + s12 * s21) / den / z0
    h21 = y21 / y11
    u_den = 4 * (y11.real * y22.real - y12.real * y21.real)
    u = abs(y21 - y12) ** 2 / u_den if u_den > 0 else math.inf
    db = lambda x: 10 * math.log10(x) if x and x > 0 and math.isfinite(x) else None
    return {"k": k, "mu": mu, "delta": abs(d), "msg_db": db(msg), "mag_db": db(mag) if mag else None, "u_db": db(u),
            "h21": abs(h21), "u": u, "s11": [s11.real, s11.imag], "s21": [s21.real, s21.imag],
            "s12": [s12.real, s12.imag], "s22": [s22.real, s22.imag]}


def fit_noise(points):
    """points: [(Ys, F)]. Returns (Fmin, Rn, Yopt, relative rms residual) from the linear least-squares form."""
    import numpy as np
    a, b = [], []
    for ys, f in points:
        gs, bs = ys.real, ys.imag
        a.append([gs * gs + bs * bs, gs, bs, 1.0])
        b.append(f * gs)
    a, b = np.array(a), np.array(b)
    c, *_ = np.linalg.lstsq(a, b, rcond=None)
    rn, c2, c4, c1 = c
    bopt = -c4 / (2 * rn)
    g2 = c1 / rn - bopt * bopt
    gopt = math.sqrt(g2) if g2 > 0 else float("nan")
    fmin = c2 + 2 * rn * gopt
    pred = [fmin + rn / ys.real * abs(ys - complex(gopt, bopt)) ** 2 for ys, _ in points]
    res = math.sqrt(sum(((p - f) / f) ** 2 for p, (_, f) in zip(pred, points)) / len(points))
    return fmin, rn, complex(gopt, bopt), res


def device_budget(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    try:
        libs = lib_lines(root, inputs)
    except ValueError as e:
        return na.failure(tool, str(e))
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    if not isinstance(inputs.get("vce"), (int, float)):
        return na.failure(tool, "input 'vce' (V) is required")
    if not isinstance(inputs.get("ic_a"), (int, float)) and not isinstance(inputs.get("vbe"), (int, float)):
        return na.failure(tool, "give the bias: input 'ic_a' (A) or 'vbe' (V)")
    freqs = inputs.get("freq_hz", 122e9)
    freqs = [float(x) for x in (freqs if isinstance(freqs, list) else [freqs])]
    fx = float(inputs.get("ft_hz", 20e9))
    z0 = float(inputs.get("z0", 50.0))
    vce = float(inputs["vce"])
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    head = ["* simra ngspice adapter: device budget for experiment {}".format(request.get("experiment"))] + libs + settings
    dev = device_line(inputs)
    diagnostics = []

    # 1. bias
    if isinstance(inputs.get("vbe"), (int, float)):
        vbe = float(inputs["vbe"])
    else:
        target = float(inputs["ic_a"])
        text = "\n".join(head + [dev, "Vc c 0 dc {}".format(vce), "Vb b 0 dc 0.7", ".control", "set num_threads=1",
                                 "dc vb 0.5 1.2 0.001", "let ic = -i(vc)", "print ic", ".endc", ".end"]) + "\n"
        code, log = run(work, "bias", text, env)
        pts = [(float(m.group(1)), float(m.group(2))) for m in re.finditer(r"^\s*\d+\s+(" + NUM + r")\s+(" + NUM + r")\s*$", log, re.M)]
        vbe = None
        for (v1, i1), (v2, i2) in zip(pts, pts[1:]):
            if i1 > 0 and i2 > 0 and i1 <= target <= i2:
                t = (math.log(target) - math.log(i1)) / (math.log(i2) - math.log(i1))
                vbe = v1 + t * (v2 - v1)
                break
        if vbe is None:
            return na.failure(tool, "I_C {} A is not reached for V_BE 0.5 V to 1.2 V at V_CE {} V (work/bias.log)".format(target, vce))
    text = "\n".join(head + [dev, "Vc c 0 dc {}".format(vce), "Vb b 0 dc {!r}".format(vbe), ".control", "set num_threads=1",
                             "op", "let icc = -i(vc)", "let ibb = -i(vb)", "print icc", "print ibb", ".endc", ".end"]) + "\n"
    code, log = run(work, "op", text, env)
    m = re.search(r"^icc\s*=\s*(" + NUM + r")", log, re.M)
    mb = re.search(r"^ibb\s*=\s*(" + NUM + r")", log, re.M)
    if not m:
        return na.failure(tool, "no operating point (work/op.log)")
    ic, ib = float(m.group(1)), float(mb.group(1)) if mb else float("nan")

    # 2. two-port
    fall = sorted(set(freqs + [fx]))
    bias = ["Vbb bdc 0 dc {!r}".format(vbe), "Lb bdc b 1", "Vcc cdc 0 dc {}".format(vce), "Lc cdc c 1"]
    lines = head + [dev] + bias + ["Cb p1 b 1", "Cc p2 c 1", "V1 p1 0 dc 0 ac 1 portnum 1 z0 {}".format(z0),
                                   "V2 p2 0 dc 0 ac 0 portnum 2 z0 {}".format(z0), ".control", "set num_threads=1"]
    for i, f in enumerate(fall):
        lines += ["sp lin 1 {!r} {!r}".format(f, f), "echo simra_f {}".format(i), "print S_1_1 S_1_2 S_2_1 S_2_2"]
    code, log = run(work, "sp", "\n".join(lines + [".endc", ".end"]) + "\n", env)
    sres = {}
    cur = None
    cplx = r"(" + NUM + r"),\s*(" + NUM + r")"
    for line in log.splitlines():
        mm = re.match(r"^simra_f (\d+)", line)
        if mm:
            cur = int(mm.group(1))
            continue
        # one data point: ngspice prints "s_1_1 = re,im" per vector
        mm = re.match(r"^\s*s_([12])_([12])\s*=\s*" + cplx, line, re.I)
        if mm and cur is not None:
            sres.setdefault(fall[cur], {})[(int(mm.group(1)), int(mm.group(2)))] = complex(float(mm.group(3)), float(mm.group(4)))
    sres = {f: [v[(1, 1)], v[(1, 2)], v[(2, 1)], v[(2, 2)]] for f, v in sres.items() if len(v) == 4}
    if len(sres) != len(fall):
        return na.failure(tool, "the sp run gave {} of {} frequencies (work/sp.log)".format(len(sres), len(fall)))
    tp = {f: two_port(s, z0) for f, s in sres.items()}
    ft = fx * tp[fx]["h21"]
    fmax = fx * math.sqrt(tp[fx]["u"]) if math.isfinite(tp[fx]["u"]) else None
    if tp[fx]["h21"] < 3:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": "|h21| is {:.3g} at ft_hz {:.4g} Hz: too near fT for the -20 dB per decade extrapolation; give a lower ft_hz".format(tp[fx]["h21"], fx)})

    # 3. noise
    noise = {}
    if inputs.get("noise", True):
        zs = inputs.get("zs") or [[r, x] for r in (0.5 * z0, z0, 2 * z0) for x in (-z0, 0.0, z0)]
        for fi, f in enumerate(freqs):
            w = 2 * math.pi * f
            pts = []
            # one deck per source impedance: an alter before the first analysis of a run is not applied reliably
            for i, (r, x) in enumerate(zs):
                ls = x / w if x > 0 else 1e-18
                cs = -1 / (w * x) if x < 0 else 1.0
                lines = head + [dev] + bias + ["Vs vs 0 dc 0 ac 1", "Rs vs n1 {!r} noisy=0".format(float(r)), "Ls n1 n2 {!r}".format(ls),
                                               "Cs n2 b {!r}".format(cs), "Cc c out 1", "Rl out 0 {} noisy=0".format(z0),
                                               ".control", "set num_threads=1", "noise v(out) vs lin 1 {!r} {!r}".format(f, f),
                                               "print noise1.inoise_spectrum", ".endc", ".end"]
                code, log = run(work, "noise_f{}_z{}".format(fi, i), "\n".join(lines) + "\n", env)
                mm = re.search(r"^\s*(?:noise1\.)?inoise_spectrum\s*=\s*(" + NUM + r")\s*$", log, re.M | re.I)
                if mm:
                    vn = float(mm.group(1))
                    pts.append((1 / complex(r, x), 1 + vn * vn / (4 * K_B * T0 * r), [r, x]))
            if len(pts) < 4:
                diagnostics.append({"severity": "error", "source": "adapter", "message": "noise at {:.4g} Hz: {} of {} source impedances gave a value".format(f, len(pts), len(zs))})
                continue
            fmin, rn, yopt, res = fit_noise([(y, F) for y, F, _ in pts])
            zopt = 1 / yopt if yopt else complex("nan")
            noise[f] = {"nfmin_db": 10 * math.log10(fmin) if fmin > 0 else None, "rn_ohm": rn, "yopt_s": [yopt.real, yopt.imag],
                        "zopt_ohm": [zopt.real, zopt.imag], "fit_rel_residual": res,
                        "points": [{"zs_ohm": z, "nf_db": 10 * math.log10(F)} for _, F, z in pts]}

    result = {"schema": SCHEMA, "device": dev, "vce_v": vce, "vbe_v": vbe, "ic_a": ic, "ib_a": ib, "ft_extract_hz": fx,
              "ft_hz": ft, "fmax_hz": fmax, "z0_ohm": z0,
              "frequencies": [{"f_hz": f, **tp[f], **noise.get(f, {})} for f in freqs]}
    path = os.path.join(work, "budget.json")
    with open(path, "w") as fh:
        json.dump(result, fh, indent=1)
        fh.write("\n")
    f0 = freqs[0]
    r0, n0 = tp[f0], noise.get(f0, {})
    meas = lambda v, unit: {"value": v, "unit": unit, "status": "measured" if v is not None and v == v else "missing"}
    measurements = {
        "ic_a": meas(ic, "A"), "vbe_v": meas(vbe, "V"), "ft_hz": meas(ft, "Hz"), "fmax_hz": meas(fmax, "Hz"),
        "u_db": meas(r0["u_db"], "dB"), "msg_db": meas(r0["msg_db"], "dB"), "mag_db": meas(r0["mag_db"], "dB"),
        "k": meas(r0["k"], None), "mu": meas(r0["mu"], None),
        "nfmin_db": meas(n0.get("nfmin_db"), "dB"), "zopt_re_ohm": meas((n0.get("zopt_ohm") or [None])[0], "ohm"),
        "zopt_im_ohm": meas((n0.get("zopt_ohm") or [None, None])[1], "ohm"), "rn_ohm": meas(n0.get("rn_ohm"), "ohm"),
        "noise_fit_rel_residual": meas(n0.get("fit_rel_residual"), None)}
    summary = "I_C {:.4g} mA at V_BE {:.4f} V; fT {:.4g} GHz, fmax {} GHz; at {:.4g} GHz: U {} dB, MSG {:.3g} dB, MAG {}, K {:.3g}, mu {:.3g}".format(
        ic * 1e3, vbe, ft / 1e9, "{:.4g}".format(fmax / 1e9) if fmax else "-", f0 / 1e9,
        "{:.3g}".format(r0["u_db"]) if r0["u_db"] is not None else "-", r0["msg_db"],
        "{:.3g} dB".format(r0["mag_db"]) if r0["mag_db"] is not None else "none (K <= 1)", r0["k"], r0["mu"])
    if n0:
        summary += "; NFmin {:.3g} dB, Zopt {:.3g}{:+.3g}j ohm, Rn {:.3g} ohm (fit residual {:.2g})".format(
            n0["nfmin_db"], n0["zopt_ohm"][0], n0["zopt_ohm"][1], n0["rn_ohm"], n0["fit_rel_residual"])
    diagnostics.insert(0, {"severity": "info", "source": "work/budget.json", "message": summary})
    diagnostics.append({"severity": "info", "source": "adapter", "message": "NFmin is from the PDK VBIC model in ngspice, which has no correlated base-collector shot noise: it is optimistic"})
    outputs = [{"path": na.display_path(path, root), "sha256": na.sha256(path), "bytes": os.path.getsize(path), "role": "device_budget"}]
    return {"contract": na.CONTRACT, "status": "completed" if all(d["severity"] != "error" for d in diagnostics) else "failed",
            "tool": tool, "input_files": None, "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics}
