"""Operation "device_crosscheck" of the xyce adapter: one device of a named model in ngspice and in Xyce, at the same
bias and frequencies, and the difference of the DC currents and of the y-parameters.

Two simulators can give different results for the same netlist, with no message, when their model cards or their
defaults differ. This operation finds such a difference with one device, before a design uses both simulators.

Inputs:
  device          {"cell": the subcircuit or model name, "params": {instance parameters for both simulators},
                   "pins": one entry per terminal in the order of the cell: "p1", "p2" or "0"}
                  Example, an HBT with the base as port 1 and the collector as port 2:
                  {"cell": "npn13G2", "params": {"Nx": 4}, "pins": ["p2", "p1", "0", "0"]}
  bias_v          [V of port 1, V of port 2] (DC voltage sources)
  freqs_hz        the frequencies of the y-parameters (at least one)
  ngspice_libs    the model libraries for ngspice, list of {path, section}
  xyce_libs       the model libraries for Xyce, list of {path, section}
  ngspice_params  optional instance parameters for ngspice only (for example {"sw_nqs": 1})
  xyce_params     optional instance parameters for Xyce only
  temp_c          optional temperature in degrees Celsius (default 27)
  tolerance       optional {"dc_rel": 0.02, "y_rel": 0.02}
  timeout_s       optional wall time of one simulator run (default 120)

Method: in each simulator, one DC point with the two port sources, then two AC runs (1 V at port 1, then at port 2).
I_k is the current into port k (the negative of the source current); y_ij = I_i / V_j.
  DC difference of port k: |I_k(ngspice) - I_k(Xyce)| / max(|I_k(Xyce)|, 0.001 of the largest port current)
  y difference of y_ij at f: |y_ij(ngspice) - y_ij(Xyce)| / max(|y_ij(Xyce)|, 0.02 of the largest |y| at f)
A difference above its tolerance is a finding (a warning diagnostic that names the quantity, both values and the
difference). The operation completes when both simulators gave all values; the findings are the result.

Measurements: dc_rel_max, y_rel_max (the largest differences), findings (their count). work/crosscheck.json (role
"device_crosscheck") has every value. The operation does not say which simulator is right.
"""

import cmath
import csv
import json
import math
import os
import re
import subprocess

import xyce_adapter as base

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DEFAULT_TOL = {"dc_rel": 0.02, "y_rel": 0.02}
DC_FLOOR = 1e-3
Y_FLOOR = 0.02


def check_inputs(inputs):
    """(spec, None) or (None, message)."""
    dev = inputs.get("device")
    if not isinstance(dev, dict) or not isinstance(dev.get("cell"), str) or not NAME.match(dev["cell"]):
        return None, "input 'device' must be {cell, params, pins}; cell is the subcircuit or model name"
    pins = dev.get("pins")
    if not isinstance(pins, list) or not pins or any(p not in ("p1", "p2", "0") for p in pins) or "p1" not in pins or "p2" not in pins:
        return None, "input 'device.pins' must list one of \"p1\", \"p2\", \"0\" per terminal, with p1 and p2 present"
    groups = {}
    for key, src in (("params", dev.get("params")), ("ngspice_params", inputs.get("ngspice_params")), ("xyce_params", inputs.get("xyce_params"))):
        src = src or {}
        if not isinstance(src, dict) or any(not NAME.match(str(k)) or not base.number(v) for k, v in src.items()):
            return None, "'{}' must be an object {{name: number}}".format(key)
        groups[key] = src
    bias = inputs.get("bias_v")
    if not isinstance(bias, list) or len(bias) != 2 or not all(base.number(v) for v in bias):
        return None, "input 'bias_v' must be [V of port 1, V of port 2]"
    freqs = inputs.get("freqs_hz")
    if not isinstance(freqs, list) or not freqs or not all(base.number(f) and f > 0 for f in freqs):
        return None, "input 'freqs_hz' must be a list of frequencies in Hz"
    temp = inputs.get("temp_c", 27)
    if not base.number(temp):
        return None, "input 'temp_c' must be a finite number (degrees Celsius)"
    tol = dict(DEFAULT_TOL)
    for k, v in (inputs.get("tolerance") or {}).items():
        if k not in DEFAULT_TOL or not base.number(v) or v <= 0:
            return None, "input 'tolerance' has dc_rel and y_rel, positive numbers"
        tol[k] = v
    return {"cell": dev["cell"], "pins": pins, "groups": groups, "bias": bias, "freqs": [float(f) for f in freqs],
            "temp": temp, "tol": tol, "timeout": float(inputs.get("timeout_s", 120))}, None


