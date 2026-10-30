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
"""

import hashlib
import json
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
    rel = os.path.relpath(path, root)
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


def parse_log(lines, wanted):
    """Return (measurements, diagnostics) from ngspice output lines."""
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

    names = list(wanted.keys()) if wanted else sorted(found.keys())
    measurements = {}
    for name in names:
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


def simulate(request):
    root = request["root"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": ngspice_version(), "pdk": pdk_facts()}
    deck_path, libs, error = deck_and_libs(root, inputs)
    if error:
        return failure(tool, error)
    top = os.path.join(request["work_dir"], "top.cir")
    with open(top, "w") as f:
        f.write("* simra ngspice adapter: top level for experiment {}\n".format(request.get("experiment")))
        for path, section in libs:
            f.write('.lib "{}"{}\n'.format(path, " " + section if section else ""))
        f.write('.include "{}"\n.end\n'.format(os.path.realpath(deck_path)))
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
        measurements, log_diagnostics = parse_log(f.read().splitlines(), wanted or {})
    if wanted is None:
        measurements = {}
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


def find_technology(name, pdk):
    """(path, pack, None) for the pack with this name, or else the pack for this PDK; or (None, None, message)."""
    base = technology_dir()
    packs = []
    for entry in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        path = os.path.join(base, entry, "technology.json")
        if os.path.isfile(path):
            with open(path) as f:
                packs.append((path, json.load(f)))
    for path, pack in packs:
        if (name and pack.get("name") == name) or (not name and pdk in (pack.get("pdks") or [])):
            if "operating_point" not in (pack.get("ngspice") or {}):
                return None, None, "technology pack {} has no ngspice.operating_point".format(pack.get("name"))
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
    operation = {"simulate": simulate, "operating_point": operating_point, "lint": lint}.get(request.get("operation"))
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
