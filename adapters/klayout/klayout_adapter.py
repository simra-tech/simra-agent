#!/usr/bin/env python3
"""KLayout adapter for Simra Agent (contract simra.adapter/0).

Usage: klayout_adapter.py <request.json>

The adapter runs the DRC and LVS decks of a PDK as subprocesses in the work directory, and gives a typed verdict
that it reconciles with the exit code of the deck, the deck log and the report file. The technology pack gives
every PDK fact: the deck command, the report path, the meaning of the exit code and the texts of the log (section
klayout.<pdk>, see technologies/README.md). The adapter finds the KLayout binary on PATH, or else in the variable
SIMRA_KLAYOUT.

Operation "drc". Inputs:
  gds           the layout, relative to the design root
  cell          the top cell
  rule_set      optional; a rule set of klayout.<pdk>.drc.rule_sets (default: the set with "default": true)
  technology    optional; the name of a technology pack, or a PDK name in the "pdks" of a pack (default: the pack
                whose "pdks" has $PDK)
  max_examples  optional; the number of marker boxes in each diagnostic (default 8)
Measurements: markers, rules_violated, runtime_s. The counts are measured only when the deck wrote a complete
marker database and its exit code agrees with the marker count. Else they are failed and the response is failed,
with one error diagnostic that starts with "not run". work/drc.json has the full table of the rules.

Operation "lvs". Inputs:
  gds, cell, technology   as for drc
  netlist       the reference netlist, relative to the design root
  pins          optional; the pins of the top cell in order
Measurements: match (1 or 0), unmatched_devices, unmatched_nets, unmatched_pins, runtime_s. The adapter gives a
match only when the deck log has the match text of the pack, the exit code is a code of a completed run, the LVS
database exists and loads, and its compare status is a match (lvsdb_probe.py reads the database with the KLayout
binary). Else the result is not run. work/lvs.json has all unmatched items and the pin check.

The response of drc and lvs has "commands": the deck command as it was run, with its exit code and runtime.

Operation "query" (see layout_read.py). Inputs:
  gds, cell, technology   as for drc
  queries       a list of questions, each {"kind": ..., arguments}: layers, cells, shapes, instances, at, bbox,
                texts, distance
It reads the layout with the KLayout Python module klayout.db in this process (no external command). The layer
names come from the file of klayout.<pdk>.layer_properties. Measurements: queries, rows, runtime_s. The answer is
in "report" (at most 200 lines) and in work/query.json.

Operation "render" (see layout_render.py). Inputs:
  gds, cell, technology   as for drc
  box           [x1, y1, x2, y2] in µm, in top-cell coordinates: the region to draw; or
  drc, rule     the id of a completed klayout drc experiment and a rule name: draw a marker of that rule, with
                index (default 1) or all (up to max, default 4), the marker outlined in red
  layers        optional; the layers to show (default: all)
  size          optional; the longer side in pixels (default 1024, at most 2048)
  labels, grid  optional; show texts (default true), show the scale bar and, for a view up to 50 µm, a 1 µm grid
  hierarchy     optional; the levels of hierarchy to draw (default: all)
It draws with the KLayout Python module klayout.lay in this process, with the layer colours of the layer
properties file. Each image is work/render.png (or render-<n>.png), an output with role "image". Measurements:
images, runtime_s. The report has one line per image: the box, the view box, the file and the layers shown.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

import layout_diff
import layout_read
import layout_render

CONTRACT = "simra.adapter/0"
HERE = os.path.dirname(os.path.realpath(__file__))
PLACEHOLDER = re.compile(r"\{(\w+)\}")
COMMAND_PLACEHOLDERS = {"drc": ("gds", "gds_stem", "cell", "run_dir", "report", "pdk_root", "klayout"),
                        "lvs": ("gds", "gds_stem", "cell", "run_dir", "report", "extracted", "netlist", "pdk_root",
                                "klayout")}
PATH_PLACEHOLDERS = ("gds_stem", "cell", "run_dir")
POINT = re.compile(r"(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?),(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)")
LOG_TAIL = 5
MAX_ITEMS = 10
LVS_ORDER = ("match", "unmatched_devices", "unmatched_nets", "unmatched_pins", "runtime_s")


# ---------------------------------------------------------------- helpers

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def display_path(path, root):
    # Compare real paths: on macOS the temporary directory /var/folders is a link to /private/var/folders.
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


def file_entry(path, root, role=None):
    entry = {"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path)}
    if role:
        entry["role"] = role
    return entry


def technology_dir():
    return os.environ.get("SIMRA_TECHNOLOGY_DIR") or os.path.join(os.path.dirname(os.path.dirname(HERE)), "technologies")


def find_facts(name, pdk):
    """(pack path, the klayout facts of one PDK, None), or (None, None, message). name is the name of a pack, or else
    a PDK name in the "pdks" of a pack; without name, the pack is the pack whose "pdks" has pdk."""
    base = technology_dir()
    packs = []
    for entry in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        path = os.path.join(base, entry, "technology.json")
        if os.path.isfile(path):
            with open(path) as f:
                packs.append((path, json.load(f)))
    if name:
        chosen = [p for p in packs if p[1].get("name") == name] or [p for p in packs if name in (p[1].get("pdks") or [])]
    else:
        chosen = [p for p in packs if pdk in (p[1].get("pdks") or [])]
    for path, pack in chosen[:1]:
        section = pack.get("klayout") or {}
        key = pdk if pdk in section else (next(iter(section)) if len(section) == 1 and not pdk else None)
        if key is None:
            return None, None, "technology pack {} has no klayout facts for PDK '{}' (it has: {})".format(
                pack.get("name"), pdk, ", ".join(section) or "none")
        return path, section[key], None
    known = ", ".join("{} ({})".format(p.get("name"), ", ".join(p.get("pdks") or [])) for _, p in packs) or "none"
    wanted = "technology pack '{}'".format(name) if name else "technology pack for PDK '{}'".format(pdk)
    return None, None, "no {} in {}; known packs: {}. Give input 'technology', or add a pack (see technologies/README.md)".format(
        wanted, base, known)


def klayout_version(binary):
    try:
        out = subprocess.check_output([binary, "-v"], stderr=subprocess.STDOUT, universal_newlines=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"KLayout\s+(\S+)", out)
    return m.group(1) if m else None


def find_klayout():
    """(binary, version) of the first KLayout that runs: klayout on PATH, then SIMRA_KLAYOUT. Or (None, message)."""
    tried = []
    for label, candidate in (("PATH", shutil.which("klayout")), ("SIMRA_KLAYOUT", os.environ.get("SIMRA_KLAYOUT"))):
        if not candidate:
            tried.append("{}: not set".format(label) if label == "SIMRA_KLAYOUT" else "not on PATH")
            continue
        version = klayout_version(candidate)
        if version:
            return os.path.realpath(candidate) if os.path.isabs(candidate) else candidate, version
        tried.append("{} ({}) does not run 'klayout -v'".format(candidate, label))
    return None, ("KLayout not found ({}). Put klayout on PATH, or set SIMRA_KLAYOUT to the KLayout binary in the "
                  "env of the environment in simra.config.json").format("; ".join(tried))


def pdk_facts():
    pdk_root, pdk = os.environ.get("PDK_ROOT"), os.environ.get("PDK")
    facts = {"PDK_ROOT": pdk_root, "PDK": pdk, "commit": None}
    if pdk_root and pdk:
        commit_file = os.path.join(pdk_root, pdk, "COMMIT")
        if os.path.isfile(commit_file):
            with open(commit_file) as f:
                facts["commit"] = f.read().strip()
    return facts


def expand(template, values, allowed):
    """The template with each {name} replaced, or raise ValueError for a name that is not allowed."""
    def one(m):
        if m.group(1) not in allowed or values.get(m.group(1)) is None:
            raise ValueError("unknown placeholder {{{}}} in the technology pack".format(m.group(1)))
        return values[m.group(1)]
    return PLACEHOLDER.sub(one, template)


def failure(tool, message, measurements=None):
    return {"contract": CONTRACT, "status": "failed", "tool": tool, "input_files": None, "outputs": [],
            "measurements": measurements or {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


def log_tail(path, n=LOG_TAIL):
    try:
        with open(path, errors="replace") as f:
            lines = [l.rstrip() for l in f.read().splitlines() if l.strip()]
    except OSError:
        return "(no log)"
    return " | ".join(l if len(l) <= 200 else l[:200] + "..." for l in lines[-n:]) or "(empty log)"


def measured(value, unit, source):
    return {"value": value, "unit": unit, "status": "measured", "source": source}


def failed(unit, source):
    return {"value": None, "unit": unit, "status": "failed", "source": source}


def outputs_of(work_dir, root):
    out = []
    for base, dirs, files in os.walk(work_dir):
        dirs.sort()
        for name in sorted(files):
            role = "image" if name.lower().endswith(".png") else None
            out.append(file_entry(os.path.join(base, name), root, role))
    return out


def setup(request, operation):
    """Common steps of drc and lvs. Returns (context, None) or (None, failed response)."""
    root = request["root"]
    inputs = request.get("inputs") or {}
    tool = {"name": "klayout", "version": None, "pdk": pdk_facts()}
    for key in ("gds", "cell") + (("netlist",) if operation == "lvs" else ()):
        if not isinstance(inputs.get(key), str) or not inputs.get(key):
            return None, failure(tool, "input '{}' is required (a string)".format(key))
    files = {}
    for key in ("gds",) + (("netlist",) if operation == "lvs" else ()):
        path = os.path.join(root, inputs[key])
        if not os.path.isfile(path):
            return None, failure(tool, "input '{}': file not found: {}".format(key, inputs[key]))
        files[key] = os.path.realpath(path)
    pack_path, facts, error = find_facts(inputs.get("technology"), os.environ.get("PDK"))
    if error:
        return None, failure(tool, error)
    pdk_root = os.environ.get("PDK_ROOT")
    if not pdk_root:
        return None, failure(tool, "PDK_ROOT is not set; the deck commands of the technology pack need it")
    binary, version = find_klayout()
    if binary is None:
        return None, failure(tool, version)
    tool["version"] = version
    return {"root": root, "inputs": inputs, "tool": tool, "files": files, "pack_path": pack_path, "facts": facts,
            "pdk_root": pdk_root, "klayout": binary, "work_dir": request["work_dir"],
            "exp_dir": os.path.dirname(os.path.realpath(request["work_dir"]))}, None


def command_argv(command, values, operation):
    """(argv, None) with the placeholders of the pack command replaced, or (None, message)."""
    try:
        return [expand(word, values, COMMAND_PLACEHOLDERS[operation]) for word in command], None
    except ValueError as e:
        return None, str(e)


def command_record(argv, code, runtime):
    """One entry of the response field "commands": an external command as it was run."""
    return {"argv": list(argv), "exit_code": code, "runtime_s": runtime}


def run_deck(ctx, operation, argv, run_dir):
    """Run the deck in work_dir; its stdout and stderr go to work_dir/<operation>.log.
    Returns (exit code or None, runtime_s, error message or None)."""
    os.makedirs(run_dir, exist_ok=True)
    log_path = os.path.join(ctx["work_dir"], operation + ".log")
    # The PDK scripts call "klayout" by name: put the directory of the found binary first on PATH.
    env = dict(os.environ, PATH=os.path.dirname(os.path.abspath(ctx["klayout"])) + os.pathsep + os.environ.get("PATH", ""))
    start = time.monotonic()
    with open(log_path, "w") as log:
        log.write("# " + " ".join(argv) + "\n")
        log.flush()
        try:
            code = subprocess.call(argv, cwd=ctx["work_dir"], env=env, stdout=log, stderr=subprocess.STDOUT)
        except OSError as e:
            return None, round(time.monotonic() - start, 3), "could not start the deck: {}".format(e)
    return code, round(time.monotonic() - start, 3), None


def deck_inputs(ctx, command, values, operation):
    """The input files: the layout (and netlist), the technology pack and the deck files of the command."""
    files = [file_entry(ctx["files"]["gds"], ctx["root"], "layout")]
    if "netlist" in ctx["files"]:
        files.append(file_entry(ctx["files"]["netlist"], ctx["root"], "netlist"))
    for word in command:
        try:
            text = expand(word, values, COMMAND_PLACEHOLDERS[operation])
        except ValueError:
            continue
        text = text.split("=", 1)[1] if "=" in text and not os.path.isfile(text) else text
        if text.startswith(ctx["pdk_root"]) and os.path.isfile(text):
            files.append(file_entry(text, ctx["root"], "deck"))
    files.append(file_entry(ctx["pack_path"], ctx["root"], "technology"))
    return {"complete": True, "files": files}


def rel(ctx, path):
    """A path relative to the experiment directory, for example work/drc/x.lyrdb."""
    return os.path.relpath(os.path.realpath(path), ctx["exp_dir"])


def write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
        f.write("\n")


# ---------------------------------------------------------------- drc

def unquote(text):
    text = (text or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1]
    return text


def value_box(text):
    """The bounding box [x1, y1, x2, y2] (µm) of a marker value such as 'edge-pair: (0,1;2,1)|(...)', or None."""
    points = [(float(x), float(y)) for x, y in POINT.findall(text or "")]
    if not points:
        return None
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]


def parse_lyrdb(path):
    """The rules of a marker database: (table, None) or (None, reason). The table is a list of
    {rule, description, count, cells: {cell: count}, boxes: [{cell, box}]}, ordered by count (largest first)."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        return None, "the report {} cannot be read: {}".format(os.path.basename(path), e)
    if not data.rstrip().endswith(b"</report-database>"):
        return None, "the report is truncated (it does not end with </report-database>)"
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        return None, "the report does not parse: {}".format(e)
    if root.tag != "report-database":
        return None, "the report is not a KLayout marker database (root element {})".format(root.tag)
    descriptions = {}
    for category in root.iter("category"):
        name = category.findtext("name")
        if name is not None:
            descriptions[unquote(name)] = (category.findtext("description") or "").strip()
    rules = {}
    items = root.find("items")
    for item in (items if items is not None else []):
        rule = unquote(item.findtext("category"))
        cell = unquote(item.findtext("cell")) or None
        entry = rules.setdefault(rule, {"rule": rule, "description": descriptions.get(rule, ""), "count": 0,
                                        "cells": {}, "boxes": []})
        entry["count"] += 1
        entry["cells"][cell] = entry["cells"].get(cell, 0) + 1
        values = item.find("values")
        texts = [v.text for v in values.findall("value")] if values is not None else []
        boxes = [b for b in (value_box(t) for t in texts) if b]
        if boxes:
            entry["boxes"].append({"cell": cell, "box": [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                                         max(b[2] for b in boxes), max(b[3] for b in boxes)]})
    table = sorted(rules.values(), key=lambda r: (-r["count"], r["rule"]))
    for r in table:
        r["cells"] = dict(sorted(r["cells"].items(), key=lambda kv: (-kv[1], str(kv[0]))))
    return table, None