def libs_of(root, entries, name):
    """([(path, section)], None) or (None, message)."""
    if not isinstance(entries, list) or not entries:
        return None, "input '{}' is required: the model libraries, a list of {{path, section}}".format(name)
    out = []
    for lib in entries:
        path = os.path.expandvars(lib.get("path", "")) if isinstance(lib, dict) else ""
        if not os.path.isabs(path):
            path = os.path.join(root, path)
        if not os.path.isfile(path):
            return None, "library not found: {} (expanded: {})".format(lib.get("path") if isinstance(lib, dict) else lib, path)
        out.append((path, lib.get("section")))
    return out, None


def instance_line(spec, extra):
    params = dict(spec["groups"]["params"])
    params.update(spec["groups"][extra])
    text = " ".join("{}={}".format(k, repr(float(v)) if isinstance(v, float) else v) for k, v in sorted(params.items()))
    return "xdut {} {} {}".format(" ".join(spec["pins"]), spec["cell"], text).rstrip()


def lib_lines(libs):
    return ['.lib "{}" {}'.format(p, s) if s else '.include "{}"'.format(p) for p, s in libs]


def ngspice_deck(spec, libs):
    lines = ["* device cross-check, ngspice"] + lib_lines(libs)
    lines += ["v1 p1 0 dc {} ac 0".format(spec["bias"][0]), "v2 p2 0 dc {} ac 0".format(spec["bias"][1]),
              instance_line(spec, "ngspice_params"), ".temp {}".format(spec["temp"]), ".control", "set wr_singlescale", "op",
              "wrdata ng_op.dat i(v1) i(v2)"]
    for drive, (a1, a2) in enumerate(((1, 0), (0, 1)), 1):
        lines += ["alter v1 ac = {}".format(a1), "alter v2 ac = {}".format(a2)]
        for k, f in enumerate(spec["freqs"]):
            lines += ["ac lin 1 {0!r} {0!r}".format(f),
                      "wrdata ng_d{}_{}.dat real(i(v1)) imag(i(v1)) real(i(v2)) imag(i(v2))".format(drive, k)]
    lines += [".endc", ".end"]
    return "\n".join(lines) + "\n"


def xyce_deck(spec, libs, drive):
    """drive 0: the DC point; 1 or 2: the AC run with 1 V at that port."""
    lines = ["* device cross-check, Xyce", ".options device temp={}".format(spec["temp"])] + lib_lines(libs)
    lines += ["v1 p1 0 dc {} ac {}".format(spec["bias"][0], 1 if drive == 1 else 0),
              "v2 p2 0 dc {} ac {}".format(spec["bias"][1], 1 if drive == 2 else 0), instance_line(spec, "xyce_params")]
    if drive == 0:
        lines += [".dc v1 {0} {0} 1".format(spec["bias"][0]), ".print dc format=csv file=xy_op.csv i(v1) i(v2)"]
    else:
        lines += [".data ftab", "+ freq"] + ["+ {!r}".format(f) for f in spec["freqs"]] + [".enddata", ".ac data=ftab",
                  ".print ac format=csv file=xy_d{}.csv ir(v1) ii(v1) ir(v2) ii(v2)".format(drive)]
    lines.append(".end")
    return "\n".join(lines) + "\n"


def last_numbers(path, n):
    """The last n numbers of the first data line of a wrdata file, or None."""
    try:
        with open(path) as f:
            for line in f:
                parts = line.split()
                try:
                    row = [float(x) for x in parts]
                except ValueError:
                    continue
                if len(row) >= n:
                    return row[-n:]
    except OSError:
        return None
    return None


def csv_rows(path, n):
    """The last n columns of each data row of a Xyce csv file, or None."""
    try:
        with open(path) as f:
            rows = list(csv.reader(f))
    except OSError:
        return None
    out = []
    for row in rows[1:]:
        try:
            out.append([float(x) for x in row[-n:]])
        except ValueError:
            return None
    return out or None


