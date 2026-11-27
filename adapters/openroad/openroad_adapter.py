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

Operation "timing". Inputs:
  log                a log or a report of a timing step (OpenSTA, or OpenROAD with report_checks, report_wns,
                     report_tns, report_worst_slack, report_check_types), relative to the design root; .gz is read
  clock_period_ns    optional; the clock period. Default: the period of the worst path report, else of a
                     create_clock line of the log
  max_slack_periods  optional (default 10): a worst slack more than this many clock periods negative is not a
                     timing result
  max_violations     optional (default 0): the max slew, max fanout and max capacitance violations of each kind
                     that can remain after a repair
It reads the file and runs no tool. The check has three results:
  not run        the log has no slack line and no path report (the timing tool did not read or link the design,
                 and the script that started it did not stop)
  invalid check  the worst slack is beyond max_slack_periods, or violations remain above max_violations (for example
                 a check before the placement, where repair_design inserted no buffer)
  valid          else
Measurements: timing_check (1 when valid; else failed, with the result and the reason), worst_slack_ns (measured
only when the check is valid), paths, slack_lines, worst_path_stages and worst_path_logic_depth (the cells of the
worst path; measured also for an invalid check), clock_period_ns, repair_buffers, and max_slew_violations,
max_fanout_violations, max_capacitance_violations when the log reports them. The response status is "failed" for
"not run" and for "invalid check": such a step is never recorded as a completed timing run.

Operation "spef". Inputs:
  spef               an extracted SPEF file, relative to the design root; .gz is read
  max_zero_fraction  optional (default 0.25): the share of the resistance segments that can be 0 ohm
