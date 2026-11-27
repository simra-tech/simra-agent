"""Reader for a LibreLane run directory (runs/<tag>): steps, fresh metrics of each step, the evidence level of
each timing number, the libraries that each corner loaded, and the difference between two runs.

Pure file reading. It has no PDK facts: corner names, library paths and variables come from the run itself.
"""

import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.realpath(__file__))


def _openroad_log():
    """The log readers of the openroad adapter: a sibling directory, or a directory of SIMRA_ADAPTER_DIRS."""
    candidates = []
    for entry in (os.environ.get("SIMRA_ADAPTER_DIRS") or "").split(":"):
        name, _, path = entry.partition("=")
        if name == "openroad" and path:
            candidates.append(path)
    candidates.append(os.path.join(os.path.dirname(HERE), "openroad"))
    for directory in candidates:
        if os.path.isfile(os.path.join(directory, "openroad_log.py")):
            if directory not in sys.path:
                sys.path.insert(0, directory)
            import openroad_log
            return openroad_log
    raise ImportError("the librelane adapter needs the openroad adapter (openroad_log.py); searched: " + ", ".join(candidates))


orlog = _openroad_log()
import openroad_spef as orspef  # noqa: E402  (a module of the openroad adapter, on sys.path after _openroad_log)

LEVELS = ("no_wires", "placement_estimate", "global_route", "extracted")
LEVEL_TEXT = {"no_wires": "no wires", "placement_estimate": "wires estimated from the placement",
              "global_route": "wires from the global route", "extracted": "extracted wires"}
VOLATILE = re.compile(r"(^|__)(runtime|memory|cpu|peak)", re.I)
NETLIST_KEYS = ("nl", "pnl")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def design_dir_of(run):
    """The design directory on this machine: the parent of the runs directory."""
    return os.path.dirname(os.path.dirname(os.path.abspath(run)))


def local_path(path, run):
    """The file of a path that the run recorded, on this machine. A run can be read at another place than the
    place where it was made (a container mount): then the recorded design directory is replaced with the present
    one. None when the file is not there."""
    if os.path.isfile(path):
        return path
    recorded = (load(os.path.join(run, "resolved.json")) or {}).get("DESIGN_DIR")
    if recorded and path.startswith(recorded.rstrip("/") + "/"):
        moved = os.path.join(design_dir_of(run), path[len(recorded.rstrip("/")) + 1:])
        if os.path.isfile(moved):
            return moved
    return None


def is_run(path):
    return os.path.isfile(os.path.join(path, "resolved.json")) and any(
        re.match(r"\d+-", n) for n in os.listdir(path))


def steps_of(run):
    """The steps of a run in order: [{index, name, dir, id, done, runtime, fresh, log}]. fresh is the dict of the
    metrics that this step computed (not the metrics that it carried over from the steps before it)."""
    steps = []
    for name in os.listdir(run):
        m = re.match(r"(\d+)-(.+)$", name)
        directory = os.path.join(run, name)
        if not m or not os.path.isdir(directory):
            continue
        config = load(os.path.join(directory, "config.json")) or {}
        step = {"index": int(m.group(1)), "name": name, "dir": directory,
                "id": (config.get("meta") or {}).get("step") or m.group(2),
                "done": os.path.isfile(os.path.join(directory, "state_out.json")),
                "variables": sorted(k for k in config if k != "meta")}
        try:
            with open(os.path.join(directory, "runtime.txt")) as f:
                step["runtime"] = f.read().strip()
        except OSError:
            step["runtime"] = None
        logs = sorted(n for n in os.listdir(directory) if n.endswith(".log"))
        step["log"] = os.path.join(directory, logs[0]) if logs else None
        step["fresh"] = _fresh(directory) if step["done"] else {}
        steps.append(step)
    return sorted(steps, key=lambda s: s["index"])


def _fresh(directory):
    own = load(os.path.join(directory, "or_metrics_out.json"))
    if isinstance(own, dict):
        return own
    state_in = load(os.path.join(directory, "state_in.json"))
    after = (load(os.path.join(directory, "state_out.json")) or {}).get("metrics") or {}
    corners = {n for n in os.listdir(directory) if os.path.isfile(os.path.join(directory, n, "sta.log"))}
    # Without the input state, no metric can be told from a carried one.
    before = (state_in or {}).get("metrics") or {}
    fresh = {k: v for k, v in after.items() if k not in before or before[k] != v} if isinstance(state_in, dict) else {}
    for key, value in after.items():
        if "corner:" in key and key.split("corner:")[-1] in corners:
            fresh[key] = value
    return fresh


