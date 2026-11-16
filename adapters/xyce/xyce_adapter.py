#!/usr/bin/env python3
"""Xyce adapter for Simra Agent (contract simra.adapter/0). Python 3.6 or later, standard library only.

Usage: xyce_adapter.py <request.json>

Operations (see adapter.json and README.md):
  parse     netlist check with Xyce -norun, and the model gaps: devices whose model Xyce does not have or does not
            accept, model parameters that Xyce ignores, model versions that Xyce replaces, dot lines that Xyce ignores.
  simulate  one Xyce run of a deck (AC, transient, DC, .LIN); .measure results as measurements; Touchstone files of
            a .LIN analysis as outputs with the role touchstone.
  hb        harmonic balance: tones, harmonics per tone, start-up periods, a wall-time limit per point, power per
            mixing product at named ports, DC currents, convergence state per point; an optional sweep with gain and
            P1dB. One Xyce process per sweep point, so that a failed point is never missing without a trace.
  hb_limits the operating limits of each HBT under the drive of an hb experiment (hb_limits.py): cycle-mean values and
            the peak terminal voltages from the harmonics of the terminal voltages and lead currents.

Behaviour of Xyce 7.10 that the adapter guards against (each one gives a wrong number with no error from Xyce):
  - ".temp" is ignored with a warning ("Unrecognized dot line"): the run is at 27 C. The adapter refuses a deck with
    .temp; use the input temp_c (written as ".options device temp=").
  - A second ".param" of a name and a second ".options device temp" are ignored: Xyce keeps the first. The adapter
    writes the caller's params and temp_c before the deck, so that they replace the deck's values.
  - The YLIN device (Touchstone data in Xyce) is an open circuit in .ac, .tran, .lin and .op. The adapter refuses a
    deck with YLIN in simulate; YLIN is accepted in hb.
  - At a global temperature of -40 C or 125 C the HB of a PDK HBT circuit often fails (DC point or HB Newton) where it
    converges at 27 C. Input temperature_method "dtemp_tf" (hb, hb_limits) runs at a global 27 C with dtemp = T - 27
    on every npn13G2 instance and vbic_tf of the HBT corner section scaled by ((T + 273) / 300)^0.7 (registry entry
    xyce-sg13g2-hbt-dtemp: the card computes tf from the global temperature only).
  - A harmonic-balance point that does not converge can be left out of a stepped output with no error. The adapter
    runs one process per point and compares the requested points with the results.
The adapter holds no PDK facts: model libraries come from the caller (input libs).
"""

import concurrent.futures
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import time

CONTRACT = "simra.adapter/0"
MAX_DIAGNOSTICS = 50
INCLUDE_LINE = re.compile(r"^\s*\.(include|inc|lib)\s+(.*)$", re.IGNORECASE)
PARAM_NAME = re.compile(r"^[A-Za-z_]\w*$")
TEMP_LINE = re.compile(r"^\s*\.temp\b", re.IGNORECASE)
YLIN_LINE = re.compile(r"^\s*ylin\w*\s", re.IGNORECASE)
ANALYSIS = re.compile(r"^\s*\.(ac|dc|tran|op|noise|lin|hb|mpde|step|sens)\b", re.IGNORECASE)
STRIP_LINE = re.compile(r"^\s*\.(ac|dc|tran|op|noise|lin|hb|mpde|step|sens|print|measure|meas|four|fft|end)\b"
                        r"|^\s*\.options?\s+hbint\b", re.IGNORECASE)
CONTROL_START = re.compile(r"^\s*\.control\b", re.IGNORECASE)
CONTROL_END = re.compile(r"^\s*\.endc\b", re.IGNORECASE)
BLOCK_START = re.compile(r"^(Netlist (?:error|warning)|Device model|Device instance|Error|Warning)\b", re.IGNORECASE)
BLOCK = re.compile(r"^Netlist (error|warning)(?: in file\s+(\S+)\s+at or near\s+line\s+(\d+))?:?\s*(.*)$", re.IGNORECASE)
DEVICE_COUNT = re.compile(r"^\s+(\w+)\s+level\s+(\S+)\s+\((.*)\)\s+(\d+)\s*$")
MEASURE_LINE = re.compile(r"^\s*(\S+)\s*=\s*(\S+)")
MPI_START_FAILURE = re.compile(r"orte_init|opal_init|PMIx|ORTE_ERROR|It looks like MPI_INIT failed", re.IGNORECASE)

# Model findings in the Xyce log: (class, regex). The classes "model_missing" and "parameter_unrecognized" are gaps
# (the device cannot be simulated with this model); the others are fidelity warnings.
FINDINGS = [
    ("model_missing", re.compile(r"Model is required for device (\S+) and no valid model card found", re.I)),
    ("subcircuit_missing", re.compile(r"Subcircuit (\S+) has not been defined for instance (\S+)", re.I)),
    ("parameter_unrecognized", re.compile(r"Unrecognized parameter (\S+) for device (\S+)", re.I)),
    ("fields_unrecognized", re.compile(r"Unrecognized fields for device (\S+)", re.I)),
    ("parameter_ignored", re.compile(r"No model parameter (\S+) found for model (\S+) of type (\S+), parameter ignored", re.I)),
    ("version_substituted", re.compile(r"Device model (\S+): Model card specifies (.*?) which is older than the oldest "
                                       r"version supported in Xyce \(([^)]+)\)", re.I)),
    ("dot_line_ignored", re.compile(r"Unrecognized dot line will be ignored", re.I)),
]
GAPS = ("model_missing", "subcircuit_missing", "parameter_unrecognized")


# ------------------------------------------------------------------------------------------------------------ files
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def display_path(path, root):
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


def unquote(text):
    text = text.strip()
    return text[1:-1] if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"" else text


def split_args(text):
    return [unquote(w) for w in re.findall(r"\"[^\"]*\"|'[^']*'|\S+", text)]


