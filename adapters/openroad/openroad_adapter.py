#!/usr/bin/env python3
"""OpenROAD adapter for Simra Agent (contract simra.adapter/0).

Usage: openroad_adapter.py <request.json>

Operation "parse". Inputs:
  log       a log of OpenROAD (a flow step log, or the output of a script), relative to the design root; .gz is read
  liberty   optional; a list of Liberty files: the report gives the library name and the nominal conditions of each
It reads the files and runs no tool. Measurements: errors, warnings (message counts); for each repair table n
(repair_timing, repair_design; n counts from 1): repair<n>_rows, repair<n>_wns_ns, repair<n>_tns_ns,
repair<n>_buffers of its last row; route_usage_pct, route_overflow, route_wirelength_um when the log has a
congestion report of global_route (the usage is over all routing resources of the die). Diagnostics: one error for
each error message code; one warning for each repair table that did not close and shows a known pattern
(the maximum buffer count, one pass for each end point, a constant worst slack), or that closed with a
margin-only message. The report has one line for each table, message code and loaded library.
"""

import hashlib
import json
import os
import sys

import openroad_log as orlog

CONTRACT = "simra.adapter/0"


def display(path, root):
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


def measured(value, unit, source):
    return {"value": value, "unit": unit, "status": "measured", "source": source}


def failure(message):
    return {"contract": CONTRACT, "status": "failed", "tool": {"name": "openroad", "version": None}, "input_files": None,
            "outputs": [], "measurements": {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


def parse(request):
    root = request["root"]
    inputs = request.get("inputs") or {}
    name = inputs.get("log")
    if not isinstance(name, str) or not name:
        return failure("input 'log' is required: the path of an OpenROAD log")
    path = name if os.path.isabs(name) else os.path.join(root, name)
    if not os.path.isfile(path):
        return failure("the log {} is not there".format(name))
    text = orlog.read_text(path)
    shown = display(path, root)
    found = orlog.messages(text)
    measurements = {"errors": measured(sum(m["count"] for m in found if m["severity"] in ("error", "critical")), "", shown),
                    "warnings": measured(sum(m["count"] for m in found if m["severity"] == "warning"), "", shown)}
    diagnostics, report = [], []
    for number, table in enumerate(orlog.repair_tables(text), 1):
        final = table["final"] or (table["rows"][-1] if table["rows"] else {})
        source = "{}:{}".format(shown, table["line"])
        measurements["repair{}_rows".format(number)] = measured(len(table["rows"]), "", source)
        for key, unit in (("wns", "ns"), ("tns", "ns"), ("buffers", "")):
            if final.get(key) is not None:
                measurements["repair{}_{}{}".format(number, key, "_ns" if unit else "")] = measured(final[key], unit, source)
        report.append("repair table {} ({}) at line {}: {} rows, end points found {}, last row wns {} tns {} buffers {}".format(
            number, table["kind"], table["line"], len(table["rows"]), table["endpoints_found"] if table["endpoints_found"] is not None else "-",
            final.get("wns", "-"), final.get("tns", "-"), final.get("buffers", table["inserted_buffers"])))
        for finding in orlog.diagnose_repair(table, found):
            diagnostics.append({"severity": "warning", "source": source, "message": "{} repair table at line {} ({}): {}".format(
                table["kind"], table["line"], finding["pattern"], finding["message"])})
    route = orlog.global_route(text)
    if route and route["total"]:
        source = "{}:{}".format(shown, route["line"])
        measurements["route_usage_pct"] = measured(route["total"]["usage_pct"], "%", source + " (all routing resources of the die)")
        measurements["route_overflow"] = measured(route["total"]["overflow"], "", source)
        if route["wirelength_um"] is not None:
            measurements["route_wirelength_um"] = measured(route["wirelength_um"], "um", shown)
        for row in route["congestion"]:
            report.append("route {}: resource {} demand {} usage {:.2f} % overflow {}".format(
                row["layer"], row["resource"], row["demand"], row["usage_pct"], row["overflow"]))
    for message in found:
        if message["severity"] == "info":
            continue
        report.append("{} {} x{} (line {}): {}".format(message["severity"], message["code"], message["count"], message["line"], message["text"][:120]))
        if message["severity"] in ("error", "critical"):
            diagnostics.append({"severity": "error", "message": "[{}] {}".format(message["code"], message["text"]),
                                "source": "{}:{}".format(shown, message["line"])})
    for entry in orlog.library_loads(text):
        report.append("library of corner {}: {}".format(entry["corner"], entry["path"]))
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    files = [{"path": shown, "sha256": digest, "bytes": os.path.getsize(path), "role": "log"}]
    complete = True
    for lib in inputs.get("liberty") or []:
        lib_path = lib if os.path.isabs(lib) else os.path.join(root, lib)
        if not os.path.isfile(lib_path):
            complete = False
            diagnostics.append({"severity": "warning", "message": "the Liberty file {} is not there".format(lib), "source": "adapter"})
            continue
        header = orlog.liberty_conditions(lib_path)
        report.append("liberty {}: library {} voltage {} V temperature {} C process {}".format(
            lib, header["library"], header["voltage"], header["temperature"], header["process"]))
    return {"contract": CONTRACT, "status": "completed", "tool": {"name": "openroad", "version": None},
            "input_files": {"complete": complete, "files": files}, "outputs": [], "measurements": measurements,
            "diagnostics": diagnostics, "report": report}


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: openroad_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    response = parse(request) if request.get("operation") == "parse" else failure("unknown operation: {}".format(request.get("operation")))
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=1)
    os.replace(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
