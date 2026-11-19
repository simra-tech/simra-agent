"""Operation probe_devices of the ngspice adapter: one small DC deck per device class of a technology pack.

Inputs:
  pdk           the PDK (default $PDK); the pack is the one whose "pdks" has it and that has device_probe.<pdk>
  technology    optional, the name of the pack
  classes       optional list of class names (default: every class of the pack)
  timeout_s     optional, the wall time of one class (default 60)

For each class the adapter writes work/probe/<class>.cir (the library of the class for ngspice, the netlist lines of
the pack, then "op" and "print i(vprobe)"), runs ngspice -b, and gives one row:
  simulates     the operating point converged and the DC current of vprobe is a finite number (the probe value)
  parses        ngspice read the netlist, but the operating point gave no value; the reason is the first error
  fails         ngspice did not read the netlist (unknown subcircuit, model or line); the reason is the first error
  not run       the class did not end in timeout_s, or ngspice did not start
Warnings of ngspice about a model (for example an unrecognized parameter that it ignores) are listed per row.
work/probe.json (role probe) has the rows; the measurements count the rows per status.
"""

import json
import math
import os
import re
import subprocess

import ngspice_adapter as base

VALUE = re.compile(r"^\s*i\(vprobe\)\s*=\s*(" + base.NUMBER + r")\s*$", re.IGNORECASE)
# ngspice did not read the netlist. ("no simulations run" is not one: ngspice prints it also after a failed analysis.)
PARSE_ERRORS = re.compile(r"Simulation interrupted due to error|unknown subckt|could not find a valid modelname|Error on line|"
                          r"unknown model type", re.IGNORECASE)
# The line that names the cause of a parse failure.
CAUSES = re.compile(r"unknown subckt|could not find a valid modelname|unknown model type", re.IGNORECASE)
ERROR = re.compile(r"^\s*(error\b.*|doAnalyses:.*|.*simulation\(s\) aborted.*)$", re.IGNORECASE)
MODEL_WARNING = re.compile(r"unrecognized parameter|Model issue|ignored", re.IGNORECASE)
STATUSES = ("simulates", "parses", "fails", "not run")


def find_probe(inputs):
    """(pack path, pack name, pdk, section, None) or (None, None, None, None, message)."""
    pdk = inputs.get("pdk") or os.environ.get("PDK")
    if not pdk:
        return None, None, None, None, "input 'pdk' is required (or set $PDK)"
    name = inputs.get("technology")
    packs = base.read_packs(base.technology_dirs())
    for path, pack in packs:
        if name and pack.get("name") != name:
            continue
        section = (pack.get("device_probe") or {}).get(pdk)
        if pdk in (pack.get("pdks") or []) and section:
            return path, pack.get("name"), pdk, section, None
    return None, None, None, None, "no technology pack with device_probe.{} (see technologies/README.md)".format(pdk)


def classify(lines):
    """(status, value, reason, warnings) from the ngspice output of one probe deck."""
    # The title line ("Circuit: * <title>") is text of the deck, not a message of ngspice.
    lines = [l for l in lines if not l.lstrip().startswith("Circuit:")]
    warnings = [l.strip() for l in lines if MODEL_WARNING.search(l)][:5]
    for line in lines:
        m = VALUE.match(line)
        if m:
            value = float(m.group(1))
            if math.isfinite(value):
                return "simulates", value, None, warnings
    if any(PARSE_ERRORS.search(l) for l in lines):
        cause = next((l.strip() for l in lines if CAUSES.search(l)), None)
        where = next((l.strip().rstrip(":") for l in lines if re.match(r"^\s*Error on line", l, re.I)), None)
        if cause and where and where != cause:
            return "fails", None, "{} ({})".format(cause, where), warnings
        return "fails", None, cause or where or next(l.strip() for l in lines if PARSE_ERRORS.search(l)), warnings
    errors = [l.strip() for l in lines if ERROR.match(l)]
    return "parses", None, errors[0] if errors else "no value of i(vprobe) in the output", warnings


