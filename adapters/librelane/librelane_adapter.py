#!/usr/bin/env python3
"""LibreLane adapter for Simra Agent (contract simra.adapter/0).

Usage: librelane_adapter.py <request.json>

Operation "read". Inputs:
  run       a run directory of LibreLane (runs/<tag>), relative to the design root
  against   optional; a second run directory: the read adds the comparison with it (see "compare"). The value
            "auto" takes the sibling run with the fewest different settings.
  launcher  optional; a list of files that started the run (a flow script, a job list): their hashes go into the record
The record (input_files) has the hashes of resolved.json, of the last state, of the design inputs that the run names
(VERILOG_FILES and the SDC files, as they are now) and of the launcher files.
It reads the files of the run and runs no tool. Measurements: for each corner the worst setup and hold slack
(setup_ws_ns@<corner>, hold_ws_ns@<corner>), each from the last step that computed it, with the evidence level of
that step in "level" (no_wires, placement_estimate, global_route, extracted) and the step in "source"; steps,
steps_not_done, instances, utilization, clock_buffers, timing_repair_buffers, route_usage_pct (die-wide),
core_route_usage_pct_estimate, route_overflow; spef_files and spef_files_invalid when the run has extracted SPEF
files. Diagnostics (warnings): an extracted SPEF file without wire resistance (no resistance segment, only segments
of 0 ohm, or too many of them; see the openroad adapter, operation spef); a corner whose newest slack has a lower
level than the newest level of the run; a corner name that does not agree with the header of the library that the
corner loaded; a step that did not end; a repair table with a known pattern; a design input that is newer than
the run; a comparison that shows no effect of a changed setting, or a difference that the setting cannot cause.

Operation "compare". Inputs: run, against (two run directories). Measurements: settings_changed, steps_compared,
steps_different, effect (1: the results differ at or after the first step that reads a changed setting; 0: no
step differs; failed: the runs differ before that step, so the comparison does not show the effect of the setting).

Operation "replay". Inputs:
  run       a run directory
  step      a step of the run: its number (37), its directory name, or its id when the id is used once
  set       optional; an object of flow variables to change for this step (for example {"PNR_CORNERS": [...]})
  state_in  optional; the state_in.json or state_out.json to start from (default: state_in.json of the step). The
            state_out.json of an earlier replay (simra/experiments/<id>/work/out/state_out.json) chains two replays.
It runs this one step again with `python3 -m librelane.steps run`, on the saved input state of the step, in the
work directory. The run directory is not changed. It puts the tool directory of the `librelane` launcher first in
PATH, as the launcher does. Measurements: the metrics that the replay computed and that differ from the metrics of
the step in the run (name, value; the old value is in the report), metrics_changed, views_changed, runtime_s.
A replay with "set" that changes no metric and no netlist gives a warning: the setting has no effect at this step.
A variable in "set" that the step does not read fails the request before the run, with the steps that read it.

Operation "preflight". Inputs: tools (optional; a list of tool names, default all known), pdk_root and pdk (optional;
default $PDK_ROOT and $PDK), min_free_gb (optional, default 5). It starts the version command of each flow tool with
the PATH of the librelane launcher, lists the views of each library of the PDK (counts of lib, lef, gds and verilog
files), and checks the free space of the design root and a write to the work directory. Measurements: tools_ok,
tools_failed, pdk_libraries, disk_free_gb, writable. Warnings: a tool that is not found or does not start; two builds
of a tool with different versions (the launcher PATH and the default PATH); a PDK that is not found; low free space;
a failed write.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

import librelane_run as run_reader
from librelane_run import orlog

CONTRACT = "simra.adapter/0"
MAX_REPORT = 60


def display(path, root):
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    return path if rel.startswith("..") else rel


def file_entry(path, root, role=None):
    entry = {"path": display(path, root), "sha256": run_reader.sha256(path), "bytes": os.path.getsize(path)}
    if role:
        entry["role"] = role
    return entry


def tool():
    version = None
    try:
        import importlib.metadata as metadata
        version = metadata.version("librelane")
    except Exception:
        version = None
    return {"name": "librelane", "version": version}


def failure(message, measurements=None):
    return {"contract": CONTRACT, "status": "failed", "tool": tool(), "input_files": None, "outputs": [],
            "measurements": measurements or {}, "diagnostics": [{"severity": "error", "message": message, "source": "adapter"}]}


def warning(message, source):
    return {"severity": "warning", "message": message, "source": source}


def measured(value, unit, source, **more):
    out = {"value": value, "unit": unit, "status": "measured", "source": source}
    out.update(more)
    return out


def missing(unit, reason):
    return {"value": None, "unit": unit, "status": "missing", "source": None, "reason": reason}


def run_dir(request, key="run"):
    name = (request.get("inputs") or {}).get(key)
    if not isinstance(name, str) or not name:
        return None, "input '{}' is required: a LibreLane run directory (for example runs/<tag>)".format(key)
    path = name if os.path.isabs(name) else os.path.join(request["root"], name)
    if not os.path.isdir(path) or not run_reader.is_run(path):
        return None, "'{}' is not a LibreLane run directory (no resolved.json and numbered step directories)".format(name)
    return path, None


def inputs_of(run, steps, root, launchers=None):
    files = []
    for name in ("resolved.json",):
        if os.path.isfile(os.path.join(run, name)):
            files.append(file_entry(os.path.join(run, name), root, "config"))
    if steps:
        last = [s for s in steps if s["done"]]
        if last:
            files.append(file_entry(os.path.join(last[-1]["dir"], "state_out.json"), root, "state"))
    seen = set()
    for role, path in run_reader.design_inputs(run):
        if path not in seen:
            seen.add(path)
            files.append(file_entry(path, root, role))
    complete = True
    for name in launchers or []:
        path = name if os.path.isabs(name) else os.path.join(root, name)
        if os.path.isfile(path):
            files.append(file_entry(path, root, "launcher"))
        else:
            complete = False
    return {"complete": complete, "files": files}


def compare_diagnostic(result, run, against, root):
    source = "{} against {}".format(display(run, root), display(against, root))
    if result["verdict"] in ("no_effect", "other_input"):
        return warning("{}: {}".format(source, result["message"]), source)
    return {"severity": "info", "message": "{}: {}".format(source, result["message"]), "source": source}


def read(request):
    root = request["root"]
    run, error = run_dir(request)
    if error:
        return failure(error)
    steps = run_reader.steps_of(run)
    rows = run_reader.timing(run, steps)
    measurements, diagnostics, report = {}, [], []
    done = [s for s in steps if s["done"]]
    measurements["steps"] = measured(len(steps), "", display(run, root))
    measurements["steps_not_done"] = measured(len(steps) - len(done), "", display(run, root))
    for row in rows:
        name = "{}_ws_ns@{}".format(row["check"], row["corner"])
        if row["value"] is None:
            measurements[name] = missing("ns", "no step of the run computed it")
        else:
            measurements[name] = measured(round(row["value"], 6), "ns", "{} ({})".format(
                row["step"], run_reader.LEVEL_TEXT[row["level"]]), level=row["level"])
    last = done[-1] if done else None
    state = ((run_reader.load(os.path.join(last["dir"], "state_out.json")) or {}).get("metrics") or {}) if last else {}
    for name, key, unit in (("instances", "design__instance__count", ""), ("utilization", "design__instance__utilization", ""),
                            ("clock_buffers", "design__instance__count__class:clock_buffer", ""),
                            ("timing_repair_buffers", "design__instance__count__class:timing_repair_buffer", "")):
        source = next((s["name"] for s in reversed(done) if key in s["fresh"]), None)
        measurements[name] = measured(state[key], unit, source) if key in state and source else missing(unit, "not in the metrics of the run")
    route = run_reader.routing(steps)
    if route:
        measurements["route_usage_pct"] = measured(route["usage_pct"], "%", route["step"] + " (all routing resources of the die)")
        measurements["route_overflow"] = measured(route["overflow"], "", route["step"])
        if route["core_usage_pct_estimate"] is not None:
            measurements["core_route_usage_pct_estimate"] = measured(
                route["core_usage_pct_estimate"], "%",
                "{}: usage x die area / core area ({:g} / {:g} um2); an upper estimate".format(route["step"], route["die_area"], route["core_area"]))
            if route["die_area"] / route["core_area"] > 1.25:
                diagnostics.append(warning(
                    ("step {}: the usage of the congestion report ({:.2f} %) is over all routing resources of the die. "
                     "The core is {:.0f} % of the die area, so the usage in the core is higher: at most about {:.1f} % (usage x "
                     "die area / core area, with all wires inside the core). State which of the two a number is.").format(
                         route["step"], route["usage_pct"], 100 * route["core_area"] / route["die_area"],
                         route["core_usage_pct_estimate"]), route["step"]))
    for text in run_reader.unfinished(run, steps):
        diagnostics.append(warning(text, display(run, root)))
    for text in run_reader.carried(rows):
        diagnostics.append(warning(text, display(run, root)))
    for text in run_reader.label_findings(run_reader.libraries(steps), run):
        diagnostics.append(warning(text, display(run, root)))
    for finding in run_reader.repair_findings(steps):
        diagnostics.append(warning(finding["message"], "{}:{}".format(finding["step"], finding["line"])))
    extracted = run_reader.spef_findings(steps)
    if extracted:
        measurements["spef_files"] = measured(len(extracted), "", display(run, root))
        measurements["spef_files_invalid"] = measured(sum(1 for e in extracted if e["status"] == "invalid"), "", display(run, root))
        for entry in extracted:
            if entry["message"]:
                diagnostics.append(warning(entry["message"], entry["file"]))
    newer = run_reader.changed_sources(run, steps)
    if newer:
        diagnostics.append(warning(
            "these design inputs are newer than the run {}: {}. The run is not a result for the present inputs.".format(
                display(run, root), ", ".join(newer)), display(run, root)))
    against = (request.get("inputs") or {}).get("against")
    if against == "auto":
        other = run_reader.nearest_sibling(run)
    elif against:
        other, error = run_dir(request, "against")
        if error:
            return failure(error)
    else:
        other = None
    if other:
        result = run_reader.compare(run, other)
        diagnostics.append(compare_diagnostic(result, run, other, root))
    report.append("step  done  runtime       id")
    for step in steps[-MAX_REPORT:]:
        report.append("{:>4}  {:<4}  {:<12}  {}".format(step["index"], "yes" if step["done"] else "NO", step["runtime"] or "-", step["id"]))
    report.append("corner  check  worst slack (ns)  level  step")
    for row in rows:
        report.append("{}  {}  {}  {}  {}".format(
            row["corner"], row["check"], "-" if row["value"] is None else "{:+.4f}".format(row["value"]),
            row["level"] or "-", row["step"] or "-"))
    return {"contract": CONTRACT, "status": "completed", "tool": tool(), "input_files": inputs_of(run, steps, root, (request.get("inputs") or {}).get("launcher")),
            "outputs": [], "measurements": measurements, "diagnostics": diagnostics, "report": report}


def compare(request):
    root = request["root"]
    run, error = run_dir(request)
    if error:
        return failure(error)
    against, error = run_dir(request, "against")
    if error:
        return failure(error)
    result = run_reader.compare(run, against)
    source = "{} against {}".format(display(run, root), display(against, root))
    measurements = {"settings_changed": measured(len(result["settings"]), "", source),
                    "steps_compared": measured(result["common_steps"], "", source),
                    "steps_different": measured(len(result["differences"]), "", source)}
    if result["verdict"] == "other_input":
        measurements["effect"] = {"value": None, "unit": "", "status": "failed", "source": source,
                                  "reason": "the runs differ before the first step that reads a changed setting"}
    elif result["verdict"] == "same_settings":
        measurements["effect"] = missing("", "the runs have the same settings")
    else:
        measurements["effect"] = measured(1 if result["verdict"] == "effect" else 0, "", source)
    report = ["setting: old -> new"]
    for key, (old, new) in list(result["settings"].items())[:20]:
        report.append("{}: {} -> {}".format(key, json.dumps(old), json.dumps(new)))
    report.append("first step that reads a changed setting: {}".format(result["first_reader"] or "-"))
    report.append("first step with a different result: {}".format(result["first_difference"] or "none"))
    for difference in result["differences"][:8]:
        for key, (old, new) in list(difference["metrics"].items())[:6]:
            report.append("{}  {}: {} -> {}".format(difference["step"], key, old, new))
        if difference["views"]:
            report.append("{}  different netlist views: {}".format(difference["step"], ", ".join(difference["views"])))
    files = [file_entry(os.path.join(d, "resolved.json"), root, "config") for d in (run, against)]
    return {"contract": CONTRACT, "status": "completed", "tool": tool(), "input_files": {"complete": True, "files": files},
            "outputs": [], "measurements": measurements, "diagnostics": [compare_diagnostic(result, run, against, root)],
            "report": report}


def launcher_path():
    """The directories that the `librelane` launcher on PATH puts first in PATH (a shell launcher with a line
    `export PATH=<dir>:${PATH}`), or an empty list."""
    launcher = shutil.which("librelane")
    if not launcher:
        return []
    try:
        with open(launcher, errors="replace") as f:
            text = f.read(4000)
    except OSError:
        return []
    if not text.startswith("#!") or "\0" in text:
        return []
    out = []
    for m in re.finditer(r"^\s*(?:export\s+)?PATH=([^\n]*)$", text, re.M):
        for part in m.group(1).strip().strip('"').split(":"):
            part = os.path.expandvars(part.strip())
            if part and "PATH" not in part and os.path.isdir(part):
                out.append(part)
    return out


def find_step(steps, wanted):
    wanted = str(wanted)
    exact = [s for s in steps if s["name"] == wanted or str(s["index"]) == wanted.lstrip("0")]
    if exact:
        return exact[0], None
    by_id = [s for s in steps if s["id"].lower() == wanted.lower()]
    if len(by_id) == 1:
        return by_id[0], None
    if len(by_id) > 1:
        return None, "the step id {} is used {} times in the run ({}): give the step number".format(
            wanted, len(by_id), ", ".join(s["name"] for s in by_id))
    return None, "the run has no step '{}'. Steps: {}".format(wanted, ", ".join(s["name"] for s in steps))


def replay(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    run, error = run_dir(request)
    if error:
        return failure(error)
    steps = run_reader.steps_of(run)
    step, error = find_step(steps, inputs.get("step", ""))
    if error:
        return failure(error)
    config_path = os.path.join(step["dir"], "config.json")
    config = run_reader.load(config_path)
    if not isinstance(config, dict):
        return failure("step {} has no config.json: it cannot be replayed".format(step["name"]))
    overrides = inputs.get("set") or {}
    if not isinstance(overrides, dict):
        return failure("input 'set' must be an object of flow variables")
    unknown = [k for k in overrides if k not in config]
    if unknown:
        readers = {k: [s["name"] for s in steps if k in s["variables"]] for k in unknown}
        return failure("step {} ({}) does not read {}: a change of it has no effect on this step. {}".format(
            step["name"], step["id"], ", ".join(unknown),
            " ".join("{} is read by: {}.".format(k, ", ".join(v) if v else "no step of this run") for k, v in readers.items())))
    state_in = inputs.get("state_in")
    state_path = os.path.join(step["dir"], "state_in.json") if not state_in else (
        state_in if os.path.isabs(state_in) else os.path.join(root, state_in))
    if not os.path.isfile(state_path):
        return failure("the input state {} is not there".format(display(state_path, root)))
    config.update(overrides)
    replay_config = os.path.join(work, "config.json")
    with open(replay_config, "w") as f:
        json.dump(config, f, indent=1)
    out_dir = os.path.join(work, "out")
    env = dict(os.environ)
    first = launcher_path()
    if first:
        env["PATH"] = ":".join(first + [env.get("PATH", "")])
    argv = [sys.executable, "-m", "librelane.steps", "run", "-c", replay_config, "-i", state_path, "-o", out_dir,
            "--hide-progress-bar", "--log-level", "ERROR"]
    started = time.time()
    exit_code = None
    with open(os.path.join(work, "replay.log"), "w") as log:
        try:
            exit_code = subprocess.call(argv, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        except OSError as e:
            log.write("could not start: {}\n".format(e))
    runtime = round(time.time() - started, 2)
    commands = [{"argv": argv, "exit_code": exit_code, "runtime_s": runtime}]
    source = display(out_dir, root)
    new_metrics = run_reader._fresh(out_dir) if os.path.isfile(os.path.join(out_dir, "state_out.json")) else None
    measurements = {"runtime_s": measured(runtime, "s", "adapter")}
    diagnostics, report = [], []
    logs = sorted(n for n in os.listdir(out_dir) if n.endswith(".log")) if os.path.isdir(out_dir) else []
    log_path = os.path.join(out_dir, logs[0]) if logs else os.path.join(work, "replay.log")
    text = orlog.read_text(log_path) if os.path.isfile(log_path) else ""
    found = orlog.messages(text)
    for table in orlog.repair_tables(text):
        for finding in orlog.diagnose_repair(table, found):
            diagnostics.append(warning("{} repair table at line {}: {}".format(table["kind"], table["line"], finding["message"]),
                                       "{}:{}".format(display(log_path, root), table["line"])))
    for message in found:
        if message["severity"] in ("error", "critical"):
            diagnostics.append({"severity": "error", "message": "[{}] {}".format(message["code"], message["text"]),
                                "source": "{}:{}".format(display(log_path, root), message["line"])})
    outputs = []
    for base, dirs, names in os.walk(work):
        dirs.sort()
        for name in sorted(names):
            if name.endswith((".log", ".json", ".rpt", ".v", ".sdc")):
                outputs.append(file_entry(os.path.join(base, name), root))
    files = {"complete": True, "files": [file_entry(config_path, root, "config"), file_entry(state_path, root, "state")]}
    if new_metrics is None:
        tail = [l for l in text.splitlines() if l.strip()][-4:]
        diagnostics.insert(0, {"severity": "error", "source": display(log_path, root), "message":
                               "not run: the replay of step {} wrote no state_out.json (exit code {}). Last lines: {}".format(
                                   step["name"], exit_code, " | ".join(tail) or "(empty log)")})
        measurements["metrics_changed"] = {"value": None, "unit": "", "status": "failed", "source": source}
        return {"contract": CONTRACT, "status": "failed", "tool": tool(), "commands": commands, "input_files": files,
                "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics}
    old_metrics = step["fresh"]
    changed = [k for k in sorted(new_metrics) if not run_reader.VOLATILE.search(k) and old_metrics.get(k) != new_metrics[k]]
    changed.sort(key=lambda k: (not k.startswith("timing__"), k))
    views = []
    for key in run_reader.NETLIST_KEYS:
        new_state = run_reader.load(os.path.join(out_dir, "state_out.json")) or {}
        name = os.path.basename(str(new_state.get(key) or ""))
        new_file, old_file = os.path.join(out_dir, name), os.path.join(step["dir"], name)
        if name and os.path.isfile(new_file) and os.path.isfile(old_file) and run_reader.sha256(new_file) != run_reader.sha256(old_file):
            views.append(key)
    measurements["metrics_changed"] = measured(len(changed), "", source)
    measurements["views_changed"] = measured(len(views), "", source)
    level = run_reader.level_of(step, steps)
    report.append("metric: value in the run -> value of the replay (step {}, {})".format(step["name"], run_reader.LEVEL_TEXT[level]))
    for key in changed[:MAX_REPORT]:
        report.append("{}: {} -> {}".format(key, old_metrics.get(key, "-"), new_metrics[key]))
        if isinstance(new_metrics[key], (int, float)) and len(measurements) < 40:
            measurements[key] = measured(new_metrics[key], "", source, level=level)
    if len(changed) > MAX_REPORT:
        report.append("... {} more in {}".format(len(changed) - MAX_REPORT, display(os.path.join(out_dir, "or_metrics_out.json"), root)))
    if overrides and not changed and not views:
        diagnostics.append(warning(
            ("the replay with {} gives the same metrics and the same netlists as the step in the run: the setting has "
             "no effect at this step. Do not record it as a change of the design. Check how the flow script uses the "
             "variable (unit, rounding, a condition).").format(", ".join("{}={}".format(k, json.dumps(v)) for k, v in overrides.items())), source))
    report.append("state of the replay: {}".format(display(os.path.join(out_dir, "state_out.json"), root)))
    return {"contract": CONTRACT, "status": "completed", "tool": tool(), "commands": commands, "input_files": files,
            "outputs": outputs, "measurements": measurements, "diagnostics": diagnostics, "report": report}


TOOLS = (("librelane", ["--version"]), ("openroad", ["-version"]), ("sta", ["-version"]), ("yosys", ["-V"]),
         ("klayout", ["-v"]), ("magic", ["--version"]), ("netgen", ["-batch", "quit"]), ("verilator", ["--version"]),
         ("iverilog", ["-V"]), ("vvp", ["-V"]))
VIEWS = (("lib", (".lib", ".lib.gz")), ("lef", (".lef",)), ("gds", (".gds", ".gds.gz")), ("verilog", (".v",)))


def start(argv, env):
    """(exit code or None, the first line of the output) of a version command."""
    try:
        done = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    lines = [l.strip() for l in done.stdout.decode(errors="replace").splitlines() if l.strip()]
    return done.returncode, (lines[0] if lines else "")[:160]


def preflight(request):
    root = request["root"]
    inputs = request.get("inputs") or {}
    wanted = inputs.get("tools") or [name for name, _ in TOOLS]
    flow_env = dict(os.environ)
    first = launcher_path()
    if first:
        flow_env["PATH"] = ":".join(first + [flow_env.get("PATH", "")])
    measurements, diagnostics, report = {}, [], ["tool  state  path  version"]
    found = failed = 0
    for name, arguments in TOOLS:
        if name not in wanted:
            continue
        path = shutil.which(name, path=flow_env["PATH"])
        if not path:
            report.append("{}  not found".format(name))
            diagnostics.append(warning("the tool {} is not on PATH".format(name), "preflight"))
            failed += 1
            continue
        code, line = start([path] + arguments, flow_env)
        if code != 0:
            failed += 1
            report.append("{}  DOES NOT START  {}  {}".format(name, path, line))
            diagnostics.append(warning("the tool {} ({}) does not start (exit code {}): {}".format(name, path, code, line), "preflight"))
            continue
        found += 1
        report.append("{}  ok  {}  {}".format(name, path, line))
        other = shutil.which(name)
        if other and os.path.realpath(other) != os.path.realpath(path):
            _, other_line = start([other] + arguments, dict(os.environ))
            if other_line != line:
                diagnostics.append(warning(
                    ("two builds of {}: the librelane launcher uses {} ({}); the default PATH has {} ({}). Record the "
                     "version of the build that the flow uses, and run single steps with the PATH of the launcher.").format(
                         name, path, line, other, other_line), "preflight"))
    measurements["tools_ok"] = measured(found, "", "preflight")
    measurements["tools_failed"] = measured(failed, "", "preflight")
    pdk_root, pdk = inputs.get("pdk_root") or os.environ.get("PDK_ROOT"), inputs.get("pdk") or os.environ.get("PDK")
    libraries = 0
    if pdk_root and pdk and os.path.isdir(os.path.join(pdk_root, pdk, "libs.ref")):
        base = os.path.join(pdk_root, pdk, "libs.ref")
        for library in sorted(os.listdir(base)):
            if not os.path.isdir(os.path.join(base, library)):
                continue
            counts = []
            for view, endings in VIEWS:
                directory = os.path.join(base, library, view)
                names = os.listdir(directory) if os.path.isdir(directory) else []
                counts.append("{} {}".format(view, sum(1 for n in names if n.endswith(endings))))
            report.append("pdk {} library {}: {}".format(pdk, library, ", ".join(counts)))
            libraries += 1
        measurements["pdk_libraries"] = measured(libraries, "", os.path.join(pdk_root, pdk, "libs.ref"))
    else:
        measurements["pdk_libraries"] = missing("", "no libs.ref directory for PDK_ROOT={} PDK={}".format(pdk_root, pdk))
        diagnostics.append(warning("the PDK was not found: PDK_ROOT={} PDK={} has no libs.ref directory".format(pdk_root, pdk), "preflight"))
    usage = shutil.disk_usage(root)
    free_gb = round(usage.free / 1e9, 1)
    measurements["disk_free_gb"] = measured(free_gb, "GB", display(root, root))
    need = float(inputs.get("min_free_gb", 5))
    if free_gb < need:
        diagnostics.append(warning("the design root has {} GB free; the request needs {} GB (min_free_gb)".format(free_gb, need), "preflight"))
    try:
        probe = os.path.join(request["work_dir"], "write.probe")
        with open(probe, "w") as f:
            f.write("x" * 4096)
        os.remove(probe)
        measurements["writable"] = measured(1, "", "work directory")
    except OSError as e:
        measurements["writable"] = measured(0, "", "work directory")
        diagnostics.append(warning("a write to the work directory failed ({}): a full disk or a user quota".format(e), "preflight"))
    return {"contract": CONTRACT, "status": "completed", "tool": tool(), "input_files": {"complete": True, "files": []},
            "outputs": [], "measurements": measurements, "diagnostics": diagnostics, "report": report}


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: librelane_adapter.py <request.json>\n")
        return 2
    with open(argv[1]) as f:
        request = json.load(f)
    if request.get("contract") != CONTRACT:
        sys.stderr.write("unsupported contract: {}\n".format(request.get("contract")))
        return 2
    operation = {"read": read, "compare": compare, "replay": replay, "preflight": preflight}.get(request.get("operation"))
    response = failure("unknown operation: {}".format(request.get("operation"))) if operation is None else operation(request)
    tmp = request["response_path"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(response, f, indent=1)
    os.replace(tmp, request["response_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
