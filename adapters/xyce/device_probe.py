"""Operation probe_devices of the xyce adapter: one small DC deck per device class of a technology pack.

Inputs:
  pdk           the PDK (default $PDK); the pack is the one whose "pdks" has it and that has device_probe.<pdk>
  technology    optional, the name of the pack
  classes       optional list of class names (default: every class of the pack)
  timeout_s     optional, the wall time of one Xyce run (default 60)

For each class the adapter writes work/probe/<class>.cir (the library of the class for Xyce, the netlist lines of the
pack, a one-point .dc of a dummy source and ".print dc format=csv i(vprobe)"). It runs "Xyce -norun" first, then the
analysis, and gives one row:
  simulates     the netlist parsed and the DC current of vprobe is a finite number (the probe value)
  parses        "Xyce -norun" has no error, but the analysis gave no value; the reason is the first error
  fails         "Xyce -norun" found an error (a model gap: an unrecognized parameter of a model card, a model or a
                subcircuit that the library does not define); the reason is the first error, with its file and line
  not run       a run did not end in timeout_s, or Xyce did not start
The fidelity warnings of Xyce (a model parameter that it ignores, a model version that it replaces) are listed per row.
work/probe.json (role probe) has the rows; the measurements count the rows per status.
"""

import csv
import json
import math
import os

import xyce_adapter as base

STATUSES = ("simulates", "parses", "fails", "not run")


def find_probe(inputs):
    """(pack path, pack name, pdk, section, None) or (None, None, None, None, message)."""
    pdk = inputs.get("pdk") or os.environ.get("PDK")
    if not pdk:
        return None, None, None, None, "input 'pdk' is required (or set $PDK)"
    dirs = [d for d in (os.environ.get("SIMRA_TECHNOLOGY_DIR") or "").split(":") if d] or [
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))), "technologies")]
    for base_dir in dirs:
        for entry in sorted(os.listdir(base_dir)) if os.path.isdir(base_dir) else []:
            path = os.path.join(base_dir, entry, "technology.json")
            if not os.path.isfile(path):
                continue
            with open(path) as f:
                pack = json.load(f)
            if inputs.get("technology") and pack.get("name") != inputs["technology"]:
                continue
            section = (pack.get("device_probe") or {}).get(pdk)
            if pdk in (pack.get("pdks") or []) and section:
                return path, pack.get("name"), pdk, section, None
    return None, None, None, None, "no technology pack with device_probe.{} (see technologies/README.md)".format(pdk)


def read_value(csv_path):
    """The probe current from the .print csv file, or None."""
    try:
        with open(csv_path) as f:
            rows = list(csv.reader(f))
    except OSError:
        return None
    if len(rows) < 2:
        return None
    header = [h.strip().upper() for h in rows[0]]
    if "I(VPROBE)" not in header:
        return None
    try:
        value = float(rows[1][header.index("I(VPROBE)")])
    except (ValueError, IndexError):
        return None
    return value if math.isfinite(value) else None


def classify(norun_lines, run_lines, value, root, probe_dir):
    """(status, reason, warnings, gaps) of one class from the logs of -norun and of the run (None: not run)."""
    found = base.findings(base.log_blocks(norun_lines), root, probe_dir)
    errors = [f for f in found if f["severity"] == "error"]
    warnings = [f["message"] for f in found if f["severity"] == "warning"][:5]
    gaps = sorted({f["class"] for f in errors})
    if errors:
        return "fails", "{} ({})".format(errors[0]["message"], errors[0]["source"]), warnings, gaps
    if value is not None:
        return "simulates", None, warnings, gaps
    lines = run_lines or []
    run_errors = [f for f in base.findings(base.log_blocks(lines), root, probe_dir) if f["severity"] == "error"]
    if run_errors:
        return "parses", "{} ({})".format(run_errors[0]["message"], run_errors[0]["source"]), warnings, gaps
    text = next((l.strip() for l in lines if "error" in l.lower() or "fail" in l.lower()), None)
    return "parses", text or "no value of I(VPROBE) in the output", warnings, gaps