def fmt(x):
    return "{:g}".format(x)


def rule_message(r, max_examples):
    """One line for a violated rule: the count, the description and the first max_examples marker boxes, grouped by
    cell. When the boxes do not show every marker, the line also gives the marker count of each cell."""
    text = "{}: {} marker{}".format(r["rule"], r["count"], "" if r["count"] == 1 else "s")
    if r["description"] and r["description"] != r["rule"]:
        text += ". {}".format(r["description"].rstrip(". "))
    examples = r["boxes"][:max_examples]
    if len(examples) < r["count"]:
        text += ". Cells: {}".format(", ".join("{} ({})".format(c, n) for c, n in r["cells"].items()))
    if examples:
        groups = {}
        for b in examples:
            groups.setdefault(b["cell"], []).append("({},{};{},{})".format(*[fmt(v) for v in b["box"]]))
        text += ". Boxes (µm, cell coordinates): " + "  ".join(
            "{}: {}".format(c, " ".join(boxes)) for c, boxes in groups.items())
    more = len(r["boxes"]) - len(examples)
    if more:
        text += " ... {} more in work/drc.json".format(more) if examples else ". Boxes: {} in work/drc.json".format(more)
    return text


def table_message(table_path, report_path, root):
    """The last DRC diagnostic: where the full table and the marker database are, as the summary shows the paths."""
    return "Full table: {} (all markers of each rule, by cell). Marker database: {}".format(
        display_path(table_path, root), display_path(report_path, root))