def _has(steps, step, word):
    return any(word in s["id"] and s["done"] and s["index"] < step["index"] for s in steps)


def level_of(step, steps):
    """The evidence level of the timing and power numbers of a step, from the kind of the step and its place."""
    if step["id"].endswith("STAPrePNR"):
        return "no_wires"
    if step["id"].endswith("STAPostPNR"):
        return "extracted"
    if _has(steps, step, "GlobalRouting") or step["id"].endswith("GlobalRouting"):
        return "global_route"
    if _has(steps, step, "GlobalPlacement") or "Placement" in step["id"]:
        return "placement_estimate"
    return "no_wires"


def corners_of(run, steps):
    resolved = load(os.path.join(run, "resolved.json")) or {}
    corners = list(resolved.get("STA_CORNERS") or [])
    for step in steps:
        for key in step["fresh"]:
            if "corner:" in key and key.split("corner:")[-1] not in corners:
                corners.append(key.split("corner:")[-1])
    return corners, resolved.get("DEFAULT_CORNER")


def timing(run, steps):
    """One row for each corner and check: the last step that computed the worst slack, its value and its level.
    [{corner, check, value, step, level}]; value is None when no step computed it."""
    corners, _ = corners_of(run, steps)
    rows = []
    for corner in corners:
        for check in ("setup", "hold"):
            key = "timing__{}__ws__corner:{}".format(check, corner)
            last = None
            for step in steps:
                if step["done"] and key in step["fresh"]:
                    last = step
            rows.append({"corner": corner, "check": check, "value": last["fresh"][key] if last else None,
                         "step": last["name"] if last else None, "level": level_of(last, steps) if last else None})
    return rows


def carried(rows):
    """The findings about timing numbers of a lower level than the best level of the run: a list of texts."""
    known = [r for r in rows if r["level"]]
    if not known:
        return []
    best = max(LEVELS.index(r["level"]) for r in known)
    out = []
    low = {}
    for r in known:
        if LEVELS.index(r["level"]) < best:
            low.setdefault((r["step"], r["level"]), {}).setdefault(r["corner"], []).append(r)
    top = sorted({r["corner"] for r in known if LEVELS.index(r["level"]) == best})
    for (step, level), by_corner in sorted(low.items()):
        values = "; ".join("{}: {}".format(corner, ", ".join("{} {:+.3f} ns".format(r["check"], r["value"]) for r in group))
                           for corner, group in sorted(by_corner.items()))
        out.append(("the newest slack of {} corner(s) is from step {} ({}): {}. The later timing steps analysed only {}; "
                    "the metrics of the last state carry the old values. A number with {} for these corners needs "
                    "its own timing run (for example a replay of the last timing step with PNR_CORNERS set to the "
                    "corner).").format(len(by_corner), step, LEVEL_TEXT[level], values, ", ".join(top), LEVEL_TEXT[LEVELS[best]]))
    return out


def libraries(steps):
    """The Liberty files that the timing steps loaded, by corner: {corner: [path]} (from the step logs)."""
    loaded = {}
    for step in steps:
        logs = [step["log"]] if step["log"] else []
        logs += [os.path.join(step["dir"], n, "sta.log") for n in sorted(os.listdir(step["dir"]))
                 if os.path.isfile(os.path.join(step["dir"], n, "sta.log"))]
        if "STA" not in step["id"]:
            continue
        for log in logs:
            try:
                text = orlog.read_text(log)
            except OSError:
                continue
            for entry in orlog.library_loads(text):
                paths = loaded.setdefault(entry["corner"], [])
                if entry["path"] not in paths:
                    paths.append(entry["path"])
    return loaded


def label_findings(loaded, run):
    """The corners whose name does not agree with the header of a library that the corner loaded: texts."""
    out = []
    for corner, paths in sorted(loaded.items()):
        for path in paths:
            real = local_path(path, run)
            if real is None:
                continue
            try:
                header = orlog.liberty_conditions(real)
            except OSError:
                continue
            wrong = orlog.label_mismatch(corner, header)
            if wrong:
                out.append(("corner {} loaded {}, and the header of this file (library {}) gives {}. The numbers of "
                            "this corner are numbers at the conditions of the file, not of the corner name.").format(
                                corner, path, header.get("library"), " and ".join(wrong)))
    return out


def repair_findings(steps):
    out = []
    for step in steps:
        if not step["log"] or not re.search(r"Resizer|Repair", step["id"]):
            continue
        try:
            text = orlog.read_text(step["log"])
        except OSError:
            continue
        found = orlog.messages(text)
        for table in orlog.repair_tables(text):
            for finding in orlog.diagnose_repair(table, found):
                out.append({"step": step["name"], "line": table["line"], "pattern": finding["pattern"],
                            "message": "step {} ({} repair table at line {}): {}".format(
                                step["name"], table["kind"], table["line"], finding["message"])})
    return out