class Closure(object):
    """The files that one run reads (deck, includes, libraries), with their hashes."""

    def __init__(self, root):
        self.root, self.files, self.seen, self.missing = root, [], set(), []

    def add(self, path, role):
        path = os.path.realpath(path)
        if path in self.seen:
            return False
        self.seen.add(path)
        self.files.append({"path": display_path(path, self.root), "sha256": sha256(path), "bytes": os.path.getsize(path), "role": role})
        return True

    def add_netlist(self, path, role, child_role):
        if not self.add(path, role):
            return
        base = os.path.dirname(os.path.realpath(path))
        with open(path, errors="replace") as f:
            for line in f:
                m = INCLUDE_LINE.match(line)
                words = split_args(m.group(2)) if m else []
                if not words or (m.group(1).lower() == "lib" and len(words) < 2):
                    continue
                name = os.path.expandvars(words[0])
                target = name if os.path.isabs(name) else os.path.join(base, name)
                if not os.path.isfile(target) and not os.path.isabs(name):
                    target = os.path.join(self.root, name)
                if os.path.isfile(target):
                    self.add_netlist(target, child_role, child_role)
                else:
                    self.missing.append("{} (from {})".format(words[0], display_path(path, self.root)))


def design_lines(closure):
    """(file, line number, text) of every netlist line in the design root (deck and design includes)."""
    out = []
    for f in closure.files:
        if f["role"] in ("deck", "include") and not os.path.isabs(f["path"]):
            with open(os.path.join(closure.root, f["path"]), errors="replace") as fh:
                out.extend((f["path"], k, line) for k, line in enumerate(fh.read().splitlines(), 1))
    return out