def drc_verdict(code, report_path, log_text, rule_set):
    """(table, None) when the deck completed, or (None, reason) when the result is not run."""
    if code is None:
        return None, "the deck did not run"
    for text in rule_set.get("incomplete_texts") or []:
        if text in log_text:
            return None, "the deck log has '{}': a part of the deck did not finish".format(text)
    if not os.path.isfile(report_path):
        return None, "the deck did not write the report {} (exit code {})".format(os.path.basename(report_path), code)
    table, reason = parse_lyrdb(report_path)
    if reason:
        return None, "{} (exit code {})".format(reason, code)
    markers = sum(r["count"] for r in table)
    violations = rule_set.get("exit_code_violations")
    if code == 0 and (violations is None or markers == 0):
        return table, None
    if violations is not None and code == violations and markers > 0:
        return table, None
    if violations is None:
        expected = "0"
    else:
        expected = "0 with no markers, {} with markers".format(violations)
    return None, "exit code {} does not agree with the report ({} markers; a completed run of this rule set exits with {})".format(
        code, markers, expected)


def drc(request):
    ctx, error = setup(request, "drc")
    if error:
        return error
    inputs, facts = ctx["inputs"], ctx["facts"]
    sets = (facts.get("drc") or {}).get("rule_sets") or {}
    name = inputs.get("rule_set") or next((k for k, v in sets.items() if v.get("default")), None)
    if name not in sets:
        return failure(ctx["tool"], "rule set '{}' is not in the technology pack; known sets: {}".format(name, ", ".join(sets)))
    rule_set = sets[name]
    max_examples = inputs.get("max_examples", 8)
    if not isinstance(max_examples, int) or isinstance(max_examples, bool) or max_examples < 0:
        return failure(ctx["tool"], "input 'max_examples' must be an integer of 0 or more")
    gds = ctx["files"]["gds"]
    values = {"gds": gds, "gds_stem": os.path.splitext(os.path.basename(gds))[0], "cell": inputs["cell"],
              "run_dir": os.path.join(os.path.realpath(ctx["work_dir"]), "drc"), "pdk_root": ctx["pdk_root"],
              "klayout": ctx["klayout"]}
    try:
        values["report"] = expand(rule_set["report"], values, PATH_PLACEHOLDERS)
    except (KeyError, ValueError) as e:
        return failure(ctx["tool"], "rule set '{}': bad report template: {}".format(name, e))
    argv, error = command_argv(rule_set["command"], values, "drc")
    if error:
        return failure(ctx["tool"], "rule set '{}': {}".format(name, error))
    code, runtime, error = run_deck(ctx, "drc", argv, values["run_dir"])
    log_path = os.path.join(ctx["work_dir"], "drc.log")
    with open(log_path, errors="replace") as f:
        log_text = f.read()
    table, reason = drc_verdict(code, values["report"], log_text, rule_set) if not error else (None, error)
    report_src = rel(ctx, values["report"])
    response = {"contract": CONTRACT, "tool": ctx["tool"], "commands": [command_record(argv, code, runtime)],
                "input_files": deck_inputs(ctx, rule_set["command"], values, "drc"), "diagnostics": []}
    response["diagnostics"].append({"severity": "info", "source": "adapter", "message": "rule set {}: {}".format(
        name, rule_set.get("description", ""))})
    if table is None:
        response["status"] = "failed"
        response["measurements"] = {"markers": failed(None, report_src), "rules_violated": failed(None, report_src),
                                    "runtime_s": measured(runtime, "s", rel(ctx, log_path))}
        response["diagnostics"].insert(0, {"severity": "error", "source": rel(ctx, log_path), "message": (
            "not run: {}. The marker counts are not known. Last lines of the deck log: {}").format(reason, log_tail(log_path))})
    else:
        response["status"] = "completed"
        response["measurements"] = {"markers": measured(sum(r["count"] for r in table), None, report_src),
                                    "rules_violated": measured(len(table), None, report_src),
                                    "runtime_s": measured(runtime, "s", rel(ctx, log_path))}
        for r in table:
            response["diagnostics"].append({"severity": "error", "source": report_src, "message": rule_message(r, max_examples)})
        table_path = os.path.join(ctx["work_dir"], "drc.json")
        if table:
            response["diagnostics"].append({"severity": "warning", "source": "adapter",
                                            "message": table_message(table_path, values["report"], ctx["root"])})
        write_json(table_path, {
            "rule_set": name, "report": report_src, "exit_code": code, "markers": sum(r["count"] for r in table),
            "rules": [{"rule": r["rule"], "description": r["description"], "count": r["count"], "cells": r["cells"],
                       "boxes": r["boxes"]} for r in table]})
    response["outputs"] = outputs_of(ctx["work_dir"], ctx["root"])
    return response