def y_from(i_d1, i_d2):
    """[[y11, y12], [y21, y22]] from the source currents (i(v1), i(v2)) with 1 V at port 1 and at port 2."""
    return [[-i_d1[0], -i_d2[0]], [-i_d1[1], -i_d2[1]]]


def compare(spec, ng, xy):
    """(rows, findings, dc_rel_max, y_rel_max) from {"dc": [I1, I2], "y": [[[y11, y12], [y21, y22]] per f]}."""
    rows, found = [], []
    ref = max(abs(v) for v in xy["dc"]) or 1e-30
    dc_max = 0.0
    for k in range(2):
        d = abs(ng["dc"][k] - xy["dc"][k]) / max(abs(xy["dc"][k]), DC_FLOOR * ref)
        dc_max = max(dc_max, d)
        rows.append({"quantity": "I{}".format(k + 1), "freq_hz": None, "ngspice": ng["dc"][k], "xyce": xy["dc"][k], "rel": d})
        if d > spec["tol"]["dc_rel"]:
            found.append("DC current of port {}: ngspice {:.4g} A, Xyce {:.4g} A, difference {:.1f} % (tolerance {:g} %)".format(
                k + 1, ng["dc"][k], xy["dc"][k], 100 * d, 100 * spec["tol"]["dc_rel"]))
    y_max = 0.0
    for n, f in enumerate(spec["freqs"]):
        largest = max(abs(xy["y"][n][i][j]) for i in range(2) for j in range(2)) or 1e-30
        for i in range(2):
            for j in range(2):
                a, b = ng["y"][n][i][j], xy["y"][n][i][j]
                d = abs(a - b) / max(abs(b), Y_FLOOR * largest)
                y_max = max(y_max, d)
                rows.append({"quantity": "y{}{}".format(i + 1, j + 1), "freq_hz": f, "ngspice": [a.real, a.imag], "xyce": [b.real, b.imag],
                             "abs_ngspice": abs(a), "abs_xyce": abs(b), "rel": d})
                if d > spec["tol"]["y_rel"]:
                    found.append("y{}{} at {:g} GHz: ngspice {:.4g} mS at {:.1f} deg, Xyce {:.4g} mS at {:.1f} deg, difference {:.1f} % (tolerance {:g} %)".format(
                        i + 1, j + 1, f / 1e9, 1e3 * abs(a), math.degrees(cmath.phase(a)), 1e3 * abs(b), math.degrees(cmath.phase(b)),
                        100 * d, 100 * spec["tol"]["y_rel"]))
    return rows, found, dc_max, y_max


def run_ngspice(work, root, spec, libs, commands):
    with open(os.path.join(work, "ng.cir"), "w") as f:
        f.write(ngspice_deck(spec, libs))
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    argv = ["ngspice", "-b", "ng.cir"]
    with open(os.path.join(work, "ng.log"), "w") as log:
        try:
            code = subprocess.call(argv, cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=spec["timeout"])
        except (OSError, subprocess.TimeoutExpired) as e:
            log.write("ngspice did not complete: {}\n".format(e))
            code = None
    commands.append({"argv": argv, "exit_code": code, "runtime_s": None})
    dc = last_numbers(os.path.join(work, "ng_op.dat"), 2)
    if dc is None:
        return None, "ngspice gave no DC point (work/ng.log)"
    ys = []
    for k in range(len(spec["freqs"])):
        d = [last_numbers(os.path.join(work, "ng_d{}_{}.dat".format(drive, k)), 4) for drive in (1, 2)]
        if None in d:
            return None, "ngspice gave no AC result at {:g} Hz (work/ng.log)".format(spec["freqs"][k])
        cur = [(complex(r[0], r[1]), complex(r[2], r[3])) for r in d]
        ys.append(y_from(cur[0], cur[1]))
    return {"dc": [-dc[0], -dc[1]], "y": ys}, None