def failure(tool, message, measurements=None):
    return {"contract": CONTRACT, "status": "failed", "tool": tool, "input_files": None, "outputs": [],
            "measurements": measurements or {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


def xyce_version():
    try:
        out = subprocess.check_output(["Xyce", "-v"], stderr=subprocess.STDOUT, universal_newlines=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"Xyce Release (\S+)", out)
    return m.group(1) if m else out.strip() or None


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# ------------------------------------------------------------------------------------------------------- the inputs
def deck_and_libs(root, inputs):
    deck = inputs.get("deck")
    if not isinstance(deck, str):
        return None, None, "input 'deck' is required (path of the netlist, relative to the design root)"
    deck_path = os.path.join(root, deck)
    if not os.path.isfile(deck_path):
        return None, None, "deck not found: {}".format(deck)
    libs = []
    for lib in inputs.get("libs") or []:
        path = os.path.expandvars(lib.get("path", ""))
        if not os.path.isabs(path):
            path = os.path.join(root, path)
        if not os.path.isfile(path):
            return None, None, "library not found: {} (expanded: {})".format(lib.get("path"), path)
        libs.append((path, lib.get("section")))
    return deck_path, libs, None


def setting_lines(inputs, extra_params=None):
    """(lines, None) or (None, message): the .param lines of params (and extra_params) and the temperature line of
    temp_c. They go BEFORE the deck: Xyce keeps the first definition of a parameter and of the device temperature."""
    lines = []
    params = dict(inputs.get("params") or {})
    if not isinstance(inputs.get("params") or {}, dict):
        return None, "input 'params' must be an object {name: number or string}"
    params.update(extra_params or {})
    for name in sorted(params):
        value = params[name]
        if not PARAM_NAME.match(name):
            return None, "input 'params': '{}' is not a parameter name".format(name)
        if not number(value) and not (isinstance(value, str) and value.strip() and "\n" not in value):
            return None, "input 'params': the value of '{}' must be a finite number or a one-line string".format(name)
        lines.append(".param {}={}".format(name, repr(value) if isinstance(value, float) else value))
    temp_c = inputs.get("temp_c")
    if temp_c is not None:
        if not number(temp_c):
            return None, "input 'temp_c' must be a finite number (degrees Celsius)"
        lines.append(".options device temp={}".format(temp_c))
    return lines, None


def guard_diagnostics(lines, operation):
    """Errors for deck lines that Xyce runs without an error but with a wrong result."""
    diags = []
    has_ylin = any(YLIN_LINE.match(t) for _, _, t in lines)
    for path, k, text in lines:
        src = "{}:{}".format(path, k)
        if TEMP_LINE.match(text):
            diags.append({"severity": "error", "source": src, "message": (
                "'{}': Xyce ignores .temp (it only warns 'Unrecognized dot line'), so the run would be at 27 C. Remove the "
                "line and give the input temp_c, which the adapter writes as '.options device temp='".format(text.strip()))})
        if has_ylin and operation == "simulate" and ANALYSIS.match(text) and not re.match(r"^\s*\.(hb|step)\b", text, re.I):
            diags.append({"severity": "error", "source": src, "message": (
                "'{}': the deck has a YLIN device, which Xyce treats as an open circuit in .ac, .tran, .lin, .dc and .op "
                "with no warning. Use the operation hb, or a subcircuit from the touchstone adapter (fit_to_spice)".format(text.strip()))})
    return diags


def write_top(path, header, settings, libs, include):
    with open(path, "w") as f:
        f.write("* {}\n".format(header))
        for line in settings:
            f.write(line + "\n")
        for lib, section in libs:
            f.write('.lib "{}" {}\n'.format(lib, section) if section else '.include "{}"\n'.format(lib))
        f.write('.include "{}"\n'.format(include))


# ------------------------------------------------------------------------------------------------------------- runs
def run_xyce(argv, cwd, log_path, timeout_s=None, retries=2):
    """Run Xyce; retry when Open MPI fails to start (it fails at random on some hosts). Returns (code, state, commands);
    state is "completed", "timeout" or "not started"."""
    commands = []
    for attempt in range(retries + 1):
        t0 = time.time()
        state = "completed"
        with open(log_path, "w") as log:
            try:
                p = subprocess.Popen(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                     env=dict(os.environ, OMP_NUM_THREADS="1"))
            except OSError as e:
                log.write("could not start Xyce: {}\n".format(e))
                commands.append({"argv": argv, "exit_code": None, "runtime_s": None})
                return None, "not started", commands
            try:
                code = p.wait(timeout=timeout_s)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                code, state = None, "timeout"
        commands.append({"argv": argv, "exit_code": code, "runtime_s": round(time.time() - t0, 3)})
        with open(log_path, errors="replace") as fh:
            text = fh.read()
        if code not in (0, None) and MPI_START_FAILURE.search(text) and "Executing netlist" not in text and attempt < retries:
            continue
        return code, state, commands
    return code, state, commands


def log_blocks(lines):
    """[(severity, file, line, message)] from the "Netlist error/warning" blocks of a Xyce log. A block continues on
    the indented lines after its first line."""
    blocks, current = [], None
    for line in lines:
        if line.startswith(" ") and current is not None and line.strip():
            current.append(line.strip())
            continue
        if current is not None:
            blocks.append(" ".join(current))
            current = None
        if re.match(r"^Netlist (error|warning)", line, re.I):
            current = [line.strip()]
    if current is not None:
        blocks.append(" ".join(current))
    out = []
    for b in blocks:
        m = BLOCK.match(b)
        if m:
            out.append((m.group(1).lower(), m.group(2), int(m.group(3)) if m.group(3) else None, m.group(4).strip()))
    return out


def device_counts(lines):
    return [{"letter": m.group(1), "level": m.group(2), "model": m.group(3), "count": int(m.group(4))}
            for m in (DEVICE_COUNT.match(l) for l in lines) if m]


def source_text(path, line):
    try:
        with open(path, errors="replace") as fh:
            return fh.read().splitlines()[line - 1].strip()
    except (OSError, IndexError, TypeError):
        return None


def findings(blocks, root, work_dir):
    """Model findings with class, severity, source and message, from the log blocks."""
    out = []
    for severity, path, line, message in blocks:
        full = path if path is None or os.path.isabs(path) else os.path.join(work_dir, path)
        src = "{}:{}".format(display_path(full, root), line) if path else "work/xyce.log"
        for cls, rx in FINDINGS:
            m = rx.search(message)
            if not m:
                continue
            if cls == "dot_line_ignored":
                text = source_text(full, line) if path else None
                message = "Xyce ignores the dot line{}".format(" '{}'".format(text) if text else "")
            out.append({"class": cls, "severity": "error" if cls in GAPS else "warning", "source": src,
                        "message": "{}: {}".format(cls.replace("_", " "), message), "groups": list(m.groups())})
            break
        else:
            out.append({"class": "netlist_" + severity, "severity": severity, "source": src, "message": message, "groups": []})
    return out


def outputs_of(work_dir, root, skip=()):
    out = []
    for name in sorted(os.listdir(work_dir)):
        path = os.path.join(work_dir, name)
        if os.path.isfile(path) and name not in skip:
            e = {"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path)}
            if re.search(r"\.s\d+p$", name, re.I):
                e["role"] = "touchstone"
            elif name == "sweep.json":
                e["role"] = "sweep"
            out.append(e)
    return out


def prepare(request, operation, extra_params=None):
    """(context, None) or (None, response): the deck, the libraries, the settings, the hashed input files and the
    guard diagnostics."""
    root = request["root"]
    inputs = request.get("inputs") or {}
    tool = {"name": "Xyce", "version": xyce_version()}
    deck_path, libs, error = deck_and_libs(root, inputs)
    if error:
        return None, failure(tool, error)
    settings, error = setting_lines(inputs, extra_params)
    if error:
        return None, failure(tool, error)
    closure = Closure(root)
    closure.add_netlist(deck_path, "deck", "include")
    for path, _ in libs:
        closure.add_netlist(path, "model", "model")
    diagnostics = [{"severity": "warning", "message": "not hashed, file not found: " + m, "source": "adapter"} for m in closure.missing]
    diagnostics += guard_diagnostics(design_lines(closure), operation)
    if inputs.get("params") or inputs.get("temp_c") is not None:
        diagnostics.append({"severity": "info", "source": "adapter", "message": (
            "params and temp_c are written before the deck: Xyce keeps the first .param of a name and the first device "
            "temperature, so they replace the deck's values")})
    return {"root": root, "inputs": inputs, "tool": tool, "deck": deck_path, "libs": libs, "settings": settings,
            "closure": closure, "diagnostics": diagnostics}, None


def respond(ctx, status, outputs, measurements, diagnostics, commands, report=None):
    r = {"contract": CONTRACT, "status": status, "tool": ctx["tool"],
         "input_files": {"files": ctx["closure"].files, "complete": not ctx["closure"].missing},
         "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics[:MAX_DIAGNOSTICS] if len(diagnostics) > MAX_DIAGNOSTICS else diagnostics,
         "commands": commands}
    if report is not None:
        r["report"] = report
    return r


# ---------------------------------------------------------------------------------------------------------- parse
def parse(request):
    ctx, response = prepare(request, "parse")
    if response:
        return response
    work_dir, root = request["work_dir"], ctx["root"]
    top = os.path.join(work_dir, "top.cir")
    write_top(top, "simra xyce adapter: netlist check (Xyce -norun)", ctx["settings"], ctx["libs"], os.path.realpath(ctx["deck"]))
    log_path = os.path.join(work_dir, "xyce.log")
    code, state, commands = run_xyce(["Xyce", "-norun", "top.cir"], work_dir, log_path, timeout_s=600)
    with open(log_path, errors="replace") as fh:
        lines = fh.read().splitlines()
    if state == "not started":
        return failure(ctx["tool"], "could not start Xyce (is it on the PATH?)")
    found = findings(log_blocks(lines), root, work_dir)
    devices = device_counts(lines)
    gaps = [f for f in found if f["class"] in GAPS]
    gap_devices = sorted(set(f["groups"][0] if f["class"] == "model_missing" else f["groups"][1] for f in gaps))
    fidelity = [f for f in found if f["class"] in ("parameter_ignored", "version_substituted")]
    ignored = [f for f in found if f["class"] == "dot_line_ignored"]
    errors = [f for f in found if f["severity"] == "error"]
    diagnostics = ctx["diagnostics"] + [{"severity": f["severity"], "source": f["source"], "message": f["message"]} for f in found]
    if code != 0 and not errors:
        diagnostics.insert(0, {"severity": "error", "source": "work/xyce.log", "message": "Xyce -norun exited with code {}".format(code)})
    m = lambda v: {"value": v, "unit": None, "status": "measured"}
    measurements = {"model_gaps": m(len(gap_devices)), "fidelity_warnings": m(len(fidelity)), "ignored_lines": m(len(ignored)),
                    "netlist_errors": m(sum(1 for f in found if f["severity"] == "error")),
                    "devices": m(sum(d["count"] for d in devices)) if devices else {"value": None, "unit": None, "status": "missing"}}
    with open(os.path.join(work_dir, "parse.json"), "w") as fh:
        json.dump({"exit_code": code, "devices": devices, "findings": found, "gap_devices": gap_devices}, fh, indent=2)
        fh.write("\n")
    report = ["devices: " + (", ".join("{} level {} ({}) x{}".format(d["letter"], d["level"], d["model"], d["count"]) for d in devices) or
                             "no device count (the netlist did not reach the topology step)")]
    report += ["{} {}".format(f["class"], " ".join(g for g in f["groups"] if g)) for f in found if f["class"] in GAPS + ("parameter_ignored", "version_substituted", "dot_line_ignored")][:40]
    return respond(ctx, "completed", outputs_of(work_dir, root), measurements, diagnostics, commands, report)


# ------------------------------------------------------------------------------------------------------- simulate
def measure_files(work_dir, stem):
    """{NAME: [(value or None, source)]} from the .measure files of Xyce (<stem>.ma0, .mt0, .md0 ...)."""
    out = {}
    for name in sorted(os.listdir(work_dir)):
        if not re.match(re.escape(stem) + r"\.m[a-z]\d+$", name):
            continue
        with open(os.path.join(work_dir, name), errors="replace") as fh:
            for k, line in enumerate(fh.read().splitlines(), 1):
                m = MEASURE_LINE.match(line)
                if not m:
                    continue
                try:
                    value = float(m.group(2))
                except ValueError:
                    value = None
                out.setdefault(m.group(1).upper(), []).append((value, "work/{}:{}".format(name, k)))
    return out


def simulate(request):
    ctx, response = prepare(request, "simulate")
    if response:
        return response
    work_dir, root, inputs = request["work_dir"], ctx["root"], ctx["inputs"]
    diagnostics = list(ctx["diagnostics"])
    wanted = inputs.get("measurements") or {}
    if any(d["severity"] == "error" for d in diagnostics):
        measurements = {n: {"value": None, "unit": u, "status": "failed"} for n, u in wanted.items()}
        return respond(ctx, "failed", [], measurements, diagnostics, [])
    top = os.path.join(work_dir, "top.cir")
    write_top(top, "simra xyce adapter: top level for experiment {}".format(request.get("experiment")), ctx["settings"],
              ctx["libs"], os.path.realpath(ctx["deck"]))
    with open(top, "a") as f:
        f.write(".end\n")
    log_path = os.path.join(work_dir, "xyce.log")
    argv = ["Xyce", "-redefined_params", "usefirst", "top.cir"]
    code, state, commands = run_xyce(argv, work_dir, log_path, timeout_s=inputs.get("timeout_s"))
    if state == "not started":
        return failure(ctx["tool"], "could not start Xyce (is it on the PATH?)")
    with open(log_path, errors="replace") as fh:
        lines = fh.read().splitlines()
    found = findings(log_blocks(lines), root, work_dir)
    diagnostics += [{"severity": f["severity"], "source": f["source"], "message": f["message"]} for f in found]
    if code != 0:
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message": "Xyce exited with code {}{}".format(
            code, " (timeout)" if state == "timeout" else "")})
    values = measure_files(work_dir, "top.cir")
    names = list(wanted) if wanted else sorted(values)
    measurements = {}
    for name in names:
        unit = wanted.get(name) if wanted else None
        got = values.get(name.upper())
        if not got:
            measurements[name] = {"value": None, "unit": unit, "status": "missing"}
            continue
        value, source = got[-1]
        if len(got) > 1:
            diagnostics.append({"severity": "warning", "source": source, "message": "{} appears {} times (steps); the last value is used".format(name, len(got))})
        measurements[name] = {"value": value, "unit": unit, "status": "measured" if value is not None else "failed", "source": source}
    status = "completed" if code == 0 else "failed"
    return respond(ctx, status, outputs_of(work_dir, root), measurements, diagnostics, commands)


