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
MAX_DIAGNOSTICS = 50


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

    def __init__(self, root):
        self.root = root
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
        for candidate in ([name] if os.path.isabs(name) else [os.path.join(base, name), os.path.join(self.root, name)]):
            if os.path.isfile(candidate):
                return candidate
        return None


def find_spiceinit(work_dir):
    """The .spiceinit that ngspice reads: the current directory first, then SPICE_USERINIT_DIR or HOME."""
    for d in (work_dir, os.environ.get("SPICE_USERINIT_DIR"), os.environ.get("HOME")):
        if d and os.path.isfile(os.path.join(d, ".spiceinit")):
            return os.path.join(d, ".spiceinit")
    return None


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


def simulate(request):
    root = request["root"]
    work_dir = request["work_dir"]
    inputs = request.get("inputs") or {}
    diagnostics = []
    tool = {"name": "ngspice", "version": ngspice_version(), "pdk": pdk_facts()}

    deck = inputs.get("deck")
    if not isinstance(deck, str):
        return failure(tool, "input 'deck' is required (path of the testbench, relative to the design root)")
    deck_path = os.path.join(root, deck)
    if not os.path.isfile(deck_path):
        return failure(tool, "deck not found: {}".format(deck))
    libs = []
    for lib in inputs.get("libs") or []:
        path = os.path.expandvars(lib.get("path", ""))
        if not os.path.isabs(path):
            path = os.path.join(root, path)
        if not os.path.isfile(path):
            return failure(tool, "library not found: {} (expanded: {})".format(lib.get("path"), path))
        libs.append((path, lib.get("section")))
    wanted = inputs.get("measurements") or {}

    top = os.path.join(work_dir, "top.cir")
    with open(top, "w") as f:
        f.write("* simra ngspice adapter: top level for experiment {}\n".format(request.get("experiment")))
        for path, section in libs:
            f.write('.lib "{}"{}\n'.format(path, " " + section if section else ""))
        f.write('.include "{}"\n.end\n'.format(os.path.realpath(deck_path)))

    closure = Closure(root)
    closure.add_netlist(deck_path, "deck", "include")
    for path, _ in libs:
        closure.add_netlist(path, "model", "model")
    spiceinit = find_spiceinit(work_dir)
    if spiceinit:
        add_spiceinit(closure, spiceinit)
    for item in closure.missing:
        diagnostics.append({"severity": "warning", "message": "not hashed, file not found: " + item, "source": "adapter"})

    log_path = os.path.join(work_dir, "ngspice.log")
    with open(log_path, "w") as log:
        try:
            code = subprocess.call(["ngspice", "-b", "top.cir"], cwd=work_dir, stdout=log, stderr=subprocess.STDOUT)
        except OSError as e:
            return failure(tool, "could not start ngspice: {}".format(e))
    with open(log_path, errors="replace") as f:
        measurements, log_diagnostics = parse_log(f.read().splitlines(), wanted)
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
    if request.get("operation") != "simulate":
        response = failure(None, "unknown operation: {}".format(request.get("operation")))
    else:
        response = simulate(request)
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=2)
        f.write("\n")
    os.rename(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