# ---------------------------------------------------------------- lvs

def run_probe(ctx, lvsdb, cell):
    """The compare result of an LVS database (see lvsdb_probe.py), or a dict with loaded false and the error."""
    out = os.path.join(ctx["work_dir"], "lvsdb_probe.json")
    argv = [ctx["klayout"], "-b", "-r", os.path.join(HERE, "lvsdb_probe.py"), "-rd", "lvsdb=" + lvsdb,
            "-rd", "result=" + out, "-rd", "top_cell=" + cell]
    with open(os.path.join(ctx["work_dir"], "lvsdb_probe.log"), "w") as log:
        try:
            code = subprocess.call(argv, cwd=ctx["work_dir"], stdout=log, stderr=subprocess.STDOUT)
        except OSError as e:
            return {"loaded": False, "error": "could not start KLayout to read the database: {}".format(e)}
    try:
        with open(out) as f:
            probe = json.load(f)
    except (OSError, ValueError):
        return {"loaded": False, "error": "KLayout could not read the database (exit code {}): {}".format(
            code, log_tail(os.path.join(ctx["work_dir"], "lvsdb_probe.log")))}
    os.remove(out)
    return probe


def lvs_verdict(code, log_text, lvsdb_exists, probe, facts):
    """("match" | "mismatch" | "not run", reason). probe is the result of lvsdb_probe (None when not run)."""
    codes = facts.get("exit_codes") or {}
    says_match = facts["match_text"] in log_text
    says_mismatch = facts["mismatch_text"] in log_text
    if code is None:
        return "not run", "the deck did not run"
    if not lvsdb_exists:
        return "not run", "the deck did not write the LVS database (exit code {})".format(code)
    if not probe or not probe.get("loaded"):
        return "not run", "the LVS database does not load in KLayout: {}".format((probe or {}).get("error") or "not read")
    if not probe.get("compared"):
        return "not run", "the LVS database has no compare result"
    if says_match and says_mismatch:
        return "not run", "the deck log has both the match text and the mismatch text"
    if probe.get("match"):
        if not says_match:
            return "not run", "the compare status in the database is a match, but the deck log does not have the match text '{}'".format(
                facts["match_text"])
        if code not in (codes.get("match") or []):
            return "not run", "exit code {} is not a code of a completed run with a match (the pack gives {})".format(
                code, codes.get("match"))
        return "match", None
    if not says_mismatch:
        what = "has the match text" if says_match else "has neither the match text nor the mismatch text"
        return "not run", "the compare status in the database is not a match, but the deck log {}".format(what)
    if code not in (codes.get("mismatch") or []):
        return "not run", "exit code {} is not a code of a completed run with a mismatch (the pack gives {})".format(
            code, codes.get("mismatch"))
    return "mismatch", None


