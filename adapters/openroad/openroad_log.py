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
