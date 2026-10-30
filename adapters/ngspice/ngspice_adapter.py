#!/usr/bin/env python3
"""ngspice adapter for Simra Agent (contract simra.adapter/0).

Usage: ngspice_adapter.py <request.json>

Operation "simulate". Inputs:
  deck          path of the testbench, relative to the design root. Start it with a "*" comment line:
                the adapter includes it from a generated top level, so its first line is not a title.
  libs          optional list of {"path", "section"}. Each becomes a ".lib" line before the deck, for example
                a process corner. Environment variables such as $PDK_ROOT are expanded.
  measurements  optional map {name: unit}. Names are read from "name = value" lines in the ngspice output
                (from "meas" or "print"). The unit is declared by the caller; the adapter does not check it.
                Without this map, the adapter reports every "name = value" line it finds.
  params        optional map {name: number or string}. Each becomes a ".param name=value" line after the deck
                include. A string is written as is ("2p", "{vdd/2}"). ngspice uses the last definition of a
                name, so this value replaces a ".param" of the same name in the deck.
  temp_c        optional number. It becomes a ".temp" line after the deck include, so it replaces a ".temp" line
                of the deck (".option temp=" does not).

Sweep table. A sweep bench prints one line per sweep point from its .control block:
  ROW <sweep>=<value> <name>=<value> ...
for example "echo ROW vcm=$vcm gain_db=$&gain_db" in a foreach loop. The first key is the sweep variable. A value
is a number, optionally with a SPICE scale suffix (1k); a value that is empty or not a number means "no value at this
point". The adapter writes the table to work/sweep.json and
reports <name>.min and <name>.max for each column, with "at" ({<sweep>: value}, where the value occurs). Each is
"measured" only when every sweep point has a value; else it is "failed", so a missing point can never pass.

The adapter hashes every file that the simulation reads (deck, includes, libraries, .spiceinit, OSDI models)
and every file that it writes. It never decides whether a result is good: it reports execution status only.
It gives a warning for each simulator option that changes the circuit (see OPTION_RULES), with its file and line.

Operation "operating_point". Inputs: deck and libs, as for simulate, and technology (optional, the name of a
technology pack; the default is the pack whose "pdks" has $PDK). The adapter writes op.cir in the work directory:
the circuit lines of the deck without its .control blocks, analyses and .meas lines, then "op" and "show" for the
MOS devices. The technology pack gives the device letter and the parameter names of the MOS model (see
technologies/README.md). The operating point uses the DC values of the netlist sources. The response has, for
each MOS device, the measurements <device>.vgs, .vth, .vds, .vdsat, .id, .gm, .gds, .vov (|vgs| - |vth|) and
.sat_margin (|vds| - |vdsat|), and a warning for each device that is not in saturation. work/operating_point.json
has the same data with the region of each device.

Operation "lint". Inputs:
  files         list of netlist paths, relative to the design root. The adapter reads each file and the files
                that it includes from the design root, and gives the same option warnings. It runs no simulation.

Operation "check_design". It checks a design netlist against the design contract (the "design" section of
requirements.json) and runs no simulation. Inputs: file (relative to the design root), subckt, pins (in order),
elements (the allowed kinds: "mos", "r", "c"; the default is all three), devices (the allowed devices of the
technology pack; the default is all), limits ({gate_area_um2, r_ohm, c_f}, all maxima) and technology (optional, as
for operating_point). The technology pack gives the MOS devices, their
terminals, their parameters and the minimum sizes (ngspice.devices). The file holds only .subckt blocks. In a block,
an X line instantiates a device of the pack or another block of the file, and R and C lines are ideal elements with
a plain value. Each other line (sources, .model, .include, .param, expressions, ...) is an error. The response has
status "completed" also when the design has errors: each error is a diagnostic with severity "error" and the file
and line. The measurements are gate_area_um2 (W x L x m of all MOS devices, hierarchy expanded), mos_count and
design_errors. work/design.json has the errors, the elements and the measurements.
"""

import hashlib
import json
import math
import os
import re
import subprocess
import sys

CONTRACT = "simra.adapter/0"
NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
VALUE_LINE = re.compile(r"^\s*([A-Za-z_][\w.\[\]()]*)\s*=\s*(" + NUMBER + r")(?:\s.*)?$")
MEAS_FAILED = re.compile(r"^\s*meas\s+\w+\s+(\S+)\s.*failed!", re.IGNORECASE)
MEAS_ERROR = re.compile(r"^\s*Error:\s*measure\s+(\S+)", re.IGNORECASE)
DIAG_LINE = re.compile(r"^\s*(error|warning)\b[:\s]*(.*)$", re.IGNORECASE)
INCLUDE_LINE = re.compile(r"^\s*\.(include|inc|lib)\s+(.*)$", re.IGNORECASE)
OSDI_LINE = re.compile(r"^\s*osdi\s+(.*)$", re.IGNORECASE)
SOURCEPATH_LINE = re.compile(r"^\s*setcs\s+sourcepath\s*=\s*\((.*)\)", re.IGNORECASE)
OPTION_LINE = re.compile(r"^\s*\.?options?\s+(.*)$", re.IGNORECASE)
OPTION_ASSIGN = re.compile(r"([A-Za-z_]\w*)\s*=\s*([^\s,]+)")
ROW_LINE = re.compile(r"^\s*ROW\s+(.*)$")
ROW_NUMBER = re.compile(r"^(" + NUMBER + r")(meg|[tgkmunpf])?$", re.IGNORECASE)
PARAM_NAME = re.compile(r"^[A-Za-z_]\w*$")
MAX_DIAGNOSTICS = 50
GMIN_DEFAULT = 1e-12
SCALE = {"t": 1e12, "g": 1e9, "meg": 1e6, "k": 1e3, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15}


def spice_number(text):
    """A SPICE number such as 5e5, 500k or 1meg, or None."""
    m = re.match(r"^(" + NUMBER + r")(meg|[tgkmunpf])?", text.strip().lower())
    if not m:
        return None
    return float(m.group(1)) * SCALE.get(m.group(2), 1)