It reads the file and runs no tool. The check is "invalid" when the file has no net, no resistance segment, only
segments of 0 ohm, or more segments of 0 ohm than max_zero_fraction. Measurements: spef_check (1 when valid; else
failed, with the reason), nets, res_segments, res_zero_segments, res_zero_fraction, res_total_ohm, cap_total_pf.
The response status is "failed" for an invalid file.
"""

import hashlib
import json
import os
import sys

import openroad_log as orlog
import openroad_spef as orspef

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


def input_file(request, key, what):
    """(path, shown, None) of an input file, or (None, None, a failure response)."""
    name = (request.get("inputs") or {}).get(key)
    if not isinstance(name, str) or not name:
        return None, None, failure("input '{}' is required: {}".format(key, what))
    path = name if os.path.isabs(name) else os.path.join(request["root"], name)
    if not os.path.isfile(path):
        return None, None, failure("the file {} is not there".format(name))
    return path, display(path, request["root"]), None


def hashed(path, shown, role):
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return {"complete": True, "files": [{"path": shown, "sha256": digest, "bytes": os.path.getsize(path), "role": role}]}


def number(inputs, key, default):
    value = inputs.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError("input '{}' must be a number that is not negative".format(key))
    return value


def not_measured(status, unit, reason):
    return {"value": None, "unit": unit, "status": status, "source": None, "reason": reason}


def timing(request):
    inputs = request.get("inputs") or {}
    path, shown, error = input_file(request, "log", "the path of a timing log or report")
    if error:
        return error
    try:
        limit = number(inputs, "max_slack_periods", orlog.MAX_SLACK_PERIODS)
        allowed = number(inputs, "max_violations", orlog.MAX_VIOLATIONS)
        period_in = number(inputs, "clock_period_ns", 0) or None
    except ValueError as e:
        return failure(str(e))
    text = orlog.read_text(path)
    report = orlog.timing_report(text)
    violations = orlog.design_violations(text)
    status, reasons = orlog.check_timing(report, violations, period_in, limit, allowed)
    period = period_in or report["period"]
    measurements, diagnostics, lines = {}, [], []
    reason = "{}: {}".format(status, "; ".join(reasons))
    measurements["timing_check"] = measured(1, "", shown) if status == "valid" else not_measured("failed", "", reason)
    worst = report["worst_slack"]
    if status == "valid" and worst is not None:
        measurements["worst_slack_ns"] = measured(worst, "ns", shown)
    else:
        measurements["worst_slack_ns"] = not_measured("missing" if status == "not run" else "failed", "ns",
                                                      reason if status != "valid" else "the log has path reports but no slack value")
    measurements["paths"] = measured(report["paths"], "", shown)
    measurements["slack_lines"] = measured(len(report["slack_lines"]), "", shown)
    if period:
        measurements["clock_period_ns"] = measured(period, "ns", "input" if period_in else shown)
    path_report = report["worst_path"]
    if path_report and path_report["stages"] is not None:
        source = "{}:{}".format(shown, path_report["line"])
        measurements["worst_path_stages"] = measured(path_report["stages"], "", source)
        measurements["worst_path_logic_depth"] = measured(path_report["logic_depth"], "", source)
        lines.append("worst path at line {}: {} -> {}, slack {:+.3f} ns, {} stages, logic depth {}".format(
            path_report["line"], path_report["startpoint"], path_report["endpoint"], path_report["slack"],
            path_report["stages"], path_report["logic_depth"]))
        lines.append("cells of the worst path: {}".format(" ".join(path_report["cells"][:60])))
    if violations["buffers"] is not None:
        measurements["repair_buffers"] = measured(violations["buffers"], "", shown)
    for kind, count in sorted(violations["remaining"].items()):
        measurements["max_{}_violations".format(kind)] = measured(count, "", shown)
    for kind, count in sorted(violations["found"].items()):
        lines.append("repair_design found {} {} violations".format(count, kind))
    for entry in report["summaries"]:
        lines.append("{}{} {:+.3f} (line {})".format(entry["kind"], " " + entry["check"] if entry["check"] else "", entry["value"], entry["line"]))
    lines.insert(0, "timing check: {}".format(status))
    if status != "valid":
        diagnostics.append({"severity": "error", "source": shown, "message": reason})
    if status == "invalid check" and path_report and path_report["stages"] is not None:
        diagnostics.append({"severity": "warning", "source": "{}:{}".format(shown, path_report["line"]), "message": (
            "do not report the slack of this check. What it shows is the logic of the worst path: {} stages, logic depth "
            "{}. Use that as a gate before the placement (compare it with the depth that the clock period allows), and "
            "take the slack from a run with placement and buffers.").format(path_report["stages"], path_report["logic_depth"])})
    return {"contract": CONTRACT, "status": "completed" if status == "valid" else "failed", "tool": {"name": "openroad", "version": None},
            "input_files": hashed(path, shown, "log"), "outputs": [], "measurements": measurements,
            "diagnostics": diagnostics, "report": lines}


def spef(request):
    inputs = request.get("inputs") or {}
    path, shown, error = input_file(request, "spef", "the path of an extracted SPEF file")
    if error:
        return error
    try:
        limit = number(inputs, "max_zero_fraction", orspef.MAX_ZERO_FRACTION)
    except ValueError as e:
        return failure(str(e))
    counts = orspef.read_spef(path)
    status, reason = orspef.check_spef(counts, limit)
    measurements = {"spef_check": measured(1, "", shown) if status == "valid" else not_measured("failed", "", "invalid: " + reason)}
    for name, key, unit in (("nets", "nets", ""), ("res_segments", "res_segments", ""), ("res_zero_segments", "res_zero_segments", ""),
                            ("res_total_ohm", "res_total_ohm", "ohm"), ("cap_total_pf", "cap_total_pf", "pF")):
        measurements[name] = measured(round(counts[key], 6), unit, shown)
    fraction = counts["res_zero_fraction"]
    measurements["res_zero_fraction"] = measured(round(fraction, 6), "", shown) if fraction is not None else not_measured(
        "missing", "", "the file has no resistance segment")
    lines = ["spef check: {}".format(status),
             "design {}, R unit {}, C unit {}".format(counts["design"], counts["r_unit"], counts["c_unit"]),
             "nets {} (with resistance segments {}, all segments 0 ohm {})".format(counts["nets"], counts["nets_with_res"], counts["nets_all_zero"])]
    diagnostics = []
    if status != "valid":
        diagnostics.append({"severity": "error", "source": shown, "message": "invalid: " + reason + (
            " Find where the extraction takes the layer resistance from (a rule file of the extractor, or the technology "
            "LEF with extract_parasitics -lef_res), and check that this source has resistance values. Do not report "
            "timing with this file as timing with extracted wires.")})
    return {"contract": CONTRACT, "status": "completed" if status == "valid" else "failed", "tool": {"name": "openroad", "version": None},
            "input_files": hashed(path, shown, "spef"), "outputs": [], "measurements": measurements,
            "diagnostics": diagnostics, "report": lines}


OPERATIONS = {"parse": parse, "timing": timing, "spef": spef}


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: openroad_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    operation = OPERATIONS.get(request.get("operation"))
    response = operation(request) if operation else failure("unknown operation: {}".format(request.get("operation")))
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=1)
    os.replace(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