def pin_check(pins, top):
    """Warnings for each pin of pins that is not a pin of the extracted top circuit, not a pin of the reference
    circuit, or in a different order than in the reference circuit. Returns (count, [messages], [rows]).
    The extracted circuit has no pin order (KLayout sorts its pins by name), so the order is the order of the
    reference netlist."""
    layout = {p.lower() for p in (top.get("layout_pins") or []) if p}
    reference = [p.lower() for p in (top.get("reference_pins") or []) if p]
    rows = []
    in_both = [p for p in pins if p.lower() in layout and p.lower() in reference]
    order = [p for p in reference if p in {q.lower() for q in in_both}]
    for p in pins:
        reasons = []
        if p.lower() not in layout:
            reasons.append("it is not a pin of the extracted top circuit {}".format(top.get("layout")))
        if p.lower() not in reference:
            reasons.append("it is not a pin of the reference circuit {}".format(top.get("reference")))
        elif p in in_both and order[in_both.index(p)] != p.lower():
            reasons.append("it is at position {} of pins, but at position {} of the reference circuit {} ({})".format(
                pins.index(p) + 1, reference.index(p.lower()) + 1, top.get("reference"), " ".join(top.get("reference_pins"))))
        if reasons:
            rows.append({"pin": p, "reasons": reasons})
    messages = ["pin {}: {}".format(r["pin"], "; ".join(r["reasons"])) for r in rows]
    return len(rows), messages, rows


def item_side(item):
    if item.get("layout") and item.get("reference"):
        return "layout {} / reference {}".format(item["layout"], item["reference"])
    return "layout only: {}".format(item["layout"]) if item.get("layout") else "reference only: {}".format(item.get("reference"))


def lvs(request):
    ctx, error = setup(request, "lvs")
    if error:
        return error
    inputs, facts = ctx["inputs"], ctx["facts"].get("lvs")
    if not facts:
        return failure(ctx["tool"], "the technology pack has no klayout lvs facts for this PDK")
    pins = inputs.get("pins")
    if pins is not None and (not isinstance(pins, list) or not all(isinstance(p, str) and p for p in pins)):
        return failure(ctx["tool"], "input 'pins' must be a list of pin names")
    gds = ctx["files"]["gds"]
    values = {"gds": gds, "gds_stem": os.path.splitext(os.path.basename(gds))[0], "cell": inputs["cell"],
              "run_dir": os.path.join(os.path.realpath(ctx["work_dir"]), "lvs"), "netlist": ctx["files"]["netlist"],
              "pdk_root": ctx["pdk_root"], "klayout": ctx["klayout"]}
    try:
        values["report"] = expand(facts["report"], values, PATH_PLACEHOLDERS)
        values["extracted"] = expand(facts["extracted"], values, PATH_PLACEHOLDERS)
    except (KeyError, ValueError) as e:
        return failure(ctx["tool"], "bad lvs report template in the technology pack: {}".format(e))
    argv, error = command_argv(facts["command"], values, "lvs")
    if error:
        return failure(ctx["tool"], "lvs: {}".format(error))
    code, runtime, error = run_deck(ctx, "lvs", argv, values["run_dir"])
    log_path = os.path.join(ctx["work_dir"], "lvs.log")
    with open(log_path, errors="replace") as f:
        log_text = f.read()
    exists = os.path.isfile(values["report"])
    probe = run_probe(ctx, values["report"], inputs["cell"]) if exists and code is not None else None
    verdict, reason = lvs_verdict(code, log_text, exists, probe, facts) if not error else ("not run", error)
    response = {"contract": CONTRACT, "tool": ctx["tool"], "commands": [command_record(argv, code, runtime)],
                "input_files": deck_inputs(ctx, facts["command"], values, "lvs"), "diagnostics": []}
    response.update(lvs_result(ctx, verdict, reason, probe, pins, runtime, values, log_path, code))
    response["outputs"] = outputs_of(ctx["work_dir"], ctx["root"])
    return response