def si(value, unit):
    """A value with an SI prefix, for example 500 kΩ."""
    for prefix, scale in (("T", 1e12), ("G", 1e9), ("M", 1e6), ("k", 1e3), ("", 1), ("m", 1e-3), ("µ", 1e-6),
                          ("n", 1e-9), ("p", 1e-12), ("f", 1e-15)):
        if abs(value) >= scale:
            return "{:g} {}{}".format(value / scale, prefix, unit)
    return "{:g} {}".format(value, unit)


# Simulator options that add elements to the circuit. Each rule gives the message, or None when the value is safe.
OPTION_RULES = {
    "rshunt": lambda v: "connects a {} resistor from each node to ground".format(si(v, "Ω")),
    "cshunt": lambda v: "connects a {} capacitor from each node to ground".format(si(v, "F")),
    "gmin": lambda v: ("connects a conductance of {} across each pn junction and in parallel with each MOSFET "
                       "channel (the default is {:g} S)").format(si(v, "S"), GMIN_DEFAULT) if v > GMIN_DEFAULT else None,
}


def lint_lines(lines, source):
    """Warnings for the simulator options in netlist or .spiceinit lines. source names the file in the message."""
    diagnostics = []
    for number, line in enumerate(lines, 1):
        m = OPTION_LINE.match(line)
        if not m:
            continue
        for name, text in OPTION_ASSIGN.findall(m.group(1)):
            rule = OPTION_RULES.get(name.lower())
            value = spice_number(text)
            effect = rule(value) if rule and value is not None else None
            if effect:
                diagnostics.append({"severity": "warning", "source": "{}:{}".format(source, number), "message": (
                    "'{}' {}. The circuit does not have these elements. They can change the operating point, the gain "
                    "and the poles. Remove the option, or show that the result does not change without it.").format(
                        line.strip(), effect)})
    return diagnostics


def design_netlists(path, root, seen=None):
    """The netlist path and, recursively, the files that it includes from the design root (not the PDK)."""
    seen = set() if seen is None else seen
    real = os.path.realpath(path)
    if real in seen or not os.path.isfile(real):
        return []
    seen.add(real)
    files = [real]
    with open(real, errors="replace") as f:
        for line in f:
            m = INCLUDE_LINE.match(line)
            words = split_args(m.group(2)) if m else []
            if not words or (m.group(1).lower() == "lib" and len(words) < 2):
                continue
            name = os.path.expandvars(words[0])
            target = name if os.path.isabs(name) else os.path.join(os.path.dirname(real), name)
            if not os.path.relpath(os.path.realpath(target), os.path.realpath(root)).startswith(".."):
                files.extend(design_netlists(target, root, seen))
    return files


def lint_netlist(path, root):
    diagnostics = []
    for f in design_netlists(path, root):
        with open(f, errors="replace") as handle:
            diagnostics.extend(lint_lines(handle.read().splitlines(), display_path(f, root)))
    return diagnostics


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def unquote(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1]
    return text


def split_args(text):
    """Split the rest of a .include/.lib line into words; quoted words keep their spaces."""
    return [unquote(w) for w in re.findall(r"\"[^\"]*\"|'[^']*'|\S+", text)]


def display_path(path, root):
    # Compare real paths: on macOS the temporary directory /var/folders is a link to /private/var/folders.
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


class Closure(object):
    """The set of files that one simulation reads, with their hashes."""

    def __init__(self, root, search=()):
        self.root = root
        self.search = list(search)
        self.files = []
        self.seen = set()
        self.missing = []

    def add(self, path, role):
        path = os.path.realpath(path)
        if path in self.seen:
            return False
        self.seen.add(path)
        self.files.append({"path": display_path(path, self.root), "sha256": sha256(path),
                           "bytes": os.path.getsize(path), "role": role})
        return True

    def add_netlist(self, path, role, child_role):
        """Add a netlist file and, recursively, the files it includes."""
        if not self.add(path, role):
            return
        base = os.path.dirname(os.path.realpath(path))
        with open(path, errors="replace") as f:
            for line in f:
                m = INCLUDE_LINE.match(line)
                if not m:
                    continue
                words = split_args(m.group(2))
                # ".lib name" (one word) opens a section; ".lib file section" and ".include file" read a file.
                if m.group(1).lower() == "lib" and len(words) < 2:
                    continue
                if not words:
                    continue
                target = self.resolve(os.path.expandvars(words[0]), base)
                if target:
                    self.add_netlist(target, child_role, child_role)
                else:
                    self.missing.append("{} (from {})".format(words[0], display_path(path, self.root)))

    def resolve(self, name, base):
        for candidate in ([name] if os.path.isabs(name) else [os.path.join(base, name), os.path.join(self.root, name)]
                                                           + [os.path.join(d, name) for d in self.search]):
            if os.path.isfile(candidate):
                return candidate
        return None


def find_spiceinit(work_dir):
    """The .spiceinit that ngspice reads: the current directory first, then SPICE_USERINIT_DIR or HOME."""
    for d in (work_dir, os.environ.get("SPICE_USERINIT_DIR"), os.environ.get("HOME")):
        if d and os.path.isfile(os.path.join(d, ".spiceinit")):
            return os.path.join(d, ".spiceinit")
    return None


def sourcepath(path):
    """The directories that "setcs sourcepath = ( ... )" lines in a .spiceinit add to the ngspice search path."""
    dirs = []
    with open(path, errors="replace") as f:
        for line in f:
            m = SOURCEPATH_LINE.match(line)
            if m:
                dirs.extend(os.path.expandvars(w) for w in m.group(1).split() if w != "$sourcepath")
    return dirs


def add_spiceinit(closure, path):
    closure.add(path, "init")
    with open(path, errors="replace") as f:
        for line in f:
            m = OSDI_LINE.match(line)
            if m:
                target = os.path.expandvars(unquote(m.group(1)))
                if os.path.isfile(target):
                    closure.add(target, "model")
                else:
                    closure.missing.append("{} (from {})".format(target, path))