def run_xyce_side(work, spec, libs, commands):
    data = {}
    for drive in (0, 1, 2):
        name = "xy_{}.cir".format("op" if drive == 0 else "d{}".format(drive))
        with open(os.path.join(work, name), "w") as f:
            f.write(xyce_deck(spec, libs, drive))
        code, state, cmds = base.run_xyce(["Xyce", name], work, os.path.join(work, name[:-4] + ".log"), spec["timeout"])
        commands.extend(cmds)
        out = os.path.join(work, "xy_op.csv" if drive == 0 else "xy_d{}.csv".format(drive))
        rows = csv_rows(out, 2 if drive == 0 else 4)
        if state != "completed" or code != 0 or rows is None or (drive and len(rows) != len(spec["freqs"])):
            return None, "Xyce gave no {} result ({}; work/{}.log)".format("DC" if drive == 0 else "AC", state, name[:-4])
        data[drive] = rows
    dc = data[0][0]
    ys = []
    for k in range(len(spec["freqs"])):
        cur = [(complex(data[d][k][0], data[d][k][1]), complex(data[d][k][2], data[d][k][3])) for d in (1, 2)]
        ys.append(y_from(cur[0], cur[1]))
    return {"dc": [-dc[0], -dc[1]], "y": ys}, None


def ngspice_version():
    try:
        out = subprocess.check_output(["ngspice", "--version"], stderr=subprocess.STDOUT, universal_newlines=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"ngspice-(\S+)", out)
    return m.group(1) if m else None


def device_crosscheck(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "Xyce and ngspice", "version": "Xyce {}, ngspice {}".format(base.xyce_version(), ngspice_version())}
    spec, error = check_inputs(inputs)
    if error:
        return base.failure(tool, error)
    ng_libs, error = libs_of(root, inputs.get("ngspice_libs"), "ngspice_libs")
    if error:
        return base.failure(tool, error)
    xy_libs, error = libs_of(root, inputs.get("xyce_libs"), "xyce_libs")
    if error:
        return base.failure(tool, error)
    closure = base.Closure(root)
    for path, _ in ng_libs + xy_libs:
        closure.add_netlist(path, "model", "model")
    ctx = {"tool": tool, "closure": closure}
    os.makedirs(work, exist_ok=True)
    commands, diagnostics = [], []
    ng, ng_error = run_ngspice(work, root, spec, ng_libs, commands)
    xy, xy_error = run_xyce_side(work, spec, xy_libs, commands)
    for e in (ng_error, xy_error):
        if e:
            diagnostics.append({"severity": "error", "source": "adapter", "message": e})
    if ng is None or xy is None:
        return base.respond(ctx, "failed", base.outputs_of(work, root), {}, diagnostics, commands)
    rows, found, dc_max, y_max = compare(spec, ng, xy)
    settings = {"params": spec["groups"]["params"], "ngspice_params": spec["groups"]["ngspice_params"], "xyce_params": spec["groups"]["xyce_params"]}
    with open(os.path.join(work, "crosscheck.json"), "w") as f:
        json.dump({"schema": "simra.device_crosscheck/0", "cell": spec["cell"], "pins": spec["pins"], "settings": settings,
                   "bias_v": spec["bias"], "temp_c": spec["temp"], "tolerance": spec["tol"], "rows": rows, "findings": found}, f, indent=2)
        f.write("\n")
    for text in found:
        diagnostics.append({"severity": "warning", "source": "device_crosscheck", "message": "finding: " + text})
    if found:
        diagnostics.append({"severity": "warning", "source": "device_crosscheck", "message": (
            "the two simulators do not agree for {} with these settings. Check the defaults of the model cards (a switch "
            "that one card has and the other does not) and the workaround registry of the PDK before a design uses both "
            "simulators. The operation does not say which simulator is right.".format(spec["cell"]))})
    measurements = {"dc_rel_max": {"value": dc_max, "unit": None}, "y_rel_max": {"value": y_max, "unit": None},
                    "findings": {"value": len(found), "unit": None}}
    report = ["{} {}: DC difference at most {:.2f} %, y difference at most {:.2f} %, {} finding{}".format(
        spec["cell"], json.dumps(settings, sort_keys=True), 100 * dc_max, 100 * y_max, len(found), "" if len(found) == 1 else "s")] + found
    outputs = base.outputs_of(work, root)
    for o in outputs:
        if o.get("path", "").endswith("crosscheck.json"):
            o["role"] = "device_crosscheck"
    return base.respond(ctx, "completed", outputs, measurements, diagnostics, commands, report)
