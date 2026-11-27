"""Readers for OpenROAD logs and Liberty headers. Pure text parsing: no tool run, no PDK facts.

The functions return plain data (dict and list). The openroad adapter and the librelane adapter use them.
"""

import gzip
import re

MESSAGE = re.compile(r"^\[(INFO|WARNING|ERROR|CRITICAL)\s+([A-Z]+-\d+)\]\s*(.*)$")
NUMBER = r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"
LIB_LOAD = re.compile(r"Reading (?:timing|cell) library for the '([^']+)' corner at '([^']+)'")
ENDPOINTS = re.compile(r"Found (\d+) endpoints with (hold|setup) violations")
INSERTED = re.compile(r"Inserted (\d+) (hold )?buffers")
CORNER_NAME = re.compile(r"^(?P<rc>[a-z]+)_(?P<process>[a-z]+)_(?P<v>\d+)p(?P<vf>\d+)V_(?P<m>m?)(?P<t>\d+)C$")


def read_text(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", errors="replace") as f:
        return f.read()


def messages(text):
    """The tool messages with a code, in order of the first use: [{code, severity, count, line, text}]."""
    found = {}
    for number, line in enumerate(text.splitlines(), 1):
        m = MESSAGE.match(line.strip())
        if not m:
            continue
        severity, code, body = m.groups()
        entry = found.setdefault(code, {"code": code, "severity": severity.lower(), "count": 0, "line": number, "text": body})
        entry["count"] += 1
    return list(found.values())


def _cells(line):
    return [c.strip() for c in line.split("|")]


def _number(cell):
    m = re.search(NUMBER, cell.replace("%", ""))
    return float(m.group(0)) if m else None


def repair_tables(text):
    """The progress tables of repair_timing and repair_design.

    Each table: {kind, line, columns, rows, final, endpoints_found, inserted_buffers}. A row is a dict with the
    iteration (an integer, or "final") and one number for each column that the table has (wns, tns, buffers, ...).
    """
    lines = text.splitlines()
    tables = []
    kind = None
    endpoints = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if "repair_timing" in line and line.lstrip().startswith("+"):
            kind = "hold" if re.search(r"\s-hold\b", line) else "setup" if re.search(r"\s-setup\b", line) else "timing"
            endpoints = None
        elif "repair_design" in line and line.lstrip().startswith("+"):
            kind, endpoints = "design", None
        m = ENDPOINTS.search(line)
        if m:
            endpoints, kind = int(m.group(1)), m.group(2)
        if re.match(r"\s*Iter(ation)?\s*\|", line):
            columns = [re.sub(r"[^a-z0-9]+", "_", c.lower()).strip("_") for c in _cells(line)]
            table = {"kind": kind or "timing", "line": i + 1, "columns": columns, "rows": [], "final": None,
                     "endpoints_found": endpoints, "inserted_buffers": None}
            i += 1
            while i < len(lines):
                row = lines[i]
                if re.match(r"\s*-{10,}\s*$", row):
                    if table["rows"] or table["final"]:
                        break
                    i += 1
                    continue
                if "|" not in row:
                    break
                cells = _cells(row)
                first = cells[0].rstrip("*").strip()
                entry = {"iteration": "final" if first == "final" else int(first) if first.isdigit() else first}
                for name, cell in zip(columns[1:], cells[1:]):
                    entry[name] = cell if name in ("endpoint", "worst_endpoint") else _number(cell)
                if entry["iteration"] == "final":
                    table["final"] = entry
                else:
                    table["rows"].append(entry)
                i += 1
            for after in lines[i:i + 8]:
                m = INSERTED.search(after)
                if m:
                    table["inserted_buffers"] = int(m.group(1))
                    break
            tables.append(table)
            endpoints = None
        i += 1
    return tables


def _column(table, *names):
    for name in names:
        if name in table["columns"]:
            return name
    return None


def diagnose_repair(table, found_messages=()):
    """Name the pattern of a repair table that did not close: [{pattern, message}]. An empty list means that the
    table shows no known pattern, or that the repair closed."""
    codes = {m["code"] for m in found_messages}
    final = table["final"] or (table["rows"][-1] if table["rows"] else None)
    if final is None:
        return []
    wns = final.get("wns")
    buffers_column = _column(table, "buffers", "inserted_buffers")
    buffers = final.get(buffers_column) if buffers_column else table["inserted_buffers"]
    out = []
    closed = wns is not None and wns >= 0
    if closed:
        if "RSZ-0064" in codes or "RSZ-0062" in codes:
            out.append({"pattern": "margin_only", "message": (
                "the last row has worst slack {:+.3f} ns and no negative slack: all {} checks are met. The message "
                "'unable to repair ... within margin' is about the repair margin only.").format(wns, table["kind"])})
        return out
    if "RSZ-0060" in codes:
        out.append({"pattern": "buffer_limit", "message": (
            "the repair stopped at the maximum buffer count ({} buffers, message RSZ-0060). The limit is a per cent "
            "of the instance count (-max_buffer_percent). The worst slack was still {} ns: the table ends at the "
            "limit, not at a circuit limit.").format(_int(buffers), _fmt(wns))})
    found = table["endpoints_found"]
    if table["kind"] == "hold" and found and buffers is not None and abs(buffers - found) <= max(1, 0.001 * found):
        out.append({"pattern": "one_pass_per_endpoint", "message": (
            "the hold repair made one pass for each violating end point ({} end points, {} buffers) and then "
            "stopped with worst slack {} ns. One sweep is not a circuit limit: a second repair of the output of "
            "this step, or fewer violating end points at the start, continues the repair.").format(
                found, _int(buffers), _fmt(wns))})
    rows = [r for r in table["rows"] if isinstance(r.get("wns"), float)]
    if len(rows) >= 6:
        last = rows[-1]["wns"]
        flat_from = None
        for r in rows:
            if abs(r["wns"] - last) < 5e-4:
                flat_from = r["iteration"] if flat_from is None else flat_from
            else:
                flat_from = None
        flat_rows = [r for r in rows if flat_from is not None and isinstance(r["iteration"], int)
                     and isinstance(flat_from, int) and r["iteration"] >= flat_from]
        if flat_from is not None and len(flat_rows) >= max(4, len(rows) // 3):
            out.append({"pattern": "worst_slack_constant", "message": (
                "the worst slack stays at {} ns from iteration {} to the end ({} rows of {}): the passes after that "
                "do not move the worst path.").format(_fmt(last), flat_from, len(flat_rows), len(rows))})
    return out


def _int(value):
    return "?" if value is None else str(int(value))


def _fmt(value):
    return "?" if value is None else "{:+.3f}".format(value)


def global_route(text):
    """The resource and congestion tables of global_route: {resources, congestion, total, wirelength_um,
    adjustment_pct, line}. None when the log has no congestion report."""
    lines = text.splitlines()
    out = {"resources": [], "congestion": [], "total": None, "wirelength_um": None, "adjustment_pct": None, "line": None}
    mode = None
    for number, line in enumerate(lines, 1):
        if "Routing resources analysis" in line:
            mode = "resources"
            continue
        if "Final congestion report" in line:
            mode, out["line"] = "congestion", number
            out["congestion"], out["total"] = [], None
            continue
        m = re.search(r"Global adjustment:\s*(" + NUMBER + r")%", line)
        if m:
            out["adjustment_pct"] = float(m.group(1))
        m = re.search(r"Total wirelength:\s*(" + NUMBER + r")\s*um", line)
        if m:
            out["wirelength_um"] = float(m.group(1))
        if mode is None or not line.strip() or set(line.strip()) == {"-"}:
            continue
        if line.startswith("["):
            mode = None
            continue
        words = line.split()
        if mode == "resources" and len(words) == 5 and words[2].isdigit():
            out["resources"].append({"layer": words[0], "direction": words[1], "original": int(words[2]),
                                     "derated": int(words[3]), "reduction_pct": float(words[4].rstrip("%"))})
        elif mode == "congestion" and len(words) >= 9 and words[1].isdigit():
            row = {"layer": words[0], "resource": int(words[1]), "demand": int(words[2]),
                   "usage_pct": float(words[3].rstrip("%")), "overflow": int(words[-1])}
            if words[0] == "Total":
                out["total"] = row
            else:
                out["congestion"].append(row)
    return out if out["line"] else None


def library_loads(text):
    """The Liberty files that the log says it read: [{corner, path}], in order, without repeats."""
    seen = []
    for m in LIB_LOAD.finditer(text):
        entry = {"corner": m.group(1), "path": m.group(2)}
        if entry not in seen:
            seen.append(entry)
    return seen


def liberty_conditions(path, limit=400):
    """The header of a Liberty file: {library, process, voltage, temperature, operating_conditions}. It reads the
    first lines only (the header is before the first cell)."""
    out = {"library": None, "process": None, "voltage": None, "temperature": None, "operating_conditions": None}
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", errors="replace") as f:
        for number, line in enumerate(f):
            if number >= limit or re.match(r"\s*cell\s*\(", line):
                break
            m = re.match(r"\s*library\s*\(\s*\"?([^\")\s]+)", line)
            if m and out["library"] is None:
                out["library"] = m.group(1)
            for key, name in (("nom_process", "process"), ("nom_voltage", "voltage"), ("nom_temperature", "temperature")):
                m = re.match(r"\s*" + key + r"\s*:\s*(" + NUMBER + r")", line)
                if m:
                    out[name] = float(m.group(1))
            m = re.match(r"\s*default_operating_conditions\s*:\s*\"?([^\";\s]+)", line)
            if m:
                out["operating_conditions"] = m.group(1)
    return out


def corner_conditions(corner):
    """The conditions that a corner name of the form nom_slow_1p08V_125C states: {process, voltage, temperature},
    or None when the name has another form."""
    m = CORNER_NAME.match(corner)
    if not m:
        return None
    temperature = float(m.group("t")) * (-1 if m.group("m") else 1)
    return {"process": m.group("process"), "voltage": float("{}.{}".format(m.group("v"), m.group("vf"))),
            "temperature": temperature}


def label_mismatch(corner, header, v_tol=0.011, t_tol=0.6):
    """The differences between the conditions in a corner name and the header of the library that the corner loads:
    a list of texts, empty when they agree or when the name or the header gives no conditions."""
    stated = corner_conditions(corner)
    if not stated:
        return []
    out = []
    if header.get("voltage") is not None and abs(header["voltage"] - stated["voltage"]) > v_tol:
        out.append("voltage {:g} V (the corner name says {:g} V)".format(header["voltage"], stated["voltage"]))
    if header.get("temperature") is not None and abs(header["temperature"] - stated["temperature"]) > t_tol:
        out.append("temperature {:g} C (the corner name says {:g} C)".format(header["temperature"], stated["temperature"]))
    return out


# ------------------------------------------------------------------ timing reports

SLACK_LINE = re.compile(r"^\s*(" + NUMBER + r")\s+slack \((MET|VIOLATED)\)\s*$")
SUMMARY_LINE = re.compile(r"^\s*(wns|tns|worst slack)\s+(?:(max|min)\s+)?(" + NUMBER + r")\s*$")
CLOCK_EDGE = re.compile(r"^\s*(" + NUMBER + r")\s+(" + NUMBER + r")\s+clock (\S+) \((rise|fall) edge\)")
PATH_ROW = re.compile(r"^\s*(?:" + NUMBER + r"\s+)*(" + NUMBER + r")\s+(" + NUMBER + r")\s+[v^]\s+(\S+)\s+\(([^)]+)\)\s*$")
CREATE_CLOCK = re.compile(r"create_clock\b[^\n]*?-period\s+(" + NUMBER + r")")
# The messages of a timing tool that could not read or link its design: no timing follows them.
NO_DESIGN = re.compile(r"syntax error|is not a verilog module|[Nn]o such file|[Cc]annot (open|read)|not found|"
                       r"link_design|No design|no network has been linked|Error:", re.I)
VIOLATION_COUNT = re.compile(r"^\s*max (slew|fanout|cap(?:acitance)?) violation(?:s)? count\s+(\d+)", re.I)
FOUND_VIOLATIONS = re.compile(r"Found (\d+) (slew|fanout|capacitance|long wire) violations")
CHECK_HEADING = re.compile(r"^\s*max (slew|fanout|capacitance)\s*$")
VIOLATOR_ROW = re.compile(r"\(VIOLATED\)\s*$")
BUFFERS_INSERTED = re.compile(r"Inserted (\d+) buffers(?: in (\d+) nets)?")
KIND = {"cap": "capacitance", "capacitance": "capacitance", "slew": "slew", "fanout": "fanout"}


def timing_report(text):
    """The timing results that a log or a report has: {slack_lines, paths, summaries, worst_slack, worst_path,
    period, first_problem}.

    slack_lines: the 'slack (MET)' and 'slack (VIOLATED)' lines [{value, met, line}]; paths: the count of path reports
    (a 'Startpoint:' line); summaries: the lines of report_wns, report_tns and report_worst_slack
    [{kind, check, value, line}]; worst_slack: the lowest slack of all these lines (not tns), or None; worst_path:
    the path report of the lowest slack line (see _path); period: the clock period of that path, from its two clock
    edge rows, else from a create_clock line of the log, else None; first_problem: the first line that tells why a
    timing tool has no design (a syntax error, a module that is not found), or None.
    """
    lines = text.splitlines()
    slack_lines, summaries, starts = [], [], []
    first_problem = None
    for number, line in enumerate(lines, 1):
        m = SLACK_LINE.match(line)
        if m:
            slack_lines.append({"value": float(m.group(1)), "met": m.group(2) == "MET", "line": number})
            continue
        m = SUMMARY_LINE.match(line)
        if m:
            summaries.append({"kind": m.group(1).replace("worst slack", "worst_slack"), "check": m.group(2), "value": float(m.group(3)), "line": number})
            continue
        if line.startswith("Startpoint:"):
            starts.append(number)
        elif first_problem is None and NO_DESIGN.search(line) and not line.lstrip().startswith(("#", "+", "%")):
            first_problem = {"line": number, "text": line.strip()[:200]}
    values = [s["value"] for s in slack_lines] + [s["value"] for s in summaries if s["kind"] != "tns"]
    worst_path = None
    if slack_lines:
        worst = min(slack_lines, key=lambda s: s["value"])
        before = [n for n in starts if n < worst["line"]]
        if before:
            worst_path = _path(lines, before[-1], worst["line"])
            worst_path["slack"] = worst["value"]
    period = worst_path["period"] if worst_path and worst_path["period"] else None
    if period is None:
        m = CREATE_CLOCK.search(text)
        period = float(m.group(1)) if m else None
    return {"slack_lines": slack_lines, "paths": len(starts), "summaries": summaries,
            "worst_slack": min(values) if values else None, "worst_path": worst_path, "period": period,
            "first_problem": first_problem}


def _path(lines, start, end):
    """One path report (from its 'Startpoint:' line to its slack line): {line, startpoint, endpoint, period, stages,
    logic_depth, cells}. stages: the cells with a delay on the data path, the launch cell included; logic_depth: the
    cells between the start point and the end point; cells: the cell name of each stage, in order."""
    out = {"line": start, "startpoint": None, "endpoint": None, "period": None, "stages": None, "logic_depth": None, "cells": []}
    edges = []
    instances = []
    arrived = False
    for line in lines[start - 1:end]:
        if line.startswith("Startpoint:"):
            out["startpoint"] = line.split()[1]
        elif line.startswith("Endpoint:"):
            out["endpoint"] = line.split()[1]
        m = CLOCK_EDGE.match(line)
        if m:
            edges.append(float(m.group(2)))
        if "data arrival time" in line:
            arrived = True
        m = PATH_ROW.match(line)
        if m and not arrived:
            pin, cell = m.group(3), m.group(4)
            instance = pin.rsplit("/", 1)[0] if "/" in pin else None
            # A row of a port ('x[3] (in)') or of a net is not a cell.
            if instance is None or cell in ("in", "out", "net"):
                continue
            if not instances or instances[-1][0] != instance:
                instances.append((instance, cell))
    if len(edges) >= 2 and edges[-1] > edges[0]:
        out["period"] = edges[-1] - edges[0]
    if instances:
        # The last instance is the end point when the path ends at a pin of a cell (a flip-flop input).
        ends_at_cell = out["endpoint"] is not None and instances[-1][0] == out["endpoint"]
        data = instances[:-1] if ends_at_cell else instances
        out["stages"] = len(data)
        starts_at_cell = out["startpoint"] is not None and data and data[0][0] == out["startpoint"]
        out["logic_depth"] = len(data) - (1 if starts_at_cell else 0)
        out["cells"] = [cell for _, cell in data]
    return out


def design_violations(text):
    """The slew, fanout and capacitance violations that a log reports, before and after a repair:
    {found: {kind: count} (repair_design 'Found N ... violations', before the repair), remaining: {kind: count}
    (the violator tables of report_check_types and the 'violation count' lines, after the repair; a kind that the log
    does not report is not in the dict), buffers (the buffers that the repair inserted, or None), repair_line}."""
    lines = text.splitlines()
    found, remaining = {}, {}
    buffers, repair_line = None, None
    heading = None
    rows = 0
    for number, line in enumerate(lines, 1):
        if "repair_design" in line and repair_line is None:
            repair_line = number
        m = FOUND_VIOLATIONS.search(line)
        if m:
            found[m.group(2)] = found.get(m.group(2), 0) + int(m.group(1))
            repair_line = repair_line or number
        m = BUFFERS_INSERTED.search(line)
        if m and "hold" not in line:
            buffers = (buffers or 0) + int(m.group(1))
        m = VIOLATION_COUNT.match(line)
        if m:
            remaining[KIND[m.group(1).lower()]] = int(m.group(2))
            continue
        m = CHECK_HEADING.match(line)
        if m:
            if heading is not None:
                remaining[heading] = max(remaining.get(heading, 0), rows)
            heading, rows = m.group(1), 0
            continue
        if heading is not None:
            if VIOLATOR_ROW.search(line):
                rows += 1
            elif line.startswith("[") or line.startswith("Startpoint:") or SUMMARY_LINE.match(line):
                remaining[heading] = max(remaining.get(heading, 0), rows)
                heading = None
    if heading is not None:
        remaining[heading] = max(remaining.get(heading, 0), rows)
    if buffers is None:
        # repair_design prints no 'Inserted' line when it inserts no buffer: the last row of its table has the count.
        for table in repair_tables(text):
            last = table["final"] or (table["rows"][-1] if table["rows"] else None)
            if "nets_repaired" in table["columns"] and last and last.get("buffers") is not None:
                buffers = int(last["buffers"])
                repair_line = repair_line or table["line"]
    return {"found": found, "remaining": remaining, "buffers": buffers, "repair_line": repair_line}


# A slack below this multiple of the clock period (negative) is not a timing result: a path cannot be that slow in a
# circuit that works at all. It is the mark of a net that the check did not model (no buffers, no placement).
MAX_SLACK_PERIODS = 10.0
# The slew, fanout and capacitance violations that can remain after a repair in a check that counts as a timing result.
MAX_VIOLATIONS = 0


def check_timing(report, violations, clock_period=None, max_slack_periods=MAX_SLACK_PERIODS, max_violations=MAX_VIOLATIONS):
    """The verdict of a timing log: (status, reasons). status: "not run" (the log has no slack line and no path
    report), "invalid check" (the numbers are there, but they are not timing results), or "valid"."""
    if not report["slack_lines"] and not report["summaries"] and not report["paths"]:
        why = report["first_problem"]
        return "not run", ["the log has no slack line and no path report: the timing step produced no timing" + (
            ". First problem in the log, line {}: {}".format(why["line"], why["text"]) if why else "")]
    reasons = []
    period = clock_period if clock_period else report["period"]
    worst = report["worst_slack"]
    if worst is not None and period and worst < -max_slack_periods * period:
        reasons.append(("the worst slack is {:+.3f} ns, {:.1f} clock periods negative (period {:g} ns; the limit is {:g} "
                        "periods): this is not a timing result").format(worst, -worst / period, period, max_slack_periods))
    left = {k: v for k, v in violations["remaining"].items() if v > max_violations}
    if left:
        repaired = violations["repair_line"] is not None
        reasons.append("{}: {} (the limit is {}){}".format(
            "after repair_design these violations remain" if repaired else "the report has these violations",
            ", ".join("{} max {}".format(v, k) for k, v in sorted(left.items())), max_violations,
            "; the repair inserted {} buffers".format(violations["buffers"] or 0) if repaired else ""))
    return ("invalid check", reasons) if reasons else ("valid", [])