def row_number(text):
    """A ROW value: a number, optionally with a SPICE scale suffix (1k), or None."""
    m = ROW_NUMBER.match(text)
    if not m:
        return None
    value = float(m.group(1)) * SCALE.get((m.group(2) or "").lower(), 1)
    return value if math.isfinite(value) else None


def parse_rows(lines):
    """(table, sources) from the ROW lines of ngspice output, or (None, []) without ROW lines.

    table is {"sweep", "columns", "rows"} as in work/sweep.json; sources[i] is the log line of rows[i]."""
    sweep, columns, rows, sources = None, [], [], []
    for number, line in enumerate(lines, 1):
        m = ROW_LINE.match(line)
        if not m:
            continue
        row = {}
        for token in m.group(1).split():
            key, sep, text = token.partition("=")
            if not sep or not key:
                continue
            if sweep is None:
                sweep = key
            elif key != sweep and key not in columns:
                columns.append(key)
            row[key] = row_number(text)
        rows.append(row)
        sources.append("work/ngspice.log:{}".format(number))
    if sweep is None:
        return None, []
    # A key that a line does not have is "no value" at that point.
    rows = [dict([(sweep, r.get(sweep))] + [(c, r.get(c)) for c in columns]) for r in rows]
    return {"sweep": sweep, "columns": columns, "rows": rows}, sources


def sweep_measurements(table, sources, wanted):
    """(measurements, diagnostics): <column>.min and <column>.max for each column of the sweep table that is
    wanted (each column when wanted is empty). A column with a point without value gives "failed", not a value."""
    measurements, diagnostics = {}, []
    sweep, rows = table["sweep"], table["rows"]
    for c in table["columns"]:
        if wanted and c not in wanted:
            continue
        unit = wanted.get(c) if wanted else None
        empty = [i for i, r in enumerate(rows) if r[c] is None]
        if not rows or empty:
            diagnostics.append({"severity": "warning", "source": sources[empty[0]] if empty else "work/ngspice.log",
                                "message": "{}: {} of {} sweep points have no value".format(c, len(empty), len(rows))})
            for side in ("min", "max"):
                measurements["{}.{}".format(c, side)] = {"value": None, "unit": unit, "status": "failed",
                                                         "source": sources[empty[0]] if empty else None, "at": None}
            continue
        for side, pick in (("min", min), ("max", max)):
            i = pick(range(len(rows)), key=lambda k: rows[k][c])
            measurements["{}.{}".format(c, side)] = {"value": rows[i][c], "unit": unit, "status": "measured",
                                                     "source": sources[i], "at": {sweep: rows[i][sweep]}}
    return measurements, diagnostics


def parse_log(lines, wanted):
    """Return (measurements, diagnostics) from ngspice output lines, with the sweep measurements of ROW lines."""
    found = {}
    counts = {}
    failed = {}
    diagnostics = []
    for number, line in enumerate(lines, 1):
        source = "work/ngspice.log:{}".format(number)
        m = VALUE_LINE.match(line)
        if m:
            name = m.group(1)
            found[name] = (float(m.group(2)), source)
            counts[name] = counts.get(name, 0) + 1
            continue
        m = MEAS_FAILED.match(line) or MEAS_ERROR.match(line)
        if m:
            failed[m.group(1)] = (line.strip(), source)
        m = DIAG_LINE.match(line)
        if m and len(diagnostics) < MAX_DIAGNOSTICS:
            diagnostics.append({"severity": m.group(1).lower(), "message": line.strip(), "source": source})

    table, sources = parse_rows(lines)
    columns = table["columns"] if table else []
    names = list(wanted.keys()) if wanted else sorted(found.keys())
    measurements = {}
    for name in names:
        # A wanted ROW column is reported as <name>.min and <name>.max (below), not as a missing scalar.
        if name in columns and name not in found and name not in failed:
            continue
        unit = wanted.get(name) if wanted else None
        if name in found:
            value, source = found[name]
            measurements[name] = {"value": value, "unit": unit, "status": "measured", "source": source}
            if counts[name] > 1:
                diagnostics.append({"severity": "warning", "source": source,
                                    "message": "{} appears {} times in the output; the last value is used".format(
                                        name, counts[name])})
        elif name in failed:
            measurements[name] = {"value": None, "unit": unit, "status": "failed", "source": failed[name][1]}
        else:
            measurements[name] = {"value": None, "unit": unit, "status": "missing"}
    if table:
        sweep, sweep_diagnostics = sweep_measurements(table, sources, wanted)
        measurements.update(sweep)
        diagnostics.extend(sweep_diagnostics)
    return measurements, diagnostics


def ngspice_version():
    try:
        out = subprocess.check_output(["ngspice", "--version"], stderr=subprocess.STDOUT, universal_newlines=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"ngspice-(\S+)", out)
    return m.group(1) if m else None


def pdk_facts():
    pdk_root, pdk = os.environ.get("PDK_ROOT"), os.environ.get("PDK")
    facts = {"PDK_ROOT": pdk_root, "PDK": pdk, "commit": None}
    if pdk_root and pdk:
        commit_file = os.path.join(pdk_root, pdk, "COMMIT")
        if os.path.isfile(commit_file):
            with open(commit_file) as f:
                facts["commit"] = f.read().strip()
    return facts


def deck_and_libs(root, inputs):
    """(deck path, [(lib path, section)], None), or (None, None, error message)."""
    deck = inputs.get("deck")
    if not isinstance(deck, str):
        return None, None, "input 'deck' is required (path of the testbench, relative to the design root)"
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


def spice_value(value):
    return repr(value) if isinstance(value, float) else str(value)