def lvs_result(ctx, verdict, reason, probe, pins, runtime, values, log_path, code):
    """status, measurements and diagnostics of an LVS run; writes work/lvs.json when the database loaded."""
    db_src, log_src = rel(ctx, values["report"]), rel(ctx, log_path)
    diagnostics = []
    m = {"runtime_s": measured(runtime, "s", log_src)}
    if verdict == "not run":
        for key in ("match", "unmatched_devices", "unmatched_nets", "unmatched_pins"):
            m[key] = failed(None, db_src)
        diagnostics.append({"severity": "error", "source": log_src, "message": (
            "not run: {}. The LVS result is not known. Last lines of the deck log: {}").format(reason, log_tail(log_path))})
        return {"status": "failed", "measurements": {k: m[k] for k in LVS_ORDER}, "diagnostics": diagnostics}
    devices, nets, circuits = probe.get("devices") or [], probe.get("nets") or [], probe.get("circuits") or []
    m["match"] = measured(1 if verdict == "match" else 0, None, db_src)
    m["unmatched_devices"] = measured(len(devices), None, db_src)
    m["unmatched_nets"] = measured(len(nets), None, db_src)
    if verdict == "mismatch":
        failing = [c for c in circuits if c["status"] != "Skipped"]
        skipped = [c for c in circuits if c["status"] == "Skipped"]
        diagnostics.append({"severity": "error", "source": db_src, "message": (
            "the netlists do not match: {} circuit{} not match{}, {} unmatched devices, {} unmatched nets").format(
                len(failing), " does" if len(failing) == 1 else "s do",
                " ({} more not compared)".format(len(skipped)) if skipped else "", len(devices), len(nets))})
        for c in failing[:MAX_ITEMS]:
            pins_text = ", ".join(item_side(p) for p in c.get("pins") or [])
            diagnostics.append({"severity": "error", "source": db_src, "message": "circuit {} (reference {}): {}{}".format(
                c.get("layout"), c.get("reference"), c["status"], "; unmatched pins: " + pins_text if pins_text else "")})
        for d in devices[:MAX_ITEMS]:
            diagnostics.append({"severity": "error", "source": db_src, "message": "device {} in {}: {}, {}".format(
                d.get("class"), d.get("circuit"), item_side(d), d["status"])})
        for n in nets[:MAX_ITEMS]:
            diagnostics.append({"severity": "error", "source": db_src, "message": "net in {}: {}, {}".format(
                n.get("circuit"), item_side(n), n["status"])})
        rest = max(0, len(devices) - MAX_ITEMS) + max(0, len(nets) - MAX_ITEMS) + max(0, len(failing) - MAX_ITEMS)
        if rest:
            diagnostics.append({"severity": "error", "source": rel(ctx, os.path.join(ctx["work_dir"], "lvs.json")),
                                "message": "{} more unmatched items are in work/lvs.json".format(rest)})
    top = probe.get("top") or {}
    pin_rows = []
    if pins is None:
        m["unmatched_pins"] = {"value": None, "unit": None, "status": "missing", "source": "adapter"}
        diagnostics.append({"severity": "info", "source": "adapter", "message": "pin check not run: input 'pins' was not given"})
    else:
        count, messages, pin_rows = pin_check(pins, top)
        m["unmatched_pins"] = measured(count, None, db_src)
        diagnostics.extend({"severity": "warning", "source": db_src, "message": text} for text in messages)
    write_json(os.path.join(ctx["work_dir"], "lvs.json"), {
        "verdict": verdict, "exit_code": code, "database": db_src, "extracted": rel(ctx, values["extracted"]),
        "top": top, "pins": pins, "pin_check": pin_rows, "circuits": circuits, "devices": devices, "nets": nets})
    return {"status": "completed", "measurements": {k: m[k] for k in LVS_ORDER}, "diagnostics": diagnostics}


# ---------------------------------------------------------------- query

def technology_facts(name):
    """(pack path, klayout facts, None) or (None, None, message), as find_facts; a PDK name in input 'technology'
    also selects the facts of that PDK."""
    pack_path, facts, error = find_facts(name, os.environ.get("PDK"))
    if error and name:
        pack_path, facts, error = find_facts(name, name)
    return pack_path, facts, error


def read_setup(request, layout_keys):
    """Common steps of query and diff: inputs, klayout.db, the pack and the layer names.
    Returns (context, None) or (None, failed response)."""
    root = request["root"]
    inputs = request.get("inputs") or {}
    tool = {"name": "klayout", "version": None, "module": "klayout.db", "pdk": pdk_facts()}
    for key in layout_keys + ("cell",):
        if not isinstance(inputs.get(key), str) or not inputs.get(key):
            return None, failure(tool, "input '{}' is required (a string)".format(key))
    db = layout_read.klayout_db()
    if db is None:
        return None, failure(tool, "the KLayout Python module klayout.db is not installed for {} (pip package klayout)".format(
            sys.executable))
    tool["version"] = getattr(db, "__version__", None)
    diagnostics, files = [], []
    pack_path, facts, error = technology_facts(inputs.get("technology"))
    if error:
        diagnostics.append({"severity": "warning", "source": "adapter",
                            "message": "layer names not known: {}. Layers are given as layer/datatype".format(error)})
        names, lyp = layout_read.LayerNames(), None
    else:
        names, lyp, warning = layout_read.layer_names(facts, os.environ.get("PDK_ROOT"), expand)
        if warning:
            diagnostics.append({"severity": "warning", "source": "adapter", "message": warning})
    complete = True
    if lyp and os.path.isfile(lyp):
        files.append(file_entry(lyp, root, "layer_properties"))
    elif lyp:
        complete = False
    if pack_path:
        files.append(file_entry(pack_path, root, "technology"))
    return {"root": root, "inputs": inputs, "tool": tool, "db": db, "names": names, "diagnostics": diagnostics,
            "files": files, "complete": complete, "lyp": lyp if lyp and os.path.isfile(lyp) else None,
            "work_dir": request["work_dir"],
            "exp_dir": os.path.dirname(os.path.realpath(request["work_dir"]))}, None