MAX_SPEF_BYTES = 200 * 1024 * 1024


def spef_files(steps):
    """The SPEF files that the steps of the run wrote (in the step directory, or one level below): [(step, path)]."""
    out = []
    for step in steps:
        found = []
        for base, dirs, names in os.walk(step["dir"]):
            if os.path.relpath(base, step["dir"]).count(os.sep) >= 1:
                dirs[:] = []
            found += [os.path.join(base, n) for n in names if n.endswith((".spef", ".spef.gz"))]
        out += [(step, path) for path in sorted(found)]
    return out


def spef_findings(steps, max_zero_fraction=None):
    """The resistance check of each SPEF file of the run: [{step, file, status, message}]. status is "valid",
    "invalid" or "not run" (a file above MAX_SPEF_BYTES is not read here)."""
    out = []
    limit = orspef.MAX_ZERO_FRACTION if max_zero_fraction is None else max_zero_fraction
    for step, path in spef_files(steps):
        name = os.path.join(step["name"], os.path.relpath(path, step["dir"]))
        if os.path.getsize(path) > MAX_SPEF_BYTES:
            out.append({"step": step["name"], "file": name, "status": "not run", "message": (
                "the resistance check of {} did not run: the file has {:.0f} MB (the limit of this read is {:.0f} MB). Run "
                "the openroad adapter, operation spef, on it.").format(name, os.path.getsize(path) / 1e6, MAX_SPEF_BYTES / 1e6)})
            continue
        try:
            counts = orspef.read_spef(path)
        except OSError:
            continue
        status, reason = orspef.check_spef(counts, limit)
        message = None
        if status == "invalid":
            message = ("the extracted file {} is invalid: {} The slack numbers of this run with extracted wires used it. "
                       "Find where the extraction takes the layer resistance from (the rule file of the extractor, or the "
                       "technology LEF), and check that this source has resistance values.").format(name, reason)
        out.append({"step": step["name"], "file": name, "status": status, "message": message})
    return out


def routing(steps):
    """The global-route usage of the last global routing step, die-wide and scaled to the core area:
    {step, usage_pct, core_area, die_area, core_usage_pct_estimate, overflow, wirelength_um} or None."""
    for step in reversed(steps):
        if not step["id"].endswith("GlobalRouting") or not step["log"]:
            continue
        try:
            table = orlog.global_route(orlog.read_text(step["log"]))
        except OSError:
            table = None
        if not table or not table["total"]:
            continue
        core, die = step["fresh"].get("design__core__area"), step["fresh"].get("design__die__area")
        out = {"step": step["name"], "usage_pct": table["total"]["usage_pct"], "overflow": table["total"]["overflow"],
               "wirelength_um": table["wirelength_um"], "core_area": core, "die_area": die,
               "core_usage_pct_estimate": None, "layers": table["congestion"]}
        if core and die and core > 0:
            out["core_usage_pct_estimate"] = round(table["total"]["usage_pct"] * die / core, 2)
        return out
    return None


def unfinished(run, steps):
    out = []
    for step in steps:
        if not step["done"]:
            out.append("step {} ({}) has no state_out.json: it did not end, or it failed. The metrics and views of "
                       "the run are those of the step before it.".format(step["name"], step["id"]))
    return out


def start_time(steps):
    times = [os.path.getmtime(os.path.join(s["dir"], "config.json")) for s in steps
             if os.path.isfile(os.path.join(s["dir"], "config.json"))]
    return min(times) if times else None


def design_inputs(run):
    """The design inputs that the run names (VERILOG_FILES and the SDC files), as files on this machine:
    [(role, path)]. An input that is not there is left out."""
    resolved = load(os.path.join(run, "resolved.json")) or {}
    design_dir = resolved.get("DESIGN_DIR") or design_dir_of(run)
    names = [("source", n) for n in (resolved.get("VERILOG_FILES") or [])]
    names += [("constraint", resolved.get(k)) for k in ("PNR_SDC_FILE", "SIGNOFF_SDC_FILE") if resolved.get(k)]
    out = []
    for role, name in names:
        if not isinstance(name, str):
            continue
        path = local_path(name if os.path.isabs(name) else os.path.join(design_dir, name), run)
        if path is not None and (role, path) not in out:
            out.append((role, path))
    return out


