"""Operation "oscillator" of the ngspice adapter: steady-state frequency, amplitude and phase noise of an oscillator by
the impulse sensitivity function (ISF; Hajimiri and Lee) from ngspice transients.

Method:
  1. Reference transient to ref_stop_s with a fixed step tstep_s (the deck must start by itself, for example with a
     short current kick). f0 from the rising zero crossings of the output v(p) - v(n) after settle_s; the amplitude is
     half of the peak-to-peak output there. The start-up time startup_t90_s is the start of the first cycle of the
     run (from t = 0) whose half peak-to-peak reaches 0.9 of that amplitude.
  2. For each noise source and each of N phases tau_k = t0 + k T / N (t0 = the first zero crossing after settle_s):
     inject +q and -q with a short triangular pulse (a current between two nodes, charge dq_c, or a voltage in a series
     source of value 0, flux dl_vs), continue, and read the shift of the output zero crossings in the window
     [window_periods[0], window_periods[1]] periods after the injection: v_k = (t(+q) - t(-q)) / (2 q). The amplitude
     settles before the window; the phase shift stays.
  3. A white source with one-sided PSD S gives L(df) = mult * 1/2 * (f0/df)^2 * mean_k(v_k^2 S_k). S_k is a constant
     (psd_a2_hz for a current, psd_v2_hz for a series voltage), or the shot noise 2 q |i(tau_k)| of a vector of the
     reference run (input shot), or a list of one PSD per phase (a cyclostationary PSD from elsewhere). A shot vector
     must be a conduction current: in a transient, the terminal currents of a bipolar model (and @q[ib] of VBIC)
     include the charge currents, which are not noise. shot {device, current} takes the conduction current from a DC
     table of the device (isf.devices: the device alone, a 2-D dc sweep of two node voltages; the table is interpolated
     at the transient values of two axis vectors, for example the internal vbe and vbc, as the R2 method). mult counts identical sources by symmetry. The total is the sum over the sources.
     output_multiplier N (a frequency multiplier after the oscillator) adds 20 log10(N).
     A thermal source (input thermal_ohm R) has S = 4 k T / R for a current between two nodes, or S = 4 k T R for a
     series voltage, with T from the input temp_c of the condition (default 27 C), not a fixed 300 K.
  4. Flicker noise of a source (input flicker {device, current, kf, af, bf}: S = kf |i|^af / df^bf) by the DC term of
     the ISF: L(df) = mult * 1/2 * (f0/df)^2 * mean_k(v_k |i_k|^(af/2))^2 * kf / df^bf.
     Quasi-static path (input isf.quasi_static: [{source, step_a}]): the ISF reads the phase 35 to 45 periods after
     the injection, so a slow path of the flicker current (for example through the base bias resistors, time
     constants of ns) is only partly in it. Two more transients with a DC current of +step_a and -step_a between the
     nodes of the source give the conversion gain K = (f(+) - f(-)) / (2 step_a) in Hz/A, and
     L_qs(df) = mult * 1/2 * K^2 * kf * mean_k(|i_k|^(af/2))^2 / df^bf / df^2. The flicker term of the source is the
     larger of the ISF term and L_qs (their sum would count the common part twice).
  6. Check of the conduction table (input terminal {current: vector of the oscillator deck} of a device): the mean
     of the table current over the phases must equal the mean of the terminal current over whole periods of the
     reference run within isf.table_tol (default 0.1): the charge currents have no mean. A table of another corner or
     temperature than the transient fails this check.
  5. Sources and devices inside a subcircuit of the design (a bench that instantiates the design): a source or a device
     may name an instance {subckt, name} of the subcircuit instead of deck nodes. The operation inlines the include
     file that defines the subcircuit, and then: a current source {pins: [i, j]} injects between the nodes of pins i
     and j of the instance (inside the subcircuit); a series source {pin: i} puts a voltage source of value 0 in the
     lead of pin i; a device {instance: {subckt, name}} takes its table lines from the instance line (the first two
     pins become the swept nodes, the other pins ground, the parameters unchanged). The injection is in every instance
     of the subcircuit; the bench must have one.
Not included: noise of the bias circuits that is not a listed source, AM-to-PM conversion after the
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
K_B = 1.380649e-23


def tri(amp, td, w):
    """A triangle pulse as PWL. Not pulse(): ngspice replaces a zero pulse width by TSTOP (a step)."""
    return "pwl(0 0 %.12g 0 %.12g %.6g %.12g 0)" % (td, td + w, amp, td + 2 * w)


NO_START = "SIMRA_NO_START"


def start_checks(settle, tstop, start):
    """The check points of the start check: [(t, (a1, b1), (a2, b2))], two windows of settle/8 before t, at t =
    settle/2 and 3 settle/4 (only points before tstop). start: the input start_check (False: none)."""
    if start is False:
        return []
    w = settle / 8
    return [(tc, (tc - 2 * w, tc - w), (tc - w, tc)) for tc in (settle / 2, 0.75 * settle) if tc < tstop]


def start_check_lines(points, expr, factor, start_v, tstep, tstop, vectors, data):
    """.control lines: the transient stops at each check point; when the half peak-to-peak output of the later window
    is below factor x that of the earlier window and below start_v (or below 1 uV), the run ends with a NO_START line
    (the oscillation decays: it does not start). Else the run goes on to tstop."""
    lines = []
    for i, (tc, (a1, b1), (a2, b2)) in enumerate(points):
        lines.append("stop when time > %.6g" % tc)
        lines.append("tran %.6g %.6g 0 %.6g" % (tstep, tstop, tstep) if i == 0 else "resume")
        lines += ["meas tran simra_a%d pp %s from=%.6g to=%.6g" % (i, expr, a1, b1),
                  "meas tran simra_b%d pp %s from=%.6g to=%.6g" % (i, expr, a2, b2),
                  "let simra_stop = 0",
                  "if simra_b%d < %.6g" % (i, 2 * 1e-6), "let simra_stop = 1", "end",
                  "if simra_b%d < %.6g * simra_a%d" % (i, factor, i),
                  "if simra_b%d < %.6g" % (i, 2 * start_v), "let simra_stop = 1", "end", "end",
                  "if simra_stop > 0",
                  "echo %s %.6g $&simra_a%d $&simra_b%d" % (NO_START, tc, i, i), "quit", "end",
                  "delete all"]
    lines += ["resume" if points else "tran %.6g %.6g 0 %.6g" % (tstep, tstop, tstep), "wrdata %s %s" % (data, " ".join(vectors))]
    return lines


def no_start(log_text):
    """(t, half peak-to-peak earlier, later) of a NO_START line of an ngspice log, or None."""
    m = re.search(r"^%s\s+(\S+)\s+(\S+)\s+(\S+)" % NO_START, log_text, re.M)
    return tuple(float(x) / (1 if i == 0 else 2) for i, x in enumerate(m.groups())) if m else None


def deck_text(libs, circuit, settings, extra, tstep, tstop, vectors, data, start=None):
    """start: None (no start check) or {points, expr, factor, start_v} (see start_check_lines)."""
    lines = ["* simra ngspice adapter: oscillator"]
    lines += ['.lib "{}"{}'.format(p, " " + s if s else "") for p, s in libs]
    lines += circuit + settings + extra
    lines += [".control", "set num_threads=1", "save " + " ".join(vectors)]
    if start and start["points"]:
        lines += start_check_lines(start["points"], start["expr"], start["factor"], start["start_v"], tstep, tstop, vectors, data)
    else:
        lines += ["tran %.6g %.6g 0 %.6g" % (tstep, tstop, tstep), "wrdata %s %s" % (data, " ".join(vectors))]
    lines += [".endc", ".end"]
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


def startup_t90(t, y, amp):
    """The start of the first cycle (between rising zero crossings of the whole run, from t = 0) whose half
    peak-to-peak reaches 0.9 of the steady amplitude amp, or None."""
    zc = crossings(t, y)
    k = 0
    for a, b in zip(zc, zc[1:]):
        lo = hi = None
        while k < len(t) and t[k] < a:
            k += 1
        j = k
        while j < len(t) and t[j] <= b:
            lo = y[j] if lo is None else min(lo, y[j])
            hi = y[j] if hi is None else max(hi, y[j])
            j += 1
        if lo is not None and (hi - lo) / 2 >= 0.9 * amp:
            return a
    return None


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


MODEL_LINE = re.compile(r"^\s*\.(lib|include|inc|param|model|options?|temp|global|csparam)\b", re.IGNORECASE)


def model_lines(circuit):
    """The lines of the deck that the device needs: library, include, parameter, model and option lines at the top
    level, and every .subckt block."""
    out, depth = [], 0
    for line in circuit:
        low = line.strip().lower()
        if low.startswith(".subckt"):
            depth += 1
        if depth or MODEL_LINE.match(line):
            out.append(line)
        if low.startswith(".ends") and depth:
            depth -= 1
    return out


def table_deck(libs, settings, dev, data, circuit=()):
    """The DC table deck of one device: the model lines of the deck, the device lines alone, a voltage source on each
    swept node, a 2-D dc sweep."""
    lines = ["* simra ngspice adapter: oscillator conduction table of %s" % dev["name"]]
    lines += ['.lib "{}"{}'.format(p, " " + s if s else "") for p, s in libs]
    lines += model_lines(circuit) + list(dev["lines"]) + settings
    (n1, a1, b1, s1), (n2, a2, b2, s2) = dev["sweep"]
    lines += ["Vsimra_t1 %s 0 %g" % (n1, a1), "Vsimra_t2 %s 0 %g" % (n2, a2)]
    vec = list(dev["axes"]) + [dev["currents"][k] for k in sorted(dev["currents"])]
    lines += [".control", "set num_threads=1", "save " + " ".join(vec),
              "dc Vsimra_t1 %g %g %g Vsimra_t2 %g %g %g" % (a1, b1, s1, a2, b2, s2),
              "wrdata %s %s" % (data, " ".join(vec)), ".endc", ".end"]
    return "\n".join(lines) + "\n", len(vec)


def grid_shape(dev):
    (_, a1, b1, s1), (_, a2, b2, s2) = dev["sweep"]
    return int(round((b1 - a1) / s1)) + 1, int(round((b2 - a2) / s2)) + 1


class Table(object):
    """Linear interpolation on a sweep table: the points are a structured grid in the swept (external) voltages and a
    smooth map to the axes (internal junction voltages). Each grid cell is split into two triangles; a query point is
    found by its triangle in axis space (barycentric weights), with a bucket index of the triangle boxes."""

    def __init__(self, xs, ys, values, n1, n2, bucket=0.02):
        self.v = values
        self.tri = []
        self.bucket = bucket
        self.index = {}
        idx = lambda i, j: j * n1 + i
        for j in range(n2 - 1):
            for i in range(n1 - 1):
                a, b, c, d = idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1)
                for t in ((a, b, d), (a, d, c)):
                    k = len(self.tri)
                    self.tri.append(t)
                    px = [xs[q] for q in t]
                    py = [ys[q] for q in t]
                    for bx in range(int(math.floor(min(px) / bucket)), int(math.floor(max(px) / bucket)) + 1):
                        for by in range(int(math.floor(min(py) / bucket)), int(math.floor(max(py) / bucket)) + 1):
                            self.index.setdefault((bx, by), []).append(k)
        self.xs, self.ys = xs, ys

    def __call__(self, x, y):
        """{name: value} at (x, y), or None outside the table."""
        best = None
        for k in self.index.get((int(math.floor(x / self.bucket)), int(math.floor(y / self.bucket))), []):
            a, b, c = self.tri[k]
            x1, y1, x2, y2, x3, y3 = self.xs[a], self.ys[a], self.xs[b], self.ys[b], self.xs[c], self.ys[c]
            det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
            if det == 0:
                continue
            l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det
            l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det
            l3 = 1 - l1 - l2
            worst = min(l1, l2, l3)
            if best is None or worst > best[0]:
                best = (worst, a, b, c, l1, l2, l3)
        if best is None or best[0] < -1e-9:
            return None
        _, a, b, c, l1, l2, l3 = best
        return {name: l1 * v[a] + l2 * v[b] + l3 * v[c] for name, v in self.v.items()}


def check_devices(devices):
    if not isinstance(devices, list):
        return "isf.devices must be a list"
    for d in devices:
        if not (isinstance(d, dict) and isinstance(d.get("name"), str) and (isinstance(d.get("lines"), list) or isinstance(d.get("instance"), dict))
                and isinstance(d.get("sweep"), list) and len(d["sweep"]) == 2
                and all(isinstance(x, list) and len(x) == 4 and isinstance(x[0], str) for x in d["sweep"])
                and isinstance(d.get("axes"), list) and len(d["axes"]) == 2 and isinstance(d.get("at"), list)
                and len(d["at"]) == 2 and isinstance(d.get("currents"), dict) and d["currents"]):
            return ("each isf device needs name, lines (the device alone), sweep ([[node, from, to, step], [node, from, "
                    "to, step]]), axes (two vectors of the table deck), at (the same two vectors in the oscillator deck) "
                    "and currents ({name: vector of the table deck})")
    return None


SUBCKT_RE = r"^\s*\.subckt\s+%s\b"


def subckt_block(circuit, name):
    """(start, end) line indices of '.subckt name' ... '.ends' in the circuit, or None."""
    rx = re.compile(SUBCKT_RE % re.escape(name), re.IGNORECASE)
    for i, line in enumerate(circuit):
        if rx.match(line):
            for j in range(i + 1, len(circuit)):
                if circuit[j].strip().lower().startswith(".ends"):
                    return i, j
    return None


def inline_subckt(circuit, name):
    """The circuit with the include file that defines subcircuit `name` inlined (if the deck does not define it)."""
    if subckt_block(circuit, name):
        return circuit
    rx = re.compile(SUBCKT_RE % re.escape(name), re.IGNORECASE | re.MULTILINE)
    for i, line in enumerate(circuit):
        m = na.INCLUDE_LINE.match(line)
        if not m or m.group(1).lower() == "lib":
            continue
        words = na.split_args(m.group(2))
        path = os.path.expandvars(words[0]) if words else ""
        if os.path.isfile(path) and rx.search(open(path, errors="replace").read()):
            return circuit[:i] + na.circuit_lines(path) + circuit[i + 1:]
    return circuit


def instance_line(circuit, inst):
    """(line index, node list, rest tokens) of instance inst = {subckt, name} inside its subcircuit, or None."""
    blk = subckt_block(circuit, inst.get("subckt", ""))
    if not blk:
        return None
    for i in range(blk[0] + 1, blk[1]):
        f = circuit[i].split()
        if f and f[0].lower() == str(inst.get("name", "")).lower():
            plain = [x for x in f[1:] if "=" not in x]
            if len(plain) < 2:
                return None
            return i, plain[:-1], [plain[-1]] + [x for x in f[1:] if "=" in x]
    return None


def resolve_instances(circuit, isf):
    """Inline the subcircuits that sources and devices name, and turn them into deck forms. Returns (circuit, isf,
    error). A current source gets nodes and '_subckt'; a series source gets a voltage source in the subcircuit."""
    isf = json.loads(json.dumps(isf))
    insts = [s["instance"] for s in isf.get("sources") or [] if isinstance(s, dict) and isinstance(s.get("instance"), dict)]
    insts += [d["instance"] for d in isf.get("devices") or [] if isinstance(d, dict) and isinstance(d.get("instance"), dict)]
    if not insts:
        return circuit, isf, None
    circuit = list(circuit)
    for inst in insts:
        circuit = inline_subckt(circuit, str(inst.get("subckt", "")))
    for d in isf.get("devices") or []:
        if isinstance(d, dict) and isinstance(d.get("instance"), dict):
            found = instance_line(circuit, d["instance"])
            if not found:
                return circuit, isf, "isf device %s: no instance %s in subcircuit %s" % (d.get("name"), d["instance"].get("name"), d["instance"].get("subckt"))
            _, nodes, rest = found
            sw = [x[0] for x in d.get("sweep") or [] if isinstance(x, list) and x]
            if len(sw) != 2:
                return circuit, isf, "isf device %s: sweep needs two nodes" % d.get("name")
            d["lines"] = ["x%s %s %s" % (d["name"], " ".join(sw + ["0"] * (len(nodes) - 2)), " ".join(rest))]
    for s in isf.get("sources") or []:
        if not (isinstance(s, dict) and isinstance(s.get("instance"), dict)):
            continue
        inst = s["instance"]
        found = instance_line(circuit, inst)
        if not found:
            return circuit, isf, "isf source %s: no instance %s in subcircuit %s" % (s.get("name"), inst.get("name"), inst.get("subckt"))
        i, nodes, rest = found
        if "pin" in inst:
            k = inst["pin"]
            if not isinstance(k, int) or not 0 <= k < len(nodes):
                return circuit, isf, "isf source %s: pin must be an index of the %d pins of %s" % (s.get("name"), len(nodes), inst["name"])
            new = "simra_isf_%s" % s["name"]
            vname = "Vsimra_isf_%s" % s["name"]
            f = circuit[i].split()
            orig = nodes[k]
            f[1 + k] = new
            circuit[i] = " ".join(f)
            circuit.insert(i, "%s %s %s 0" % (vname, orig, new))
            s["vsource"] = vname
        else:
            pins = inst.get("pins")
            if not (isinstance(pins, list) and len(pins) == 2 and all(isinstance(x, int) and 0 <= x < len(nodes) for x in pins)):
                return circuit, isf, "isf source %s: give instance.pins (two pin indices) or instance.pin (one)" % s.get("name")
            s["nodes"] = "%s %s" % (nodes[pins[0]], nodes[pins[1]])
            s["_subckt"] = inst["subckt"]
    return circuit, isf, None


def source_psd(s, nph, cond, shot_values, temp_k):
    """(one-sided PSD of source s at each of the nph phases, the bound it was made from). cond: the conduction rows of
    the devices; shot_values: the shot vector of the deck at the phases (input shot as a vector name); temp_k: the
    temperature of the condition in K."""
    if isinstance(s.get("shot"), dict):
        cur = [abs(r[s["shot"]["current"]]) for r in cond[s["shot"]["device"]]]
        return [2 * Q_E * x for x in cur], "2qI"
    if isinstance(s.get("shot"), str):
        return [2 * Q_E * abs(x) for x in shot_values], "2qI"
    if "thermal_ohm" in s:
        r = float(s["thermal_ohm"])
        return [4 * K_B * temp_k * r if "vsource" in s else 4 * K_B * temp_k / r] * nph, "4kTR" if "vsource" in s else "4kT/R"
    if isinstance(s.get("psd_a2_hz"), list):
        return [float(x) for x in s["psd_a2_hz"]], "given"
    return [float(s.get("psd_a2_hz", s.get("psd_v2_hz")))] * nph, "given"


def flicker_weight(cur, af):
    """mean_k |i_k|^(af/2) of the conduction current at the phases (the flicker weight of a cyclostationary source)."""
    return sum(abs(x) ** (af / 2) for x in cur) / len(cur)


def quasi_static_l(k_hz_a, weight, fl, mult, df):
    """L(df) of the quasi-static flicker path: mult * 1/2 * K^2 * kf * weight^2 / df^bf / df^2 (not in dB)."""
    return mult * 0.5 * k_hz_a ** 2 * fl["kf"] * weight ** 2 / df ** fl["bf"] / df ** 2


def mean_over_periods(t, y, a, b):
    """time mean of y between a and b (trapezoid on the samples)."""
    acc = 0.0
    for i in range(1, len(t)):
        lo, hi = max(t[i - 1], a), min(t[i], b)
        if hi <= lo:
            continue
        acc += (hi - lo) * (interp(t, y, lo) + interp(t, y, hi)) / 2
    return acc / (b - a)


def table_check(table_rows, current, terminal_mean, tol):
    """None, or the reason why the conduction table does not fit the transient (mean of the table current at the
    phases against the mean terminal current)."""
    tm = sum(r[current] for r in table_rows) / len(table_rows)
    if terminal_mean == 0 or abs(tm / terminal_mean - 1) > tol:
        return ("the conduction table does not fit the transient: mean %s %.4g A from the table, %.4g A at the terminal "
                "(limit %g %%); is the table at the corner and the temperature of the deck?" % (current, tm, terminal_mean, 100 * tol))
    return None


def check_quasi_static(qs, sources):
    if qs is None:
        return None
    by = {s.get("name"): s for s in sources or []}
    if not isinstance(qs, list):
        return "isf.quasi_static must be a list of {source, step_a}"
    for q in qs:
        src = by.get((q or {}).get("source")) if isinstance(q, dict) else None
        if src is None or not src.get("flicker") or "vsource" in src:
            return "isf.quasi_static: source must name an isf current source with flicker"
        if not isinstance(q.get("step_a", 1e-6), (int, float)) or not q.get("step_a", 1e-6) > 0:
            return "isf.quasi_static: step_a must be a positive current in A"
    return None


def check_sources(sources, circuit, phases=32, devices=()):
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
        fl = s.get("flicker")
        if fl is not None:
            dev = {d["name"]: d for d in devices}.get((fl or {}).get("device")) if isinstance(fl, dict) else None
            if dev is None or fl.get("current") not in dev["currents"] or not all(
                    isinstance(fl.get(k), (int, float)) for k in ("kf", "af", "bf")):
                return "isf source %s: flicker needs device, current (of isf.devices), kf, af and bf" % s["name"]
        if "vsource" in s:
            if series_line(circuit, s["vsource"]) is None:
                return "isf source %s: no voltage source %s with value 0 in the deck" % (s["name"], s["vsource"])
            if not isinstance(s.get("psd_v2_hz"), (int, float)) and not isinstance(s.get("thermal_ohm"), (int, float)):
                return "isf source %s: a series source needs psd_v2_hz or thermal_ohm" % s["name"]
        else:
            if len((s.get("nodes") or "").split()) != 2:
                return "isf source %s: nodes must be two node names, 'n+ n-'" % s["name"]
            psd = s.get("psd_a2_hz")
            shot = s.get("shot")
            if isinstance(shot, dict):
                dev = {d["name"]: d for d in devices}.get(shot.get("device"))
                if dev is None or shot.get("current") not in dev["currents"]:
                    return "isf source %s: shot {device, current} must name a device of isf.devices and one of its currents" % s["name"]
            elif not isinstance(psd, (int, float, list)) and not isinstance(shot, str) and not isinstance(s.get("thermal_ohm"), (int, float)):
                return "isf source %s: give psd_a2_hz, thermal_ohm or shot (a current vector of the deck)" % s["name"]
            if isinstance(psd, list) and (len(psd) != phases or not all(isinstance(x, (int, float)) for x in psd)):
                return "isf source %s: a psd_a2_hz list needs one number per phase (%d)" % (s["name"], phases)
        if "thermal_ohm" in s and not (isinstance(s["thermal_ohm"], (int, float)) and s["thermal_ohm"] > 0):
            return "isf source %s: thermal_ohm must be a positive resistance" % s["name"]
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
        circuit, isf, error = resolve_instances(circuit, isf)
        if error:
            return na.failure(tool, error)
        error = check_devices(isf.get("devices", [])) or check_sources(
            isf.get("sources"), circuit, int(isf.get("phases", 32)), isf.get("devices", [])) or check_quasi_static(
            isf.get("quasi_static"), isf.get("sources"))
        if error:
            return na.failure(tool, error)
    probe = ["v(%s)" % p] + (["v(%s)" % n] if n else [])
    shots = [s["shot"] for s in (isf or {}).get("sources", []) if isinstance(s.get("shot"), str)]
    devices = (isf or {}).get("devices", [])
    terminals = [(d["name"], c, v) for d in devices for c, v in sorted((d.get("terminal") or {}).items())]
    vectors = probe + shots + [x for d in devices for x in d["at"]] + [v for _, _, v in terminals]

    # 1. reference run (hashed and logged by the common runner)
    sc = inputs.get("start_check", True)
    if not isinstance(sc, (bool, dict)):
        return na.failure(tool, "input 'start_check' must be true, false or {factor, start_v}")
    sc = {} if sc is True else sc
    start = None if sc is False else {
        "points": start_checks(settle, ref_stop, True), "expr": "v(%s,%s)" % (p, n) if n else "v(%s)" % p,
        "factor": float(sc.get("factor", 0.9)), "start_v": float(sc.get("start_v", 0.05))}
    with open(os.path.join(work, "ref.cir"), "w") as fh:
        fh.write(deck_text(libs, circuit, settings, [], tstep, ref_stop, vectors, "ref.dat", start))
    response = na.run(request, tool, "ref.cir", deck_path, libs, None)
    diagnostics = response["diagnostics"]
    m = response["measurements"] = {}
    ref = os.path.join(work, "ref.dat")
    log_path = os.path.join(work, "ngspice.log")
    stopped = no_start(open(log_path, errors="replace").read()) if os.path.isfile(log_path) else None
    if stopped:
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": (
            "the oscillator does not start: at %.4g s the half peak-to-peak output fell from %.4g V to %.4g V over %.4g s "
            "(start check: later window below %g of the earlier one and below %g V); the run stopped at %.4g s of "
            "%.4g s. Give more loop gain or a larger kick, or set start_check false"
            % (stopped[0], stopped[1], stopped[2], settle / 8, start["factor"], start["start_v"], stopped[0], ref_stop))})
        response["status"] = "failed"
        response["measurements"] = {"start_check_stop_s": {"value": stopped[0], "unit": "s", "status": "measured"}}
        return response
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
    t90 = startup_t90(t, y, amp)
    m["startup_t90_s"] = {"value": t90, "unit": "s", "status": "measured" if t90 is not None else "missing"}
    if spread > 1e-3:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "the period changes by %.2g %% after settle_s: the oscillator is not in steady state; raise settle_s" % (100 * spread))})
    if T / tstep < 100:
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "%.0f time steps per period: the zero crossings are coarse; use a smaller tstep_s" % (T / tstep))})
    result = {"f0_hz": f0, "f_out_hz": f0 * mult_out, "amplitude_v": amp, "period_spread_rel": spread,
              "periods_measured": len(per), "startup_t90_s": t90}

    # 2. ISF runs
    if isf is not None:
        sources = isf["sources"]
        nph = int(isf.get("phases", 32))
        win = [float(x) for x in isf.get("window_periods", [35, 45])]
        dq = float(isf.get("dq_c", 2e-17))
        dl = float(isf.get("dl_vs", 2e-16))
        w = float(isf.get("pulse_s", T / 160))
        offsets = [float(x) for x in isf.get("offsets_hz", [1e5, 1e6, 1e7])]
        temp_k = float(inputs.get("temp_c", 27)) + 273.15
        procs = max(1, min(int(isf.get("parallel", len(os.sched_getaffinity(0)))), 64))
        t0 = float(isf["t0_s"]) if "t0_s" in isf else zc[0]
        if not settle <= t0 < ref_stop:
            return na.failure(tool, "isf.t0_s must be between settle_s and ref_stop_s")
        tstop = t0 + (win[1] + 2) * T
        # conduction currents of each device at the phases: DC table at the transient axis values (R2 method)
        cond = {}
        for d in devices:
            text, nvec = table_deck(libs, settings, d, "table_%s.dat" % d["name"], circuit)
            with open(os.path.join(work, "table_%s.cir" % d["name"]), "w") as fh:
                fh.write(text)
            env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
            with open(os.path.join(work, "table_%s.log" % d["name"]), "w") as log:
                subprocess.call(["ngspice", "-b", "table_%s.cir" % d["name"]], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
            data = os.path.join(work, "table_%s.dat" % d["name"])
            n1, n2 = grid_shape(d)
            tt, tv = read_wrdata(data, nvec) if os.path.isfile(data) else ([], [])
            if len(tt) != n1 * n2:
                return na.failure(tool, "the conduction table of device %s has %d points, expected %d (work/table_%s.log)" % (
                    d["name"], len(tt), n1 * n2, d["name"]))
            os.remove(data)
            names = sorted(d["currents"])
            table = Table(tv[0], tv[1], {k: tv[2 + i] for i, k in enumerate(names)}, n1, n2)
            ja, jb = vectors.index(d["at"][0]), vectors.index(d["at"][1])
            rows, outside = [], []
            for k in range(nph):
                tk = t0 + k * T / nph
                x, yv = interp(t, vals[ja], tk), interp(t, vals[jb], tk)
                r = table(x, yv)
                if r is None:
                    outside.append((k, x, yv))
                    r = {c: float("nan") for c in names}
                rows.append(dict(r, x=x, y=yv))
            if outside:
                return na.failure(tool, "device %s: %d phases are outside the conduction table (first: phase %d at %s = %.4g, %s = %.4g); widen the sweep" % (
                    d["name"], len(outside), outside[0][0], d["at"][0], outside[0][1], d["at"][1], outside[0][2]))
            cond[d["name"]] = rows
        # check of the conduction table against the terminal currents of the reference run (whole periods from t0)
        tol = float(isf.get("table_tol", 0.1))
        n_per = max(1, int((ref_stop - t0) / T))
        result["table_check"] = []
        for dn, c, vec in terminals:
            tmean = mean_over_periods(t, vals[vectors.index(vec)], t0, t0 + n_per * T)
            why = table_check(cond[dn], c, tmean, tol)
            result["table_check"].append({"device": dn, "current": c, "table_mean_a": sum(r[c] for r in cond[dn]) / nph,
                                          "terminal_mean_a": tmean, "periods": n_per, "tolerance": tol, "pass": why is None})
            if why:
                return na.failure(tool, "device %s: %s" % (dn, why))
        jobs, failed = [], []
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
                        line = "Isimra_isf %s %s %s" % (a, b, tri(sign * dq / w, td, w))
                        if s.get("_subckt"):
                            body.insert(subckt_block(body, s["_subckt"])[1], line)
                        else:
                            extra = [line]
                    name = "isf_%s_%02d_%s" % (s["name"], k, "p" if sign > 0 else "m")
                    jobs.append((work, root, name, deck_text(libs, body, settings, extra, tstep, tstop, probe, name + ".dat"),
                                 len(probe)))
        qs_list = isf.get("quasi_static") or []
        by_name = {s["name"]: s for s in sources}
        for q in qs_list:
            s = by_name[q["source"]]
            a, b = s["nodes"].split()
            for sign in (1, -1):
                line = "Isimra_qs %s %s dc %.6g" % (a, b, sign * float(q.get("step_a", 1e-6)))
                body, extra = list(circuit), []
                if s.get("_subckt"):
                    body.insert(subckt_block(body, s["_subckt"])[1], line)
                else:
                    extra = [line]
                name = "qs_%s_%s" % (s["name"], "p" if sign > 0 else "m")
                jobs.append((work, root, name, deck_text(libs, body, settings, extra, tstep, ref_stop, probe, name + ".dat"),
                             len(probe)))
        with Pool(procs) as pool:
            runs = {name: (tt, yy) for name, tt, yy in pool.map(run_isf, jobs)}
        qs_by_source = {}
        for q in qs_list:
            fs = []
            for sign in ("p", "m"):
                tt, yy = runs["qs_%s_%s" % (q["source"], sign)]
                zq = [z for z in crossings(tt, yy) if z > settle] if tt is not None else []
                fs.append((len(zq) - 1) / (zq[-1] - zq[0]) if len(zq) >= 4 else None)
            qs_by_source[q["source"]] = {"step_a": float(q.get("step_a", 1e-6)), "f_plus_hz": fs[0], "f_minus_hz": fs[1],
                                         "k_hz_per_a": (fs[0] - fs[1]) / (2 * float(q.get("step_a", 1e-6))) if None not in fs else None}
        total = {df: 0.0 for df in offsets}
        flick = {df: 0.0 for df in offsets}
        per_source = {}
        failed += ["quasi-static run of %s" % k for k, v in qs_by_source.items() if v["k_hz_per_a"] is None]
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
            shot_values = None
            if isinstance(s.get("shot"), str):
                j = vectors.index(s["shot"])
                shot_values = [interp(t, vals[j], t0 + k * T / nph) for k in range(nph)]
            psd, bound = source_psd(s, nph, cond, shot_values, temp_k)
            mult = float(s.get("mult", 1))
            ok = [k for k in range(nph) if v[k] is not None]
            mean = sum(v[k] ** 2 * psd[k] for k in ok) / len(ok) if ok else 0.0
            rec = {"isf": v, "isf_unit": "s/(V s)" if "vsource" in s else "s/C", "psd": psd, "psd_bound": bound, "mult": mult, "l_dbc_hz": {}}
            for df in offsets:
                lw = mult * 0.5 * (f0 / df) ** 2 * mean
                total[df] += lw
                rec["l_dbc_hz"]["%g" % df] = 10 * math.log10(lw) + 20 * math.log10(mult_out) if lw > 0 else None
            fl = s.get("flicker")
            if fl and ok:
                # flicker by the DC term of the ISF: S = kf |i|^af / df^bf; L = mult 1/2 (f0/df)^2 mean(v |i|^(af/2))^2 kf / df^bf
                cur = [abs(r[fl["current"]]) for r in cond[fl["device"]]]
                c0 = sum(v[k] * cur[k] ** (fl["af"] / 2) for k in ok) / len(ok)
                rec["flicker_isf_dc"] = c0
                rec["flicker_l_dbc_hz"] = {}
                qs = qs_by_source.get(s["name"])
                if qs is not None:
                    qs["weight"] = flicker_weight(cur, fl["af"])
                    qs["l_dbc_hz"] = {}
                    rec["flicker_quasi_static"] = qs
                    rec["flicker_used"] = {}
                for df in offsets:
                    lf = mult * 0.5 * (f0 / df) ** 2 * c0 ** 2 * fl["kf"] / df ** fl["bf"]
                    rec["flicker_l_dbc_hz"]["%g" % df] = 10 * math.log10(lf) + 20 * math.log10(mult_out) if lf > 0 else None
                    if qs is not None and qs["k_hz_per_a"] is not None:
                        lq = quasi_static_l(qs["k_hz_per_a"], qs["weight"], fl, mult, df)
                        qs["l_dbc_hz"]["%g" % df] = 10 * math.log10(lq) + 20 * math.log10(mult_out) if lq > 0 else None
                        rec["flicker_used"]["%g" % df] = "quasi_static" if lq > lf else "isf"
                        lf = max(lf, lq)
                    flick[df] += lf
            if isinstance(s.get("shot"), dict) or fl:
                dn = (s.get("shot") if isinstance(s.get("shot"), dict) else fl)["device"]
                rec["conduction"] = [{k: r[k] for k in r} for r in cond[dn]]
            per_source[s["name"]] = rec
        if failed:
            diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": (
                "%d of %d ISF runs failed or stopped early (first: %s); see work/isf_*.log" % (len(failed), len(jobs), failed[0]))})
            response["status"] = "failed"
        for df in offsets:
            white = 10 * math.log10(total[df]) + 20 * math.log10(mult_out) if total[df] > 0 and not failed else None
            val = 10 * math.log10(total[df] + flick[df]) + 20 * math.log10(mult_out) if total[df] > 0 and not failed else None
            m["l_%g_hz_dbc" % df] = {"value": val, "unit": "dBc/Hz", "status": "measured" if val is not None else "missing"}
            if any(s.get("flicker") for s in sources):
                m["l_white_%g_hz_dbc" % df] = {"value": white, "unit": "dBc/Hz", "status": "measured" if white is not None else "missing"}
        result.update(phases=nph, window_periods=win, dq_c=dq, dl_vs=dl, pulse_s=w, output_multiplier=mult_out, temp_k=temp_k,
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