def read_response(ctx, status, measurements, report, table_name, layouts):
    """The response of query and diff."""
    files = [file_entry(path, ctx["root"], "layout") for path in layouts] + ctx["files"]
    return {"contract": CONTRACT, "status": status, "tool": ctx["tool"],
            "input_files": {"complete": ctx["complete"], "files": files},
            "outputs": outputs_of(ctx["work_dir"], ctx["root"]), "measurements": measurements,
            "diagnostics": ctx["diagnostics"], "report": layout_read.truncate(report, "work/" + table_name)}


QUERY_UNITS = (("queries", None), ("rows", None), ("runtime_s", "s"))


def none_measured(units):
    """The measurements of a read operation that gave no answer: each one failed, none omitted."""
    return {key: failed(unit, "adapter") for key, unit in units}


def query(request):
    ctx, error = read_setup(request, ("gds",))
    if error:
        error["measurements"] = none_measured(QUERY_UNITS)
        return error
    inputs, tool = ctx["inputs"], ctx["tool"]

    def fail(message):
        return failure(tool, message, none_measured(QUERY_UNITS))

    queries = inputs.get("queries")
    if not isinstance(queries, list) or not queries:
        return fail("input 'queries' is required: a list of questions, each with a 'kind' ({})".format(
            ", ".join(layout_read.KINDS)))
    gds = os.path.join(ctx["root"], inputs["gds"])
    if not os.path.isfile(gds):
        return fail("input 'gds': file not found: {}".format(inputs["gds"]))
    start = time.monotonic()
    try:
        report, full, diagnostics, answered, rows = layout_read.run_queries(ctx["db"], gds, inputs["cell"], queries, ctx["names"])
    except layout_read.QueryError as e:
        return fail(str(e))
    except RuntimeError as e:
        return fail("klayout.db could not read {}: {}".format(inputs["gds"], str(e).splitlines()[0] if str(e) else e))
    runtime = round(time.monotonic() - start, 3)
    full.update({"gds": inputs["gds"], "runtime_s": runtime})
    table = os.path.join(ctx["work_dir"], "query.json")
    write_json(table, full)
    src = rel(ctx, table)
    ctx["diagnostics"].extend(diagnostics)
    measurements = {"queries": measured(len(queries), None, src), "rows": measured(rows, None, src),
                    "runtime_s": measured(runtime, "s", "adapter")}
    return read_response(ctx, "completed" if answered else "failed", measurements, report, "query.json", [gds])


DIFF_UNITS = (("layers_changed", None), ("area_added_um2", "um2"), ("area_removed_um2", "um2"), ("cells_changed", None),
              ("markers_new", None), ("markers_fixed", None), ("markers_unchanged", None), ("runtime_s", "s"))
EXPERIMENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def materialise_git(ctx, spec, gds_input):
    """Write the file of a git ref (against 'git:<ref>' or 'git:<ref>:<path>') to work/against.gds with git show.
    Returns (path, command record, None) or (None, command record or None, message)."""
    ref, _, path = spec[len("git:"):].partition(":")
    path = path or gds_input
    if not ref or ref.startswith("-") or any(c.isspace() for c in ref):
        return None, None, "input 'against': '{}' is not git:<ref> or git:<ref>:<path>".format(spec)
    out = os.path.join(ctx["work_dir"], "against.gds")
    argv = ["git", "-c", "safe.directory=*", "-C", ctx["root"], "show", "{}:./{}".format(ref, path)]
    start = time.monotonic()
    try:
        with open(out, "wb") as f, open(os.path.join(ctx["work_dir"], "git-show.log"), "wb") as log:
            code = subprocess.call(argv, stdout=f, stderr=log)
    except OSError as e:
        return None, command_record(argv, None, None), "input 'against': git did not start: {}".format(e)
    record = command_record(argv, code, round(time.monotonic() - start, 3))
    if code != 0:
        with open(os.path.join(ctx["work_dir"], "git-show.log"), errors="replace") as log:
            reason = " ".join(log.read().split())[:300]
        os.remove(out)
        return None, record, "input 'against': git show {}:./{} failed (exit {}): {}".format(ref, path, code, reason)
    return out, record, None


def drc_table(ctx, key, layout_path):
    """(table, None) or (None, message): work/drc.json of a completed klayout drc experiment. Adds the table to the
    input files, and a warning when the experiment ran on another file than layout_path."""
    exp_id = ctx["inputs"].get(key)
    if not isinstance(exp_id, str) or not EXPERIMENT_ID.match(exp_id):
        return None, "input '{}' must be an experiment id".format(key)
    exp = os.path.join(ctx["root"], "simra", "experiments", exp_id)
    try:
        with open(os.path.join(exp, "result.json")) as f:
            result = json.load(f)
    except (OSError, ValueError):
        return None, "input '{}': experiment {} has no readable result.json".format(key, exp_id)
    table_path = os.path.join(exp, "work", "drc.json")
    if result.get("status") != "completed" or not os.path.isfile(table_path):
        return None, "input '{}': experiment {} is not a completed klayout drc with work/drc.json (status {})".format(
            key, exp_id, result.get("status"))
    try:
        with open(table_path) as f:
            table = json.load(f)
    except (OSError, ValueError) as e:
        return None, "input '{}': {} does not parse: {}".format(key, display_path(table_path, ctx["root"]), e)
    ctx["files"].append(file_entry(table_path, ctx["root"], "drc"))
    layouts = [f for f in (result.get("input_files") or {}).get("files", []) if f.get("role") == "layout"]
    digest = sha256(layout_path)
    if layouts and all(f.get("sha256") != digest for f in layouts):
        ctx["diagnostics"].append({"severity": "warning", "source": "adapter", "message": (
            "input '{}': experiment {} ran on {} (sha256 {}), not on this file (sha256 {}): the marker delta may not be "
            "of these layouts").format(key, exp_id, layouts[0].get("path"), str(layouts[0].get("sha256"))[:12], digest[:12])})
    return table, None