def condition_lines(inputs):
    """(the .param and .temp lines of the inputs params and temp_c, None), or (None, error message)."""
    params, temp_c = inputs.get("params"), inputs.get("temp_c")
    lines = []
    if params is not None:
        if not isinstance(params, dict):
            return None, "input 'params' must be an object {name: number or string}"
        for name in sorted(params):
            value = params[name]
            number = isinstance(value, (int, float)) and not isinstance(value, bool)
            if not PARAM_NAME.match(name):
                return None, "input 'params': '{}' is not a parameter name".format(name)
            if not (number and math.isfinite(value)) and not (isinstance(value, str) and value.strip()
                                                               and "\n" not in value and "\r" not in value):
                return None, "input 'params': the value of '{}' must be a finite number or a one-line string".format(name)
            lines.append(".param {}={}".format(name, spice_value(value)))
    if temp_c is not None:
        if isinstance(temp_c, bool) or not isinstance(temp_c, (int, float)) or not math.isfinite(temp_c):
            return None, "input 'temp_c' must be a finite number (degrees Celsius)"
        lines.append(".temp {}".format(spice_value(temp_c)))
    return lines, None


def simulate(request):
    root = request["root"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": ngspice_version(), "pdk": pdk_facts()}
    deck_path, libs, error = deck_and_libs(root, inputs)
    if error:
        return failure(tool, error)
    settings, error = condition_lines(inputs)
    if error:
        return failure(tool, error)
    top = os.path.join(request["work_dir"], "top.cir")
    with open(top, "w") as f:
        f.write("* simra ngspice adapter: top level for experiment {}\n".format(request.get("experiment")))
        for path, section in libs:
            f.write('.lib "{}"{}\n'.format(path, " " + section if section else ""))
        f.write('.include "{}"\n'.format(os.path.realpath(deck_path)))
        # After the include: ngspice uses the last .param and .temp line, so these replace the deck's values.
        for line in settings:
            f.write(line + "\n")
        f.write(".end\n")
    return run(request, tool, "top.cir", deck_path, libs, inputs.get("measurements") or {})


def run(request, tool, top_name, deck_path, libs, wanted, extra_inputs=()):
    """Hash the inputs, run ngspice on work_dir/top_name, and parse its output. Returns the response.

    wanted is the map of measurements as for simulate, or None for no "name = value" measurements."""
    root = request["root"]
    work_dir = request["work_dir"]
    diagnostics = []
    spiceinit = find_spiceinit(work_dir)
    closure = Closure(root, sourcepath(spiceinit) if spiceinit else ())
    closure.add_netlist(deck_path, "deck", "include")
    for path, role in extra_inputs:
        closure.add(path, role)
    for path, _ in libs:
        closure.add_netlist(path, "model", "model")
    if spiceinit:
        add_spiceinit(closure, spiceinit)
    for item in closure.missing:
        diagnostics.append({"severity": "warning", "message": "not hashed, file not found: " + item, "source": "adapter"})
    diagnostics.extend(lint_netlist(deck_path, root))
    if spiceinit:
        with open(spiceinit, errors="replace") as f:
            diagnostics.extend(lint_lines(f.read().splitlines(), display_path(spiceinit, root)))

    log_path = os.path.join(work_dir, "ngspice.log")
    with open(log_path, "w") as log:
        try:
            # ngspice looks for an include file in the directory of the including file and in the current
            # directory (work_dir). NGSPICE_INPUT_DIR adds the design root, as in Closure.resolve.
            env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
            code = subprocess.call(["ngspice", "-b", top_name], cwd=work_dir, env=env, stdout=log,
                                   stderr=subprocess.STDOUT)
        except OSError as e:
            return failure(tool, "could not start ngspice: {}".format(e))
    with open(log_path, errors="replace") as f:
        log_lines = f.read().splitlines()
    measurements, log_diagnostics = parse_log(log_lines, wanted or {})
    if wanted is None:
        measurements = {}
    table, _ = parse_rows(log_lines)
    if table:
        with open(os.path.join(work_dir, "sweep.json"), "w") as f:
            json.dump(table, f, indent=2)
            f.write("\n")
    diagnostics.extend(log_diagnostics)
    if code != 0:
        diagnostics.insert(0, {"severity": "error", "message": "ngspice exited with code {}".format(code), "source": "adapter"})

    outputs = []
    for name in sorted(os.listdir(work_dir)):
        path = os.path.join(work_dir, name)
        if os.path.isfile(path):
            outputs.append({"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path)})

    return {
        "contract": CONTRACT,
        "status": "completed" if code == 0 else "failed",
        "tool": tool,
        "input_files": {"files": closure.files, "complete": not closure.missing},
        "outputs": outputs,
        "measurements": measurements,
        "diagnostics": diagnostics,
    }


# Lines of a deck that operating_point removes: analyses, measurements, output requests and the end line.
ANALYSIS_LINE = re.compile(r"^\s*\.(ac|dc|tran|op|noise|tf|pz|sens|disto|sp|pss|meas|measure|print|plot|probe|save|four|end)\b",
                           re.IGNORECASE)
CONTROL_START = re.compile(r"^\s*\.control\b", re.IGNORECASE)
CONTROL_END = re.compile(r"^\s*\.endc\b", re.IGNORECASE)
OP_QUANTITIES = ("vgs", "vth", "vds", "vdsat", "id", "gm", "gds")


def technology_dir():
    return os.environ.get("SIMRA_TECHNOLOGY_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))), "technologies")


def find_technology(name, pdk, section="operating_point"):
    """(path, pack, None) for the pack with this name, or else the pack for this PDK; or (None, None, message).
    The pack must have ngspice.<section>."""
    base = technology_dir()
    packs = []
    for entry in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        path = os.path.join(base, entry, "technology.json")
        if os.path.isfile(path):
            with open(path) as f:
                packs.append((path, json.load(f)))
    for path, pack in packs:
        if (name and pack.get("name") == name) or (not name and pdk in (pack.get("pdks") or [])):
            if section not in (pack.get("ngspice") or {}):
                return None, None, "technology pack {} has no ngspice.{}".format(pack.get("name"), section)
            return path, pack, None
    known = ", ".join("{} ({})".format(p.get("name"), ", ".join(p.get("pdks") or [])) for _, p in packs) or "none"
    wanted = "technology pack '{}'".format(name) if name else "technology pack for PDK '{}'".format(pdk)
    return None, None, "no {} in {}; known packs: {}. Give input 'technology', or add a pack (see technologies/README.md)".format(
        wanted, base, known)


def circuit_lines(deck_path):
    """The deck lines without .control blocks and analyses. Relative include paths become absolute."""
    base = os.path.dirname(os.path.realpath(deck_path))
    lines, in_control = [], False
    with open(deck_path, errors="replace") as f:
        for line in f.read().splitlines():
            if in_control:
                in_control = not CONTROL_END.match(line)
                continue
            if CONTROL_START.match(line):
                in_control = True
                continue
            if ANALYSIS_LINE.match(line):
                continue
            m = INCLUDE_LINE.match(line)
            words = split_args(m.group(2)) if m else []
            if words and not (m.group(1).lower() == "lib" and len(words) < 2):
                name = os.path.expandvars(words[0])
                if not os.path.isabs(name) and os.path.isfile(os.path.join(base, name)):
                    rest = " ".join(words[1:])
                    line = '.{} "{}"{}'.format(m.group(1), os.path.join(base, name), " " + rest if rest else "")
            lines.append(line)
    return lines


def parse_show(lines, letter, params):
    """The devices of an ngspice "show" table: [{"device", "instance", "values": {quantity: value}}], warnings.

    The "device" row has the instance names and the "model" row has "<path>:<model>" for each column. ngspice
    shortens the names to about 21 characters, so the path comes from the model row when it has a ":".
    """
    by_name = {v: k for k, v in params.items()}
    devices, warnings = [], []
    columns = []
    for line in lines:
        words = line.split()
        if not words:
            continue
        if words[0] == "device" and all(w.lower().startswith(letter + ".") for w in words[1:]) and len(words) > 1:
            columns = [{"instance": w, "values": {}} for w in words[1:]]
            devices.extend(columns)
        elif words[0] == "model" and columns and len(words) == len(columns) + 1:
            for c, w in zip(columns, words[1:]):
                c["path"] = w.split(":")[0] if ":" in w else None
        elif columns and words[0] in by_name and len(words) == len(columns) + 1:
            for c, w in zip(columns, words[1:]):
                try:
                    c["values"][by_name[words[0]]] = float(w)
                except ValueError:
                    c["values"][by_name[words[0]]] = None
    for c in devices:
        c["device"] = c.pop("path", None) or c["instance"]
        if c["device"] == c["instance"]:
            warnings.append("{}: the device name may be shortened by ngspice".format(c["instance"]))
    return devices, warnings


def classify(values):
    """vov, sat_margin and the region of one device from its operating point. PMOS values may be negative."""
    vgs, vth, vds, vdsat = (values.get(k) for k in ("vgs", "vth", "vds", "vdsat"))
    if None in (vgs, vth, vds, vdsat):
        return None, None, None
    vov = abs(vgs) - abs(vth)
    margin = abs(vds) - abs(vdsat)
    region = "subthreshold" if vov < 0 else "triode" if margin < 0 else "saturation"
    return vov, margin, region


def operating_point(request):
    root = request["root"]
    work_dir = request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": ngspice_version(), "pdk": pdk_facts()}
    deck_path, libs, error = deck_and_libs(root, inputs)
    if error:
        return failure(tool, error)
    pack_path, pack, error = find_technology(inputs.get("technology"), os.environ.get("PDK"))
    if error:
        return failure(tool, error)
    op = pack["ngspice"]["operating_point"]
    letter, params = op["device_letter"].lower(), op["params"]
    missing = [q for q in OP_QUANTITIES if q not in params]
    if missing:
        return failure(tool, "technology pack {}: no parameter name for {}".format(pack["name"], ", ".join(missing)))
    tool["technology"] = pack["name"]

    with open(os.path.join(work_dir, "op.cir"), "w") as f:
        f.write("* simra ngspice adapter: operating point for experiment {}\n".format(request.get("experiment")))
        for path, section in libs:
            f.write('.lib "{}"{}\n'.format(path, " " + section if section else ""))
        f.write("\n".join(circuit_lines(deck_path)))
        f.write("\n.control\nop\nset width=10000\nshow {} : {}\n.endc\n.end\n".format(
            letter, " ".join(params[q] for q in OP_QUANTITIES)))
    response = run(request, tool, "op.cir", deck_path, libs, None, [(pack_path, "technology")])
    with open(os.path.join(work_dir, "ngspice.log"), errors="replace") as f:
        devices, warnings = parse_show(f.read().splitlines(), letter, params)
    if response["status"] == "completed" and not devices:
        response["status"] = "failed"
        response["diagnostics"].insert(0, {"severity": "error", "source": "work/ngspice.log", "message": (
            "no MOS devices in the 'show {}' output. Make sure the deck has the circuit and the testbench "
            "(not only a subcircuit), and that technology pack {} is correct for the models").format(letter, pack["name"])})
    for w in warnings:
        response["diagnostics"].append({"severity": "warning", "message": w, "source": "work/ngspice.log"})
    units = {"vgs": "V", "vth": "V", "vds": "V", "vdsat": "V", "id": "A", "gm": "S", "gds": "S", "vov": "V", "sat_margin": "V"}
    table = []
    for d in devices:
        v = d["values"]
        v["vov"], v["sat_margin"], region = classify(v)
        table.append({"device": d["device"], "region": region, "values": v})
        for q, value in v.items():
            response["measurements"]["{}.{}".format(d["device"], q)] = {
                "value": value, "unit": units[q], "status": "measured" if value is not None else "missing",
                "source": "work/ngspice.log"}
        if region and region != "saturation":
            response["diagnostics"].append({"severity": "warning", "source": "work/ngspice.log", "message": (
                "{} is in {}: vov = {:.3f} V, vds = {:.3f} V, vdsat = {:.3f} V, margin = {:.3f} V").format(
                    d["device"], region, v["vov"], abs(v["vds"]), abs(v["vdsat"]), v["sat_margin"])})
    path = os.path.join(work_dir, "operating_point.json")
    with open(path, "w") as f:
        json.dump({"technology": pack["name"], "devices": table}, f, indent=2)
        f.write("\n")
    response["outputs"].append({"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path)})
    return response


def lint(request):
    root = request["root"]
    files = (request.get("inputs") or {}).get("files")
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        return failure(None, "input 'files' is required (list of netlist paths, relative to the design root)")
    diagnostics = []
    for name in files:
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            diagnostics.append({"severity": "error", "message": "file not found: " + name, "source": "adapter"})
            continue
        diagnostics.extend(lint_netlist(path, root))
    return {"contract": CONTRACT, "status": "completed", "tool": None, "input_files": None, "outputs": [],
            "measurements": {}, "diagnostics": diagnostics}


# Operation check_design: the design contract (the "design" section of requirements.json) and the design lint.
DESIGN_KINDS = ("mos", "r", "c")
DESIGN_LIMITS = ("gate_area_um2", "r_ohm", "c_f")
PLAIN_NUMBER = re.compile(r"^(" + NUMBER + r")(meg|[tgkmunpf])?$", re.IGNORECASE)
GROUND_NODES = ("0", "gnd")
ELEMENT_KINDS = {"v": "a voltage source", "i": "a current source", "e": "a controlled source (E)",
                 "f": "a controlled source (F)", "g": "a controlled source (G)", "h": "a controlled source (H)",
                 "b": "a behavioural source (B)", "m": "a MOS model instance (M)", "d": "a diode", "q": "a bipolar transistor",
                 "j": "a JFET", "l": "an inductor", "k": "a coupling (K)", "s": "a switch (S)", "w": "a switch (W)",
                 "t": "a transmission line", "a": "an XSPICE code model (A)", "n": "an OSDI device (N)"}
PASSIVES = {"r": ("an ideal resistor", "r_ohm", "Ω"), "c": ("an ideal capacitor", "c_f", "F")}


def plain_number(text):
    """A plain SPICE number with an optional scale suffix (4u, 0.5, 1meg), or None. No unit letters, no expressions."""
    m = PLAIN_NUMBER.match(text)
    if not m:
        return None
    value = float(m.group(1)) * SCALE.get((m.group(2) or "").lower(), 1)
    return value if math.isfinite(value) else None


def logical_lines(text):
    """[(line number, text)]: the netlist lines without comments, with each "+" line joined to the line before it."""
    out = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line.startswith("*"):
            continue
        line = re.split(r"[;$]", line, 1)[0].strip()
        if not line:
            continue
        if line.startswith("+") and out:
            out[-1] = (out[-1][0], out[-1][1] + " " + line[1:].strip())
        else:
            out.append((number, line))
    return out


def design_tokens(line):
    """The fields of a line; "k = v" becomes one field "k=v"."""
    return re.sub(r"\s*=\s*", "=", line).split()


def parse_blocks(lines):
    """({name: block}, [(line, message)]): the .subckt blocks of a netlist and the errors of the lines outside them."""
    blocks, errors, stack = {}, [], []
    for number, line in lines:
        t = design_tokens(line)
        head = t[0].lower()
        if head == ".subckt":
            if len(t) < 2:
                errors.append((number, ".subckt without a name"))
                continue
            pins = [p for p in t[2:] if "=" not in p and p.lower() != "params:"]
            block = {"name": t[1], "pins": pins, "line": number, "lines": [], "children": []}
            if len(pins) != len(t) - 2:
                errors.append((number, ".subckt {} has parameters; a block of the design takes no parameters".format(t[1])))
            if t[1].lower() in blocks:
                errors.append((number, ".subckt {} is defined more than once".format(t[1])))
            if stack:
                errors.append((number, ".subckt {} is inside .subckt {}; define each block on its own".format(
                    t[1], stack[-1]["name"])))
            blocks.setdefault(t[1].lower(), block)
            stack.append(block)
        elif head == ".ends":
            if not stack:
                errors.append((number, ".ends without .subckt"))
                continue
            block = stack.pop()
            if len(t) > 1 and t[1].lower() != block["name"].lower():
                errors.append((number, "'{}' closes .subckt {}".format(line, block["name"])))
        elif stack:
            stack[-1]["lines"].append((number, line, t))
        elif head != ".end":
            errors.append((number, "'{}' is outside a .subckt block; outside a block, only .end is allowed".format(line)))
    for block in stack:
        errors.append((block["line"], ".subckt {} has no .ends".format(block["name"])))
    return blocks, errors


def lint_device(name, nodes, params, model, device, size_unit):
    """(errors, values {param: number}, gate area in µm² or None) of one instance of a technology pack device."""
    errors, values = [], {}
    spec = device.get("params") or {}
    terminals = device.get("terminals") or []
    if len(nodes) != len(terminals):
        errors.append("{}: {} nodes; {} has {} terminals ({})".format(
            name, len(nodes), model, len(terminals), " ".join(terminals)))
    given = set()
    for p in params:
        key, _, text = p.partition("=")
        key = key.lower()
        if key not in spec:
            errors.append("{}: {} is not a parameter of {}; its parameters are {}".format(
                name, key, model, ", ".join(sorted(spec))))
            continue
        if key in given:
            errors.append("{}: {} is given more than once".format(name, key))
            continue
        given.add(key)
        value = plain_number(text)
        if value is None:
            errors.append("{}: {}={} is not a plain number (give a number with an optional scale suffix such as "
                          "u, n, p, k or meg)".format(name, key, text))
        else:
            values[key] = value
    for key, s in sorted(spec.items()):
        if s.get("required") and key not in given:
            errors.append("{}: {} is required for {}".format(name, key, model))
    roles = {s.get("role"): key for key, s in spec.items() if s.get("role")}
    fingers = values.get(roles.get("fingers"), 1)
    for key, value in sorted(values.items()):
        s = spec[key]
        if s.get("integer"):
            if value != int(value):
                errors.append("{}: {}={:g} is not an integer".format(name, key, value))
            elif "min" in s and value < s["min"]:
                errors.append("{}: {}={:g} is below the minimum {:g} of {}".format(name, key, value, s["min"], model))
        elif s.get("size"):
            metres = value * size_unit
            per = metres / fingers if s.get("per_finger") and fingers > 0 else metres
            if metres <= 0:
                errors.append("{}: {}={:g} is not a positive size".format(name, key, value))
            elif "min" in s and per < s["min"] * (1 - 1e-9):
                errors.append("{}: {} is {:g} µm{}, below the minimum {:g} µm of {}".format(
                    name, key, per * 1e6, " per finger" if per != metres else "", s["min"] * 1e6, model))
    width, length = values.get(roles.get("width")), values.get(roles.get("length"))
    if width is None or length is None:
        return errors, values, None
    factor = values.get(roles.get("multiplier"), 1) * (1 if device.get("width_total") else fingers)
    return errors, values, width * size_unit * 1e6 * length * size_unit * 1e6 * factor


def lint_block(block, blocks, devices, allowed, elements, limits, size_unit):
    """[(line, message)] of the lines of one block; the elements and the gate area of its devices go to the block.
    allowed: the device names of the design contract, or None for every device of the pack."""
    errors, names = [], set()
    block["elements"], block["mos_count"], block["area"] = [], 0, 0.0
    for number, line, t in block["lines"]:
        name, letter = t[0], t[0][0].lower()
        if any(c in line for c in "{}'\""):
            errors.append((number, "'{}': an expression or a quoted value is not allowed in the design; give "
                                   "plain numbers".format(line)))
            continue
        if letter == ".":
            errors.append((number, "'{}': {} is not allowed in the design".format(line, t[0])))
            continue
        if name.lower() in names:
            errors.append((number, "{} is defined more than once in .subckt {}".format(name, block["name"])))
        names.add(name.lower())
        if letter in PASSIVES:
            what, limit_name, unit = PASSIVES[letter]
            if letter not in elements:
                errors.append((number, "{}: {} is not allowed by design.elements ({})".format(name, what, ", ".join(elements))))
                continue
            if len(t) != 4:
                errors.append((number, "{}: {} has exactly 4 fields: {}name n1 n2 value".format(name, what, letter.upper())))
                continue
            value = plain_number(t[3])
            if value is None or value <= 0:
                errors.append((number, "{}: the value {} is not a positive plain number".format(name, t[3])))
                continue
            limit = limits.get(limit_name)
            if limit is not None and value > limit * (1 + 1e-9):
                errors.append((number, "{}: {} is above the limit {} (limits.{})".format(
                    name, si(value, unit), si(limit, unit), limit_name)))
            nodes, kind, model, values = t[1:3], letter, None, {"value": value}
        elif letter == "x":
            first = next((i for i, w in enumerate(t) if "=" in w), len(t))
            positional, params = t[:first], t[first:]
            if len(positional) < 3 or any("=" not in p for p in params):
                errors.append((number, "'{}': give X<name> <nodes> <model> [k=v ...]".format(line)))
                continue
            nodes, model = positional[1:-1], positional[-1]
            device = devices.get(model.lower())
            if device is not None:
                if "mos" not in elements:
                    errors.append((number, "{}: MOS devices are not allowed by design.elements ({})".format(
                        name, ", ".join(elements))))
                    continue
                if allowed is not None and model.lower() not in [a.lower() for a in allowed]:
                    errors.append((number, "{}: {} is not in the devices of the design contract ({})".format(
                        name, model, ", ".join(allowed))))
                    continue
                messages, values, area = lint_device(name, nodes, params, model, device, size_unit)
                errors.extend((number, m) for m in messages)
                kind = "mos"
                block["mos_count"] += 1
                block["area"] = None if area is None or block["area"] is None else block["area"] + area
            elif model.lower() in blocks:
                child = blocks[model.lower()]
                if params:
                    errors.append((number, "{}: an instance of .subckt {} takes no parameters".format(name, child["name"])))
                if len(nodes) != len(child["pins"]):
                    errors.append((number, "{}: {} nodes; .subckt {} has {} pins".format(
                        name, len(nodes), child["name"], len(child["pins"]))))
                block["children"].append((number, child["name"].lower()))
                kind, values = "x", {}
            else:
                errors.append((number, "{}: {} is not a device of the technology pack or a .subckt of this file".format(
                    name, model)))
                continue
        else:
            what = ELEMENT_KINDS.get(letter, "element kind {}".format(letter.upper()))
            errors.append((number, "{}: {} is not allowed in the design; use only {}".format(
                name, what, ", ".join({"mos": "MOS devices of the technology pack (X)", "r": "ideal resistors (R)",
                                        "c": "ideal capacitors (C)"}[k] for k in elements) or "nothing")))
            continue
        for node in nodes:
            if node.lower() in GROUND_NODES:
                errors.append((number, "{}: node {} is the global ground; connect the design only through its "
                                       "pins".format(name, node)))
        block["elements"].append({"block": block["name"], "name": name, "kind": kind,
                                  "model": model.lower() if model else None, "nodes": nodes, "params": values,
                                  "line": number})
    return errors


def expand(blocks, top):
    """(mos_count, gate area in µm² or None, [(line, message)]): the hierarchy of block top, expanded.
    A block that instantiates itself, directly or through other blocks, is an error."""
    errors, memo, visiting = [], {}, []

    def visit(name):
        if name in memo:
            return memo[name]
        visiting.append(name)
        block = blocks[name]
        count, area = block["mos_count"], block["area"]
        for number, child in block["children"]:
            if child in visiting:
                path = visiting[visiting.index(child):] + [child]
                errors.append((number, ".subckt {} instantiates itself ({})".format(
                    blocks[child]["name"], " -> ".join(blocks[n]["name"] for n in path))))
                area = None
                continue
            c, a = visit(child)
            count += c
            area = None if area is None or a is None else area + a
        visiting.pop()
        memo[name] = (count, area)
        return memo[name]

    count, area = visit(top)
    for name in blocks:  # blocks that the top does not use are checked for loops too
        visit(name)
    return count, area, errors


def check_design(request):
    root = request["root"]
    work_dir = request["work_dir"]
    inputs = request.get("inputs") or {}
    name, subckt, pins = inputs.get("file"), inputs.get("subckt"), inputs.get("pins")
    elements = inputs.get("elements", list(DESIGN_KINDS))
    allowed = inputs.get("devices")
    limits = inputs.get("limits") or {}
    if not isinstance(name, str) or not name or os.path.isabs(name):
        return failure(None, "input 'file' is required (the design netlist, relative to the design root)")
    if not isinstance(subckt, str) or not subckt:
        return failure(None, "input 'subckt' is required (the name of the design subcircuit)")
    if not isinstance(pins, list) or not pins or not all(isinstance(p, str) and p for p in pins):
        return failure(None, "input 'pins' is required (the ordered pin names of the subcircuit)")
    if not isinstance(elements, list) or any(k not in DESIGN_KINDS for k in elements):
        return failure(None, "input 'elements' must be a list of {}".format(", ".join(DESIGN_KINDS)))
    if allowed is not None and (not isinstance(allowed, list) or not allowed
                                or not all(isinstance(d, str) and d for d in allowed)):
        return failure(None, "input 'devices' must be a list of device names of the technology pack")
    if not isinstance(limits, dict) or any(k not in DESIGN_LIMITS or isinstance(v, bool) or not isinstance(v, (int, float))
                                           or not v > 0 for k, v in limits.items()):
        return failure(None, "input 'limits' must be {{name: positive number}} with names {}".format(", ".join(DESIGN_LIMITS)))
    pack_path, pack, error = find_technology(inputs.get("technology"), os.environ.get("PDK"), "devices")
    if error:
        return failure(None, error)
    devices = {k.lower(): v for k, v in pack["ngspice"]["devices"].items()}
    size_unit = pack["ngspice"].get("size_unit_m", 1)
    unknown = [d for d in allowed or [] if d.lower() not in devices]
    if unknown:
        return failure(None, "input 'devices': {} {} not a device of technology pack {}; its devices are {}".format(
            ", ".join(unknown), "is" if len(unknown) == 1 else "are", pack["name"],
            ", ".join(pack["ngspice"]["devices"])))

    path = os.path.join(root, name)
    files = [{"path": display_path(pack_path, root), "sha256": sha256(pack_path),
              "bytes": os.path.getsize(pack_path), "role": "technology"}]
    errors, mos_count, area, all_elements = [], None, None, []
    if not os.path.isfile(path):
        errors.append((None, "design file not found: {}".format(name)))
    else:
        files.insert(0, {"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path),
                         "role": "design"})
        with open(path, errors="replace") as f:
            blocks, errors = parse_blocks(logical_lines(f.read()))
        for block in blocks.values():
            if block["name"].lower() in devices:
                errors.append((block["line"], ".subckt {} has the name of a device of technology pack {}".format(
                    block["name"], pack["name"])))
            errors.extend(lint_block(block, blocks, devices, allowed, elements, limits, size_unit))
            all_elements.extend(block["elements"])
        top = blocks.get(subckt.lower())
        if top is None:
            errors.append((None, "no .subckt {} in {}".format(subckt, name)))
        else:
            if [p.lower() for p in top["pins"]] != [p.lower() for p in pins]:
                errors.append((top["line"], ".subckt {} has the pins '{}'; the design contract gives '{}', in this "
                                            "order".format(top["name"], " ".join(top["pins"]), " ".join(pins))))
            mos_count, area, loops = expand(blocks, subckt.lower())
            errors.extend(loops)
            limit = limits.get("gate_area_um2")
            if area is not None:
                area = round(area, 9)
                if limit is not None and area > limit * (1 + 1e-9):
                    errors.append((top["line"], "the gate area (W x L x m of all MOS devices) is {:g} µm², above the "
                                                "limit {:g} µm² (limits.gate_area_um2)".format(area, limit)))
    errors.sort(key=lambda e: e[0] or 0)
    diagnostics = [{"severity": "error", "message": m, "source": "{}:{}".format(name, n) if n else name}
                   for n, m in errors]
    source = "work/design.json"
    measurements = {
        "gate_area_um2": {"value": area, "unit": "um2", "status": "measured" if area is not None else "failed",
                          "source": source},
        "mos_count": {"value": mos_count, "unit": None, "status": "measured" if mos_count is not None else "failed",
                      "source": source},
        "design_errors": {"value": len(errors), "unit": None, "status": "measured", "source": source},
    }
    out = os.path.join(work_dir, "design.json")
    with open(out, "w") as f:
        json.dump({"file": name, "subckt": subckt, "pins": pins, "elements_allowed": elements, "devices": allowed,
                   "limits": limits,
                   "technology": pack["name"], "errors": [{"message": d["message"], "source": d["source"]}
                                                          for d in diagnostics],
                   "elements": all_elements, "measurements": {k: v["value"] for k, v in measurements.items()}},
                  f, indent=2, ensure_ascii=False)
        f.write("\n")
    return {"contract": CONTRACT, "status": "completed", "tool": None,
            "input_files": {"files": files, "complete": os.path.isfile(path)},
            "outputs": [{"path": display_path(out, root), "sha256": sha256(out), "bytes": os.path.getsize(out)}],
            "measurements": measurements, "diagnostics": diagnostics}


def failure(tool, message):
    return {"contract": CONTRACT, "status": "failed", "tool": tool, "input_files": None, "outputs": [],
            "measurements": {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: ngspice_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    operation = {"simulate": simulate, "operating_point": operating_point, "lint": lint,
                 "check_design": check_design}.get(request.get("operation"))
    if operation is None:
        response = failure(None, "unknown operation: {}".format(request.get("operation")))
    else:
        response = operation(request)
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=2)
        f.write("\n")
    os.rename(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