def changed_sources(run, steps):
    """The design inputs (VERILOG_FILES, the SDC files, the configuration) that are newer than the start of the
    run: texts. A run with a newer input is not a result for the present design."""
    started = start_time(steps)
    if started is None:
        return []
    root = design_dir_of(run)
    return [os.path.relpath(path, root) for _, path in design_inputs(run) if os.path.getmtime(path) > started + 1]


# ------------------------------------------------------------------ comparison of two runs

def _signature(step):
    state = load(os.path.join(step["dir"], "state_out.json")) or {}
    files = {}
    for key in NETLIST_KEYS:
        path = state.get(key)
        if isinstance(path, str):
            local = os.path.join(step["dir"], os.path.basename(path))
            if os.path.dirname(path).endswith(step["name"]) and os.path.isfile(local):
                files[key] = sha256(local)
    metrics = {k: v for k, v in step["fresh"].items() if not VOLATILE.search(k)}
    return files, metrics


def settings_diff(a, b):
    ra, rb = load(os.path.join(a, "resolved.json")) or {}, load(os.path.join(b, "resolved.json")) or {}
    return {k: (ra.get(k), rb.get(k)) for k in sorted(set(ra) | set(rb))
            if ra.get(k) != rb.get(k) and k not in ("meta",)}


def compare(run, against):
    """Compare two runs: {settings, first_reader, first_difference, differences, verdict, message}.

    verdict: "same_settings", "no_effect" (settings differ, every common step gives the same netlists and metrics),
    "effect" (the first difference is at or after the first step that reads a changed setting), or "other_input"
    (the first difference is before that step: something else differs, for example the RTL).
    """
    a, b = steps_of(against), steps_of(run)
    settings = settings_diff(against, run)
    by_index = {s["index"]: s for s in a}
    first_reader = None
    for step in b:
        if any(k in step["variables"] for k in settings):
            first_reader = step
            break
    differences = []
    common = 0
    for step in b:
        other = by_index.get(step["index"])
        if other is None or other["id"] != step["id"] or not (step["done"] and other["done"]):
            continue
        common += 1
        files_b, metrics_b = _signature(step)
        files_a, metrics_a = _signature(other)
        keys = [k for k in sorted(set(metrics_a) | set(metrics_b)) if metrics_a.get(k) != metrics_b.get(k)]
        views = [k for k in sorted(set(files_a) | set(files_b)) if files_a.get(k) != files_b.get(k)]
        if keys or views:
            differences.append({"step": step["name"], "index": step["index"], "views": views,
                                "metrics": {k: (metrics_a.get(k), metrics_b.get(k)) for k in keys}})
    first = differences[0] if differences else None
    names = ", ".join("{} ({} -> {})".format(k, json.dumps(v[0]), json.dumps(v[1])) for k, v in list(settings.items())[:6])
    if not settings:
        verdict, message = "same_settings", "the two runs have the same resolved settings."
    elif first is None:
        verdict = "no_effect"
        message = ("the settings differ ({}), but all {} common steps give the same netlists and the same metrics: "
                   "the change had no effect on the result. Do not record it as a change of the design. Check how "
                   "the flow script uses the variable (unit, rounding, a condition), or test the tool option "
                   "directly.").format(names, common)
    elif first_reader is not None and first["index"] < first_reader["index"]:
        verdict = "other_input"
        message = ("the settings differ ({}), and the first step that reads one of them is {}. But the runs differ "
                   "from step {} on, before that step: another input differs between the runs (for example the "
                   "RTL or a constraint). The difference of the results is not the effect of the setting. Compare "
                   "with a run of the present inputs without the setting.").format(names, first_reader["name"], first["step"])
    else:
        verdict = "effect"
        message = "the settings differ ({}); the results differ from step {} on.".format(names, first["step"])
    return {"settings": settings, "first_reader": first_reader["name"] if first_reader else None,
            "first_difference": first["step"] if first else None, "differences": differences, "common_steps": common,
            "verdict": verdict, "message": message}


def sibling_runs(run):
    parent = os.path.dirname(os.path.abspath(run))
    out = []
    for name in sorted(os.listdir(parent)):
        path = os.path.join(parent, name)
        if os.path.isdir(path) and os.path.abspath(path) != os.path.abspath(run) and is_run(path):
            out.append(path)
    return out


def nearest_sibling(run, limit=6):
    """The sibling run with the fewest changed settings (at least one, at most limit); the newest wins a tie."""
    best = None
    for other in sibling_runs(run):
        count = len(settings_diff(other, run))
        if 1 <= count <= limit:
            key = (count, -os.path.getmtime(os.path.join(other, "resolved.json")))
            if best is None or key < best[0]:
                best = (key, other)
    return best[1] if best else None