def diff(request):
    ctx, error = read_setup(request, ("gds", "against"))
    if error:
        error["measurements"] = none_measured(DIFF_UNITS)
        return error
    inputs, tool = ctx["inputs"], ctx["tool"]
    commands = []

    def fail(message):
        response = failure(tool, message, none_measured(DIFF_UNITS))
        if commands:
            response["commands"] = commands
        return response

    gds = os.path.join(ctx["root"], inputs["gds"])
    if not os.path.isfile(gds):
        return fail("input 'gds': file not found: {}".format(inputs["gds"]))
    spec = inputs["against"]
    if spec.startswith("git:"):
        against, record, message = materialise_git(ctx, spec, inputs["gds"])
        if record:
            commands.append(record)
        if message:
            return fail(message)
    else:
        against = os.path.join(ctx["root"], spec)
        if not os.path.isfile(against):
            return fail("input 'against': file not found: {}".format(spec))
    unknown = sorted(set(inputs) - {"gds", "against", "cell", "technology", "layers", "box", "max", "drc", "drc_against"})
    if unknown:
        return fail("unknown input{} {} (the inputs of diff: gds, against, cell, technology, layers, box, max, drc, "
                    "drc_against)".format("s" if len(unknown) > 1 else "", ", ".join(unknown)))
    drc_pair = None
    given = [k for k in ("drc", "drc_against") if inputs.get(k) is not None]
    if len(given) == 1:
        ctx["diagnostics"].append({"severity": "error", "source": "adapter", "message": (
            "input '{}' needs input '{}': the marker delta is not run").format(
                given[0], "drc_against" if given[0] == "drc" else "drc")})
    elif given:
        table, message = drc_table(ctx, "drc", gds)
        table_against, message_against = drc_table(ctx, "drc_against", against) if not message else (None, None)
        if message or message_against:
            ctx["diagnostics"].append({"severity": "error", "source": "adapter",
                                       "message": "{}: the marker delta is not run".format(message or message_against)})
        else:
            drc_pair = (table, table_against, inputs["drc"], inputs["drc_against"])
    start = time.monotonic()
    try:
        report, full, values, warnings = layout_diff.run_diff(ctx["db"], gds, against, inputs["cell"], ctx["names"], {
            "layers": inputs.get("layers"), "box": inputs.get("box"), "max": inputs.get("max", 10),
            "a_name": inputs["gds"], "b_name": spec, "drc": drc_pair})
    except layout_read.QueryError as e:
        return fail(str(e))
    except RuntimeError as e:
        return fail("klayout.db: {}".format(str(e).splitlines()[0] if str(e) else type(e).__name__))
    runtime = round(time.monotonic() - start, 3)
    for w in warnings:
        ctx["diagnostics"].append({"severity": "warning", "source": "adapter", "message": w})
    full.update({"gds": inputs["gds"], "against": spec, "against_file": display_path(against, ctx["root"]),
                 "runtime_s": runtime})
    table_path = os.path.join(ctx["work_dir"], "diff.json")
    write_json(table_path, full)
    src = rel(ctx, table_path)
    measurements = {}
    for key, unit in DIFF_UNITS:
        if key == "runtime_s":
            measurements[key] = measured(runtime, "s", "adapter")
        elif key in values:
            measurements[key] = measured(values[key], unit, src)
        elif given:
            measurements[key] = failed(unit, "adapter")
        else:
            measurements[key] = {"value": None, "unit": unit, "status": "missing", "source": "adapter"}
    response = read_response(ctx, "completed", measurements, report, "diff.json", [gds, against])
    if commands:
        response["commands"] = commands
    return response

RENDER_UNITS = (("images", None), ("runtime_s", "s"))


def render(request):
    ctx, error = read_setup(request, ("gds",))
    if error:
        error["measurements"] = none_measured(RENDER_UNITS)
        return error
    inputs, tool = ctx["inputs"], ctx["tool"]

    def fail(message):
        return failure(tool, message, none_measured(RENDER_UNITS))

    lay = layout_render.klayout_lay()
    if lay is None:
        return fail("the KLayout Python module klayout.lay is not installed for {} (pip package klayout)".format(sys.executable))
    tool["module"] = "klayout.lay"
    gds = os.path.join(ctx["root"], inputs["gds"])
    if not os.path.isfile(gds):
        return fail("input 'gds': file not found: {}".format(inputs["gds"]))
    table = None
    try:
        kind = layout_render.view_kind(inputs)
    except layout_read.QueryError as e:
        return fail(str(e))
    if kind == "drc":
        table, message = drc_table(ctx, "drc", gds)
        if message:
            return fail(message)
    start = time.monotonic()
    try:
        report, full, paths = layout_render.run_render(lay, ctx["db"], gds, inputs["cell"], inputs, ctx["names"], ctx["lyp"],
                                                       ctx["work_dir"], lambda p: rel(ctx, p), table)
    except layout_read.QueryError as e:
        return fail(str(e))
    except RuntimeError as e:
        return fail("klayout.lay could not draw {}: {}".format(inputs["gds"], str(e).splitlines()[0] if str(e) else e))
    runtime = round(time.monotonic() - start, 3)
    full.update({"gds": inputs["gds"], "drc": inputs.get("drc"), "rule": inputs.get("rule"), "runtime_s": runtime})
    write_json(os.path.join(ctx["work_dir"], "render.json"), full)
    measurements = {"images": measured(len(paths), None, "adapter"), "runtime_s": measured(runtime, "s", "adapter")}
    return read_response(ctx, "completed", measurements, report, "render.json", [gds])


# ---------------------------------------------------------------- main

def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: klayout_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    operation = {"drc": drc, "lvs": lvs, "query": query, "diff": diff, "render": render}.get(request.get("operation"))
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