# ------------------------------------------------------------------------------------------------------------- hb
HBT_INSTANCE = re.compile(r"^\s*x\S*\s.*\snpn13g2(\s|$)", re.IGNORECASE)


def tf_factor(temp_c):
    """Factor on vbic_tf that gives tf(T) at a global 27 C: the PDK card scales tf by ((temper + 273) / 300)^0.7."""
    return ((temp_c + 273.0) / 300.0) ** 0.7


def hbt_section_tf(lib, section, temp_c, out_path):
    """Write a copy of section `section` of the HBT corner library `lib` with vbic_tf scaled for temp_c. Returns None
    or an error message. The PDK file is read, not changed."""
    path = os.path.expandvars(lib)
    try:
        text = open(path, errors="replace").read()
    except OSError as e:
        return "temperature_method dtemp_tf: cannot read {}: {}".format(lib, e)
    m = re.search(r"^\.lib\s+%s\s*$(.*?)^\.endl" % re.escape(section), text, flags=re.M | re.S | re.I)
    if m is None:
        return "temperature_method dtemp_tf: no section {} in {}".format(section, lib)
    k = tf_factor(temp_c)
    body, n = re.subn(r"(\.param\s+vbic_tf\s*=\s*)(\S+)", lambda mm: "%s{%s*%.6f}" % (mm.group(1), mm.group(2), k), m.group(1), flags=re.I)
    if n != 1:
        return "temperature_method dtemp_tf: expected one vbic_tf parameter in section {} of {}, found {}".format(section, lib, n)
    base = os.path.dirname(path)
    body = re.sub(r"^(\s*\.(?:include|inc|lib)\s+)[\"']?([^\s\"']+)[\"']?", lambda mm: mm.group(1) + '"' + (
        mm.group(2) if os.path.isabs(mm.group(2)) else os.path.join(base, mm.group(2))) + '"', body, flags=re.M | re.I)
    with open(out_path, "w") as fh:
        fh.write("* {} section {}: vbic_tf x {:.6f} for {:g} C at a global 27 C (simra xyce adapter, dtemp_tf)\n{}".format(lib, section, k, temp_c, body))
    return None