def probe_devices(request):
    root, work_dir = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "Xyce", "version": base.xyce_version()}
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
    closure = base.Closure(root)
    closure.add(pack_path, "technology")
    rows, diagnostics, commands = [], [], []
    for name in wanted:
        cls = classes[name]
        lib = (section.get("libs", {}).get(cls.get("lib")) or {}).get("xyce")
        row = {"class": name, "simulator": "xyce", "description": cls.get("description"), "status": "fails", "value_a": None,
               "reason": None, "warnings": [], "gaps": [], "deck": "work/probe/{}.cir".format(name), "log": "work/probe/{}.log".format(name)}
        rows.append(row)
        if not lib:
            row["reason"] = "the pack gives no Xyce library for {}".format(cls.get("lib"))
            continue
        lib_path = lib["path"].replace("{pdk_root}", pdk_root)
        if os.path.isfile(lib_path):
            closure.add_netlist(lib_path, "model", "model")
        deck = os.path.join(probe_dir, name + ".cir")
        with open(deck, "w") as f:
            f.write("* simra probe_devices: {} ({})\n".format(name, cls.get("description", "")))
            f.write('.lib "{}" {}\n'.format(lib_path, lib.get("section", "")))
            f.write("\n".join(cls.get("netlist", [])) + "\n")
            f.write("vsimra_dummy simra_dummy 0 0\nrsimra_dummy simra_dummy 0 1k\n.dc vsimra_dummy 0 0 1\n.print dc format=csv file={}.csv i(vprobe)\n.end\n".format(name))
        norun_log = os.path.join(probe_dir, name + ".norun.log")
        code, state, cmds = base.run_xyce(["Xyce", "-norun", name + ".cir"], probe_dir, norun_log, timeout_s=timeout)
        commands.extend(cmds)
        if state != "completed":
            row.update(status="not run", reason="Xyce -norun: {}".format("no result in {:g} s".format(timeout) if state == "timeout" else state))
            continue
        with open(norun_log, errors="replace") as f:
            norun_lines = f.read().splitlines()
        run_lines, value = None, None
        if code == 0:
            log = os.path.join(probe_dir, name + ".log")
            code, state, cmds = base.run_xyce(["Xyce", name + ".cir"], probe_dir, log, timeout_s=timeout)
            commands.extend(cmds)
            if state != "completed":
                row.update(status="not run", reason="Xyce: {}".format("no result in {:g} s".format(timeout) if state == "timeout" else state))
                continue
            with open(log, errors="replace") as f:
                run_lines = f.read().splitlines()
            value = read_value(os.path.join(probe_dir, name + ".csv"))
        else:
            row["log"] = "work/probe/{}.norun.log".format(name)
        status, reason, warnings, gaps = classify(norun_lines, run_lines, value, root, probe_dir)
        row.update(status=status, value_a=value, reason=reason, warnings=warnings, gaps=gaps)
    table = {"schema": "simra.device_probe/0", "simulator": "xyce", "version": tool["version"], "pdk": pdk, "pack": pack_name, "rows": rows}
    with open(os.path.join(work_dir, "probe.json"), "w") as f:
        json.dump(table, f, indent=2)
        f.write("\n")
    measurements = {"classes_total": {"value": len(rows), "unit": None, "status": "measured"}}
    for s in STATUSES:
        measurements["classes_" + s.replace(" ", "_")] = {"value": sum(r["status"] == s for r in rows), "unit": None, "status": "measured"}
    for r in rows:
        if r["status"] != "simulates":
            diagnostics.append({"severity": "warning", "source": r["log"], "message": "{}: {}: {}".format(r["class"], r["status"], r["reason"])})
    report = ["{} xyce: {}{}".format(r["class"], r["status"], " ({})".format(r["reason"]) if r["reason"] else " (I = {:.4g} A)".format(r["value_a"]))
              for r in rows]
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
            "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics, "report": report, "commands": commands}