def probe_devices(request):
    root, work_dir = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": base.ngspice_version(), "pdk": base.pdk_facts()}
    pack_path, pack_name, pdk, section, error = find_probe(inputs)
    if error:
        return base.failure(tool, error)
    classes = section.get("classes") or {}
    wanted = inputs.get("classes") or list(classes)
    unknown = [c for c in wanted if c not in classes]
    if unknown:
        return base.failure(tool, "unknown device classes: {}; the pack has {}".format(", ".join(unknown), ", ".join(classes)))
    timeout = float(inputs.get("timeout_s", 60))
    pdk_root = os.environ.get("PDK_ROOT", "")
    probe_dir = os.path.join(work_dir, "probe")
    os.makedirs(probe_dir, exist_ok=True)
    closure = base.Closure(root, ())
    closure.add(pack_path, "technology")
    spiceinit = base.find_spiceinit(probe_dir)
    if spiceinit:
        base.add_spiceinit(closure, spiceinit)
    rows, diagnostics = [], []
    for name in wanted:
        cls = classes[name]
        lib = (section.get("libs", {}).get(cls.get("lib")) or {}).get("ngspice")
        row = {"class": name, "simulator": "ngspice", "description": cls.get("description"), "status": "fails", "value_a": None,
               "reason": None, "warnings": [], "deck": "work/probe/{}.cir".format(name), "log": "work/probe/{}.log".format(name)}
        rows.append(row)
        if not lib:
            row["reason"] = "the pack gives no ngspice library for {}".format(cls.get("lib"))
            continue
        lib_path = lib["path"].replace("{pdk_root}", pdk_root)
        if os.path.isfile(lib_path):
            closure.add_netlist(lib_path, "model", "model")
        deck = os.path.join(probe_dir, name + ".cir")
        with open(deck, "w") as f:
            f.write("* simra probe_devices: {} ({})\n".format(name, cls.get("description", "")))
            f.write('.lib "{}" {}\n'.format(lib_path, lib.get("section", "")))
            f.write("\n".join(cls.get("netlist", [])) + "\n")
            f.write(".control\nop\nprint i(vprobe)\n.endc\n.end\n")
        log = os.path.join(probe_dir, name + ".log")
        try:
            with open(log, "w") as out:
                subprocess.run(["ngspice", "-b", name + ".cir"], cwd=probe_dir, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
        except subprocess.TimeoutExpired:
            row.update(status="not run", reason="no result in {:g} s".format(timeout))
            continue
        except OSError as e:
            row.update(status="not run", reason="could not start ngspice: {}".format(e))
            continue
        with open(log, errors="replace") as f:
            status, value, reason, warnings = classify(f.read().splitlines())
        row.update(status=status, value_a=value, reason=reason, warnings=warnings)
    table = {"schema": "simra.device_probe/0", "simulator": "ngspice", "version": tool["version"], "pdk": pdk, "pack": pack_name, "rows": rows}
    with open(os.path.join(work_dir, "probe.json"), "w") as f:
        json.dump(table, f, indent=2)
        f.write("\n")
    measurements = {"classes_total": {"value": len(rows), "unit": None, "status": "measured"}}
    for s in STATUSES:
        measurements["classes_" + s.replace(" ", "_")] = {"value": sum(r["status"] == s for r in rows), "unit": None, "status": "measured"}
    for r in rows:
        if r["status"] != "simulates":
            diagnostics.append({"severity": "warning", "source": r["log"], "message": "{}: {}: {}".format(r["class"], r["status"], r["reason"])})
    report = ["{} {}: {}{}".format(r["class"], "ngspice", r["status"], " ({})".format(r["reason"]) if r["reason"] else
                                   " (I = {:.4g} A)".format(r["value_a"])) for r in rows]
    outputs = []
    for dirpath, _, names in os.walk(work_dir):
        for n in sorted(names):
            p = os.path.join(dirpath, n)
            e = {"path": base.display_path(p, root), "sha256": base.sha256(p), "bytes": os.path.getsize(p)}
            if p == os.path.join(work_dir, "probe.json"):
                e["role"] = "probe"
            outputs.append(e)
    return {"contract": base.CONTRACT, "status": "completed", "tool": tool,
            "input_files": {"files": closure.files, "complete": not closure.missing},
            "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics, "report": report}