def inline_includes(lines, depth=0):
    """The lines with every '.include' / '.inc' of an existing file replaced by its lines (recursive, 4 levels)."""
    out = []
    for line in lines:
        m = INCLUDE_LINE.match(line)
        words = split_args(m.group(2)) if m else []
        if m and m.group(1).lower() != "lib" and words and depth < 4:
            path = os.path.expandvars(words[0])
            if os.path.isfile(path):
                sub, _ = circuit_lines(path)
                out += inline_includes(sub, depth + 1)
                continue
        out.append(line)
    return out


def apply_dtemp_tf(inputs, libs, circuit, work_dir):
    """(inputs, libs, circuit, message, error) for temperature_method dtemp_tf; unchanged at 27 C."""
    temp_c = inputs.get("temp_c")
    if temp_c is None or abs(float(temp_c) - 27.0) < 1e-9:
        return inputs, libs, circuit, None, None
    dt = float(temp_c) - 27.0
    new_libs, scaled = [], 0
    for k, (lib, section) in enumerate(libs):
        if section and re.search(r"cornerhbt\.lib$", lib, re.I):
            out = os.path.join(work_dir, "hbt_tf_{}.lib".format(k))
            err = hbt_section_tf(lib, section, float(temp_c), out)
            if err:
                return None, None, None, None, err
            new_libs.append((out, None))
            scaled += 1
        else:
            new_libs.append((lib, section))
    if not scaled:
        return None, None, None, None, "temperature_method dtemp_tf needs the HBT corner library (cornerHBT.lib with a section) in libs"
    flat = inline_includes(circuit)
    n = 0
    for i, line in enumerate(flat):
        if HBT_INSTANCE.match(line):
            if re.search(r"\sdtemp\s*=", line, re.I):
                return None, None, None, None, "temperature_method dtemp_tf: the instance '{}' already sets dtemp".format(line.split()[0])
            flat[i] = line.rstrip() + " dtemp={:g}".format(dt)
            n += 1
    inputs = dict(inputs, temp_c=27)
    msg = ("temperature method dtemp_tf: global 27 C, dtemp={:g} on {} npn13G2 instances, vbic_tf x {:.4f} in {} HBT "
           "corner section(s) (registry xyce-sg13g2-hbt-dtemp)").format(dt, n, tf_factor(float(temp_c)), scaled)
    return inputs, new_libs, flat, msg, None


def circuit_lines(deck_path):
    """The deck without .control blocks, analyses, outputs and HB options; relative includes become absolute.
    Returns (lines, removed lines)."""
    base = os.path.dirname(os.path.realpath(deck_path))
    lines, removed, in_control = [], [], False
    with open(deck_path, errors="replace") as f:
        for line in f.read().splitlines():
            if in_control:
                in_control = not CONTROL_END.match(line)
                continue
            if CONTROL_START.match(line):
                in_control = True
                continue
            if STRIP_LINE.match(line):
                if not re.match(r"^\s*\.end\s*$", line, re.I):
                    removed.append(line.strip())
                continue
            m = INCLUDE_LINE.match(line)
            words = split_args(m.group(2)) if m else []
            if words and not (m.group(1).lower() == "lib" and len(words) < 2):
                name = os.path.expandvars(words[0])
                if not os.path.isabs(name) and os.path.isfile(os.path.join(base, name)):
                    rest = " ".join(words[1:])
                    line = '.{} "{}"{}'.format(m.group(1), os.path.join(base, name), " " + rest if rest else "")
            lines.append(line)
    return lines, removed


def read_hb_csv(path):
    """[(freq, [complex per printed quantity])] from a Xyce hb_fd CSV file (two-sided spectrum)."""
    rows = []
    with open(path) as fh:
        next(fh)
        for line in fh:
            parts = [float(x) for x in line.strip().split(",") if x.strip()]
            if parts:
                rows.append((parts[0], [complex(parts[1 + 2 * k], parts[2 + 2 * k]) for k in range((len(parts) - 1) // 2)]))
    return rows


def at_frequency(rows, freq, tol):
    for f, vals in rows:
        if abs(f - freq) <= tol:
            return vals
    return None


def dbm(p_w):
    return 10 * math.log10(p_w / 1e-3) if p_w > 0 else -math.inf


def hb_point(rows, ports, products, dc_currents, tones):
    """{"p": {port: {product: dBm}}, "i": {source: A}} of one point, or (None, reason) when a product is missing.
    hb_fd is two-sided: the amplitude at f > 0 is 2 |X(f)|, so P = (2 |X|)^2 / (2 R) = 2 |X|^2 / R."""
    tol = 1e-6 * max(tones)
    out = {"p": {}, "i": {}}
    for name, prod in products.items():
        freq = abs(sum(m * f for m, f in zip(prod, tones)))
        vals = at_frequency(rows, freq, tol)
        if vals is None:
            return None, "product {} ({:.6g} Hz) is not in the output".format(name, freq)
        for k, (port, spec) in enumerate(ports):
            x = vals[k]
            p = (abs(x) ** 2 if freq == 0 else 2 * abs(x) ** 2) / float(spec["r_ohm"])
            out["p"].setdefault(port, {})[name] = dbm(p)
    if dc_currents:
        vals = at_frequency(rows, 0.0, tol)
        if vals is None:
            return None, "the DC point is not in the output"
        for k, src in enumerate(dc_currents):
            out["i"][src] = vals[len(ports) + k].real
    return out, None


def p1db(points, port):
    """Input and output 1 dB compression points from points sorted by input power, each {"pin", "ok", "gain"}.
    Returns (pin_1db, pout_1db, None) or (None, None, reason). The bracket is the run from the first point to the first
    point with gain <= G0 - 1 dB. A point inside the bracket that did not converge makes the result invalid: an
    interpolation across it can hide the real compression."""
    if not points or not points[0]["ok"]:
        return None, None, "the first sweep point (the small-signal gain) did not converge"
    g0 = points[0]["gain"][port]
    for k, pt in enumerate(points):
        if not pt["ok"]:
            return None, None, "sweep point {:g} dBm did not converge before 1 dB compression was reached".format(pt["pin"])
        g = pt["gain"][port]
        if g <= g0 - 1.0:
            if k == 0:
                return None, None, "no point before compression"
            a, b = points[k - 1], pt
            ga, gb = a["gain"][port], g
            x = a["pin"] + (g0 - 1.0 - ga) * (b["pin"] - a["pin"]) / (gb - ga)
            return x, x + g0 - 1.0, None
    return None, None, "no 1 dB compression in the sweep range (last point {:g} dBm, gain {:.3f} dB, small-signal {:.3f} dB)".format(
        points[-1]["pin"], points[-1]["gain"][port], g0)


def hb_inputs(inputs):
    """(spec, None) or (None, message): the checked HB inputs with defaults."""
    tones = inputs.get("tones")
    if not (isinstance(tones, list) and tones and all(number(f) and f > 0 for f in tones)):
        return None, "input 'tones' is required: a list of tone frequencies in Hz, for example [1e9]"
    h = inputs.get("harmonics", 25)
    harmonics = [h] * len(tones) if isinstance(h, int) else h
    if not (isinstance(harmonics, list) and len(harmonics) == len(tones) and all(isinstance(x, int) and x >= 1 for x in harmonics)):
        return None, "input 'harmonics' must be an integer >= 1 or one integer per tone"
    ports = inputs.get("ports")
    if not (isinstance(ports, dict) and ports):
        return None, "input 'ports' is required: {name: {\"node\": n, \"ref\": \"0\", \"r_ohm\": 50}} (the load resistance of the port)"
    plist = []
    for name, spec in ports.items():
        if not PARAM_NAME.match(name) or not isinstance(spec, dict) or not isinstance(spec.get("node"), str) or not (number(spec.get("r_ohm")) and spec["r_ohm"] > 0):
            return None, "input 'ports.{}' needs node (a string) and r_ohm (> 0)".format(name)
        plist.append((name, {"node": spec["node"], "ref": spec.get("ref", "0"), "r_ohm": spec["r_ohm"]}))
    products = inputs.get("products")
    if products is None:
        if len(tones) != 1:
            return None, "input 'products' is required with more than one tone: {name: [m1, m2, ...]} (frequency m1 f1 + m2 f2 + ...)"
        products = {"h1": [1], "h2": [2], "h3": [3]}
    if not (isinstance(products, dict) and products and all(PARAM_NAME.match(k) and isinstance(v, list) and len(v) == len(tones)
                                                             and all(isinstance(x, int) for x in v) for k, v in products.items())):
        return None, "input 'products' must be {name: [one integer per tone]}"
    for name, prod in products.items():
        if any(abs(m) > hh for m, hh in zip(prod, harmonics)):
            return None, "product {} needs more harmonics than input 'harmonics' gives".format(name)
    dc = inputs.get("dc_currents") or []
    if not (isinstance(dc, list) and all(isinstance(x, str) and PARAM_NAME.match(x) for x in dc)):
        return None, "input 'dc_currents' must be a list of voltage source names"
    sweep = inputs.get("sweep")
    if sweep is not None:
        if not (isinstance(sweep, dict) and isinstance(sweep.get("param"), str) and PARAM_NAME.match(sweep["param"])
                and isinstance(sweep.get("values"), list) and sweep["values"] and all(number(v) for v in sweep["values"])):
            return None, "input 'sweep' must be {\"param\": name, \"values\": [numbers], \"available_power_dbm\": true or false}"
    wall = inputs.get("wall_s_per_point", 600)
    startup = inputs.get("startup_periods", 10)
    parallel = inputs.get("parallel", 1)
    if not (number(wall) and wall > 0 and isinstance(startup, int) and startup >= 0 and isinstance(parallel, int) and parallel >= 1):
        return None, "inputs wall_s_per_point (> 0), startup_periods (an integer >= 0) and parallel (an integer >= 1) are not valid"
    return {"tones": [float(f) for f in tones], "harmonics": harmonics, "ports": plist, "products": products, "dc": dc,
            "sweep": sweep, "wall": float(wall), "startup": startup, "parallel": parallel}, None


def hb(request, extra_prints=None):
    """Harmonic balance. extra_prints (for hb_limits): more quantities in the hb_fd output, after the ports and the DC
    currents (the CSV columns of hb_point stay in place); each converged point gets "fd_csv", the path of its file."""
    inputs = request.get("inputs") or {}
    tool = {"name": "Xyce", "version": None}
    spec, error = hb_inputs(inputs)
    if error:
        return failure(tool, error)
    ctx, response = prepare(request, "hb")
    if response:
        return response
    work_dir, root = request["work_dir"], ctx["root"]
    diagnostics = list(ctx["diagnostics"])
    names = []
    for port, _ in spec["ports"]:
        names += [("p_{}_{}_dbm".format(port, prod), "dBm") for prod in spec["products"]]
    names += [("i_{}_a".format(src), "A") for src in spec["dc"]]
    sweep = spec["sweep"]
    gain = bool(sweep and sweep.get("available_power_dbm"))
    first = list(spec["products"])[0]
    if gain:
        names += [("gain_{}_db".format(port), "dB") for port, _ in spec["ports"]]
    if any(d["severity"] == "error" for d in diagnostics):
        return respond(ctx, "failed", [], {n: {"value": None, "unit": u, "status": "failed"} for n, u in names}, diagnostics, [])

    circuit, removed = circuit_lines(ctx["deck"])
    if removed:
        diagnostics.append({"severity": "info", "source": "adapter", "message": "removed from the deck for hb: " + "; ".join(removed[:10])})
    method = inputs.get("temperature_method", "global")
    if method not in ("global", "dtemp_tf"):
        return failure(tool, "input 'temperature_method' is 'global' (the default) or 'dtemp_tf'")
    if method == "dtemp_tf":
        t_inputs, t_libs, t_circuit, msg, err = apply_dtemp_tf(ctx["inputs"], ctx["libs"], circuit, work_dir)
        if err:
            return failure(tool, err)
        ctx["inputs"], ctx["libs"], circuit = t_inputs, t_libs, t_circuit
        if msg:
            diagnostics.append({"severity": "info", "source": "adapter", "message": msg})
            ctx["tool"]["temperature_method"] = {"method": method, "temp_c": inputs.get("temp_c")}
    circ_path = os.path.join(work_dir, "circuit.cir")
    with open(circ_path, "w") as fh:
        fh.write("* circuit of {} without analyses (simra xyce adapter, hb)\n".format(os.path.basename(ctx["deck"])))
        fh.write("\n".join(circuit[1:] if circuit and circuit[0].startswith("*") else circuit) + "\n")
    values = sorted(sweep["values"]) if sweep else [None]
    prints = ["v({},{})".format(s["node"], s["ref"]) if s["ref"] != "0" else "v({})".format(s["node"]) for _, s in spec["ports"]]
    prints += ["i({})".format(src) for src in spec["dc"]]
    prints += list(extra_prints or [])
    ctx["tool"]["hb"] = {"tones_hz": spec["tones"], "harmonics": spec["harmonics"], "startup_periods": spec["startup"]}

    def one(k, value):
        tag = "hb_{}".format(k)
        extra = {sweep["param"]: value} if sweep else {}
        settings, _ = setting_lines(ctx["inputs"], extra)
        deck = os.path.join(work_dir, tag + ".cir")
        write_top(deck, "simra xyce adapter: harmonic balance, point {}{}".format(
            k, "" if not sweep else ", {} = {:g}".format(sweep["param"], value)), settings, ctx["libs"], circ_path)
        with open(deck, "a") as fh:
            fh.write(".hb {}\n".format(" ".join("{:.12g}".format(f) for f in spec["tones"])))
            fh.write(".options hbint numfreq={} startupperiods={}\n".format(",".join(str(h) for h in spec["harmonics"]), spec["startup"]))
            fh.write(".print hb_fd format=csv file={}.csv {}\n.end\n".format(tag, " ".join(prints)))
        argv = ["Xyce", "-redefined_params", "usefirst", tag + ".cir"]
        code, state, commands = run_xyce(argv, work_dir, os.path.join(work_dir, tag + ".log"), timeout_s=spec["wall"])
        point = {"index": k, "value": value, "status": None, "reason": None, "exit_code": code,
                 "runtime_s": commands[-1]["runtime_s"] if commands else None, "commands": commands}
        csv = os.path.join(work_dir, tag + ".csv")
        if state == "timeout":
            point.update(status="timeout", reason="no result in {:g} s (wall_s_per_point)".format(spec["wall"]))
        elif code != 0:
            point.update(status="failed", reason="Xyce exited with code {} (see work/{}.log)".format(code, tag))
        elif not os.path.isfile(csv):
            point.update(status="missing", reason="Xyce exited with 0 but wrote no output (see work/{}.log)".format(tag))
        else:
            data, why = hb_point(read_hb_csv(csv), spec["ports"], spec["products"], spec["dc"], spec["tones"])
            if data is None:
                point.update(status="missing", reason=why)
            else:
                point.update(status="converged", **data)
                if extra_prints:
                    point["fd_csv"] = os.path.basename(csv)
                if gain:
                    point["gain"] = {port: point["p"][port][first] - value for port, _ in spec["ports"]}
        return point

    with concurrent.futures.ThreadPoolExecutor(max_workers=spec["parallel"]) as pool:
        points = list(pool.map(lambda kv: one(*kv), enumerate(values)))
    commands = [c for p in points for c in p.pop("commands")]
    for p in points:
        if p["status"] != "converged":
            diagnostics.append({"severity": "error", "source": "adapter", "message": "point {}{}: {}: {}".format(
                p["index"], "" if not sweep else " ({} = {:g})".format(sweep["param"], p["value"]), p["status"], p["reason"])})
    ok = [p for p in points if p["status"] == "converged"]
    if ok and all(v < -200 for p in ok for port in p["p"].values() for v in port.values()):
        diagnostics.append({"severity": "warning", "source": "adapter", "message": (
            "no signal above -200 dBm at any port and product: a circuit without a source at the tone (for example an "
            "oscillator) converges to its DC state in Xyce HB with no error; Xyce has no autonomous HB")})

    measurements = {}

    def put(name, unit, getter):
        """A scalar (no sweep) or <name>.min and <name>.max (sweep). Any point that did not converge makes them failed."""
        vals = [(p, getter(p)) for p in points]
        bad = [p for p in points if p["status"] != "converged"]
        if not sweep:
            p, v = vals[0]
            measurements[name] = {"value": v if not bad else None, "unit": unit, "status": "measured" if not bad else "failed",
                                  "source": "work/hb.json"}
            return
        for side, pick in (("min", min), ("max", max)):
            key = "{}.{}".format(name, side)
            if bad:
                measurements[key] = {"value": None, "unit": unit, "status": "failed", "source": "work/hb.json", "at": None,
                                     "reason": "{} of {} sweep points did not converge (first: {} = {:g})".format(
                                         len(bad), len(points), sweep["param"], bad[0]["value"])}
                continue
            p, v = pick(vals, key=lambda pv: pv[1])
            measurements[key] = {"value": v, "unit": unit, "status": "measured", "source": "work/hb.json", "at": {sweep["param"]: p["value"]}}

    for port, _ in spec["ports"]:
        for prod in spec["products"]:
            put("p_{}_{}_dbm".format(port, prod), "dBm", lambda p, port=port, prod=prod: p["p"][port][prod] if p["status"] == "converged" else None)
    for src in spec["dc"]:
        put("i_{}_a".format(src), "A", lambda p, src=src: p["i"][src] if p["status"] == "converged" else None)
    if gain:
        for port, _ in spec["ports"]:
            put("gain_{}_db".format(port), "dB", lambda p, port=port: p["gain"][port] if p["status"] == "converged" else None)
            p0 = points[0]
            measurements["gain_ss_{}_db".format(port)] = (
                {"value": p0["gain"][port], "unit": "dB", "status": "measured", "source": "work/hb.json", "at": {sweep["param"]: p0["value"]}}
                if p0["status"] == "converged" else {"value": None, "unit": "dB", "status": "failed"})
            seq = [{"pin": p["value"], "ok": p["status"] == "converged", "gain": p.get("gain", {})} for p in points]
            pin, pout, why = p1db(seq, port)
            for key, v in (("p1db_in_{}_dbm".format(port), pin), ("p1db_out_{}_dbm".format(port), pout)):
                measurements[key] = ({"value": v, "unit": "dBm", "status": "measured", "source": "work/hb.json"} if v is not None
                                     else {"value": None, "unit": "dBm", "status": "failed" if "converge" in why else "missing",
                                           "reason": why})
            if pin is None:
                diagnostics.append({"severity": "warning" if "converge" not in why else "error", "source": "adapter",
                                    "message": "P1dB at port {}: {}".format(port, why)})
    measurements["points_converged"] = {"value": len(ok), "unit": None, "status": "measured"}
    measurements["points_total"] = {"value": len(points), "unit": None, "status": "measured"}
    if sweep:
        # The sweep table (role sweep) for the requirement kind "sweep": one row per point, null where the point did not
        # converge, so that a reducer can apply the bracket rule.
        columns = []
        for port, _ in spec["ports"]:
            columns += ["p_{}_{}_dbm".format(port, prod) for prod in spec["products"]]
            if gain:
                columns.append("gain_{}_db".format(port))
        columns += ["i_{}_a".format(src) for src in spec["dc"]]

        def cell(p, c):
            if p["status"] != "converged":
                return None
            for port, _ in spec["ports"]:
                if c == "gain_{}_db".format(port):
                    return p["gain"][port]
                for prod in spec["products"]:
                    if c == "p_{}_{}_dbm".format(port, prod):
                        return p["p"][port][prod]
            return p["i"][c[2:-2]]
        table = {"sweep": sweep["param"], "columns": columns,
                 "rows": [dict([(sweep["param"], p["value"])] + [(c, cell(p, c)) for c in columns]) for p in points]}
        with open(os.path.join(work_dir, "sweep.json"), "w") as fh:
            json.dump(table, fh, indent=2)
            fh.write("\n")
    with open(os.path.join(work_dir, "hb.json"), "w") as fh:
        json.dump({"tones_hz": spec["tones"], "harmonics": spec["harmonics"], "startup_periods": spec["startup"],
                   "ports": dict(spec["ports"]), "products": spec["products"], "sweep": sweep, "points": points}, fh, indent=2)
        fh.write("\n")
    report = ["point {}{}: {}{}".format(p["index"], "" if not sweep else " {}={:g}".format(sweep["param"], p["value"]), p["status"],
                                         "" if p["status"] != "converged" else ", " + ", ".join(
                                             "{} {} {:.2f} dBm".format(port, first, p["p"][port][first]) for port, _ in spec["ports"]))
              for p in points][:60]
    status = "completed" if len(ok) == len(points) else "failed"
    return respond(ctx, status, outputs_of(work_dir, root), measurements, diagnostics, commands, report)


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: xyce_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    import device_probe  # here, not at the top: device_probe imports the helpers of this module
    def run_hb_limits(req):
        import hb_limits  # here: it imports the ngspice adapter (manifest uses_adapters), which only this operation needs
        return hb_limits.hb_limits(req)
    def run_crosscheck(req):
        import device_crosscheck  # here: it imports the helpers of this module
        return device_crosscheck.device_crosscheck(req)
    operation = {"parse": parse, "simulate": simulate, "hb": hb, "probe_devices": device_probe.probe_devices,
                 "hb_limits": run_hb_limits, "device_crosscheck": run_crosscheck}.get(request.get("operation"))
    response = operation(request) if operation else failure(None, "unknown operation: {}".format(request.get("operation")))
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=2)
        f.write("\n")
    os.rename(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
