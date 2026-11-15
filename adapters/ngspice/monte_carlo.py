"""Operation "monte_carlo" of the ngspice adapter: device mismatch by the PDK mismatch models, one ngspice run per seed.

Inputs: deck, libs, params, temp_c, measurements (as simulate; the deck prints the measurements from its .control
block); seeds (number of seeds, default 100, at most 2000); seed_start (default 1); options ({name: value}, the
.options line of each seed, default {"reltol": 1e-3, "itl1": 1000}); parallel (seeds at the same time, default the
number of CPUs of the process); technology (optional pack name; the default is the pack of $PDK); mismatch
(optional, replaces the "mismatch" section of the pack: {lib_suffix, instance_param, devices}).

Method:
1. Each lib section that has a mismatch section in its file (<section><lib_suffix>, for IHP "_mismatch") is replaced
   by it. A lib without one stays as it is and is listed.
2. The deck and the files that it includes from the design root are written as one file (work/mc_deck.cir). Each
   subcircuit instance of a device of the mismatch list gets the instance parameter of the pack (IHP: mm_ok=1; the
   PDK mismatch models give no mismatch without it), when the line does not set it.
3. Seed s: ".options seed=s" and the options line. The run of the first seed is the hashed run (work/ngspice.log);
   the others run in work/seeds/.
4. A seed is "ok" (every measurement has a value), "no_dc" (ngspice found no DC point, from its log) or "failed".
   The DC of a seed is "newton", "fallback" (gmin or source stepping, or the transient op) or "none".
   A seed without a value is reported in work/mc.json and in the counts, never dropped in silence.

Response: measurements <name>.mean, .sigma (sample, n - 1), .min, .max, .abs_max, .n (over the ok seeds; "failed" when
a seed has no value for it), seeds_total, seeds_ok, seeds_no_dc, seeds_failed, seeds_fallback. Output work/mc.json
(role "monte_carlo"): {schema, measurements, seeds: [{seed, status, dc, values}], options, mismatch}. The kernel
requirement kind "monte_carlo" reads it. When at least two seeds are ok and no measurement varies, the run fails:
the mismatch models are not active (for example no instance parameter).
"""

import json
import math
import os
import re
import subprocess
from multiprocessing import Pool

import ngspice_adapter as na

MC_SCHEMA = "simra.monte_carlo/0"
DEFAULT_OPTIONS = {"reltol": 1e-3, "itl1": 1000}
MAX_SEEDS = 2000
LIB_SECTION = re.compile(r"^\s*\.lib\s+(\S+)", re.IGNORECASE)
INCLUDE = re.compile(r"^\s*\.(include|inc)\s+(.+)$", re.IGNORECASE)
OPTION_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FALLBACK = re.compile(r"starting dynamic gmin stepping|starting source stepping|transient op started", re.IGNORECASE)
NO_DC = re.compile(r"transient op failed|iteration limit reached|simulation\(s\) aborted|no convergence in dc|dc solution failed",
                   re.IGNORECASE)


def lib_sections(path):
    """The section names of the .LIB blocks of a library file (lower case)."""
    names = set()
    with open(path, errors="replace") as f:
        for line in f:
            m = LIB_SECTION.match(line)
            if m and not m.group(1).startswith(('"', "'")) and "." not in m.group(1):
                names.add(m.group(1).lower())
    return names


def mismatch_libs(libs, suffix):
    """(libs with the mismatch sections, [{path, section, mismatch}])."""
    out, rows = [], []
    for path, section in libs:
        if section and (section.lower() + suffix.lower()) in lib_sections(path):
            out.append((path, section + suffix))
            rows.append({"path": path, "section": section, "mismatch": section + suffix})
        else:
            out.append((path, section))
            rows.append({"path": path, "section": section, "mismatch": None})
    return out, rows


def logical_lines(path):
    """The lines of a netlist with the "+" continuations joined."""
    lines = []
    with open(path, errors="replace") as f:
        for raw in f.read().splitlines():
            if raw.startswith("+") and lines:
                lines[-1] += " " + raw[1:].strip()
            else:
                lines.append(raw)
    return lines


def inline_deck(path, root, seen=None):
    """The deck with the .include files of the design root in place (recursive). Other include lines get an absolute path."""
    seen = set() if seen is None else seen
    real = os.path.realpath(path)
    if real in seen:
        return ["* (included again, skipped: {})".format(os.path.basename(real))]
    seen.add(real)
    out = []
    base = os.path.dirname(real)
    for line in logical_lines(real):
        m = INCLUDE.match(line)
        if m:
            words = na.split_args(m.group(2))
            name = os.path.expandvars(words[0]) if words else ""
            target = name if os.path.isabs(name) else os.path.join(base, name)
            if os.path.isfile(target):
                inside = not os.path.relpath(os.path.realpath(target), os.path.realpath(root)).startswith("..")
                if inside:
                    out.append("* begin include {}".format(os.path.relpath(os.path.realpath(target), os.path.realpath(root))))
                    out.extend(x for x in inline_deck(target, root, seen) if not re.match(r"^\s*\.end\s*$", x, re.IGNORECASE))
                    out.append("* end include")
                    continue
                line = '.{} "{}"'.format(m.group(1), os.path.realpath(target))
        elif re.match(r"^\s*\.lib\s", line, re.IGNORECASE):
            words = na.split_args(line.split(None, 1)[1])
            name = os.path.expandvars(words[0]) if words else ""
            if name and not os.path.isabs(name) and os.path.isfile(os.path.join(base, name)):
                line = '.lib "{}"{}'.format(os.path.join(base, name), " " + " ".join(words[1:]) if len(words) > 1 else "")
        out.append(line)
    return out


def add_instance_param(lines, devices, param):
    """(lines, {device: count}): each X line of a device in devices gets param (name=value) when it does not set it."""
    name = param.split("=")[0].strip().lower()
    wanted = {d.lower() for d in devices}
    counts = {}
    out, in_control = [], False
    for line in lines:
        low = line.strip().lower()
        if low.startswith(".control"):
            in_control = True
        elif low.startswith(".endc"):
            in_control = False
        if in_control or not low.startswith("x"):
            out.append(line)
            continue
        body = line.split(";")[0].split("$ ")[0]
        words = body.split()
        positional = [w for w in words if "=" not in w]
        device = positional[-1].lower() if len(positional) > 1 else ""
        if device in wanted:
            if not any(w.lower().startswith(name + "=") for w in words):
                line = body.rstrip() + " " + param
            counts[device] = counts.get(device, 0) + 1
        out.append(line)
    return out, counts


def option_line(options):
    parts = []
    for k in sorted(options):
        v = options[k]
        if not OPTION_NAME.match(k) or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return None
        parts.append("{}={}".format(k, na.spice_value(v)))
    return ".options " + " ".join(parts)


def top_text(libs, settings, seed, options):
    lines = ["* simra ngspice adapter: Monte Carlo seed {}".format(seed)]
    lines += ['.lib "{}"{}'.format(p, " " + s if s else "") for p, s in libs]
    lines.append('.include "mc_deck.cir"')
    lines.append(".options seed={}".format(seed))
    lines.append(options)
    lines += settings
    lines.append(".end")
    return "\n".join(lines) + "\n"


def classify(log_text, values, wanted):
    """(status, dc) of one seed from its log and its values."""
    dc = "fallback" if FALLBACK.search(log_text) else "newton"
    if NO_DC.search(log_text):
        dc = "none"
    if all(values.get(n) is not None for n in wanted):
        return "ok", dc if dc != "none" else "fallback"
    return ("no_dc" if dc == "none" else "failed"), dc


def seed_values(lines, wanted):
    measurements, _ = na.parse_log(lines, wanted)
    return {n: (measurements[n]["value"] if measurements.get(n, {}).get("status") == "measured" else None) for n in wanted}


def run_seed(args):
    """One seed in work/seeds. Returns {seed, status, dc, values}."""
    work, root, seed, text, wanted = args
    name = "s{}".format(seed)
    with open(os.path.join(work, name + ".cir"), "w") as fh:
        fh.write(text)
    env = dict(os.environ, NGSPICE_INPUT_DIR=os.path.realpath(root))
    log_path = os.path.join(work, name + ".log")
    with open(log_path, "w") as log:
        subprocess.call(["ngspice", "-b", name + ".cir"], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
    with open(log_path, errors="replace") as f:
        text_log = f.read()
    values = seed_values(text_log.splitlines(), wanted)
    status, dc = classify(text_log, values, wanted)
    if status == "ok":
        os.remove(log_path)
        os.remove(os.path.join(work, name + ".cir"))
    return {"seed": seed, "status": status, "dc": dc, "values": values}


def statistics(seeds, wanted):
    """The response measurements of the seeds."""
    m = {}
    for n, unit in wanted.items():
        vals = [s["values"][n] for s in seeds if s["status"] == "ok"]
        missing = [s["seed"] for s in seeds if s["values"].get(n) is None]
        status = "measured" if vals and not missing else "failed"
        mean = sum(vals) / len(vals) if vals else None
        sigma = math.sqrt(sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)) if len(vals) > 1 else None
        for key, value in (("mean", mean), ("sigma", sigma), ("min", min(vals) if vals else None),
                           ("max", max(vals) if vals else None), ("abs_max", max(abs(v) for v in vals) if vals else None)):
            m["{}.{}".format(n, key)] = {"value": value, "unit": unit, "status": status if value is not None else "failed"}
        m["{}.n".format(n)] = {"value": len(vals), "unit": None, "status": "measured"}
    counts = {"ok": 0, "no_dc": 0, "failed": 0}
    for s in seeds:
        counts[s["status"]] += 1
    m["seeds_total"] = {"value": len(seeds), "unit": None, "status": "measured"}
    m["seeds_ok"] = {"value": counts["ok"], "unit": None, "status": "measured"}
    m["seeds_no_dc"] = {"value": counts["no_dc"], "unit": None, "status": "measured"}
    m["seeds_failed"] = {"value": counts["failed"], "unit": None, "status": "measured"}
    m["seeds_fallback"] = {"value": sum(1 for s in seeds if s["dc"] == "fallback"), "unit": None, "status": "measured"}
    return m


def pack_mismatch(inputs):
    """The mismatch facts: inputs.mismatch, else the "mismatch" section of the technology pack for $PDK. (facts, error)."""
    given = inputs.get("mismatch")
    if given is not None:
        facts = given
    else:
        pdk = os.environ.get("PDK")
        _, pack, error = na.find_technology(inputs.get("technology"), pdk, section="mismatch")
        if error:
            return None, error + "; or give inputs.mismatch {lib_suffix, instance_param, devices}"
        facts = pack["ngspice"]["mismatch"].get(pdk)
        if facts is None:
            return None, "technology pack {} has no ngspice.mismatch.{}".format(pack.get("name"), pdk)
    if not isinstance(facts, dict) or not isinstance(facts.get("lib_suffix"), str) or not isinstance(facts.get("instance_param"), str) \
            or not isinstance(facts.get("devices"), list) or "=" not in facts["instance_param"]:
        return None, "mismatch facts need lib_suffix (string), instance_param (name=value) and devices (list)"
    return facts, None


def monte_carlo(request):
    root, work = request["root"], request["work_dir"]
    inputs = request.get("inputs") or {}
    tool = {"name": "ngspice", "version": na.ngspice_version(), "pdk": na.pdk_facts()}
    deck_path, libs, error = na.deck_and_libs(root, inputs)
    if error:
        return na.failure(tool, error)
    settings, error = na.condition_lines(inputs)
    if error:
        return na.failure(tool, error)
    wanted = inputs.get("measurements")
    if not isinstance(wanted, dict) or not wanted:
        return na.failure(tool, "input 'measurements' is required ({name: unit}); the deck prints each one in every seed")
    try:
        n = int(inputs.get("seeds", 100))
        start = int(inputs.get("seed_start", 1))
    except (TypeError, ValueError):
        return na.failure(tool, "inputs 'seeds' and 'seed_start' must be integers")
    if not 2 <= n <= MAX_SEEDS or start < 1:
        return na.failure(tool, "'seeds' must be 2 to {} and 'seed_start' at least 1".format(MAX_SEEDS))
    options = dict(DEFAULT_OPTIONS)
    options.update(inputs.get("options") or {})
    opt_line = option_line(options)
    if opt_line is None:
        return na.failure(tool, "input 'options' must be {name: finite number}")
    facts, error = pack_mismatch(inputs)
    if error:
        return na.failure(tool, error)
    mm_libs, lib_rows = mismatch_libs(libs, facts["lib_suffix"])
    if not any(r["mismatch"] for r in lib_rows):
        return na.failure(tool, "no lib has a mismatch section (<section>{}); give the corner libs of the PDK".format(facts["lib_suffix"]))
    lines, counts = add_instance_param(inline_deck(deck_path, root), facts["devices"], facts["instance_param"])
    if not counts:
        return na.failure(tool, "the deck has no instance of a device with mismatch models ({})".format(", ".join(facts["devices"])))
    with open(os.path.join(work, "mc_deck.cir"), "w") as fh:
        fh.write("\n".join(lines) + "\n")

    # The first seed is the hashed run; the others run in work/seeds.
    first = top_text(mm_libs, settings, start, opt_line)
    with open(os.path.join(work, "top.cir"), "w") as fh:
        fh.write(first)
    response = na.run(request, tool, "top.cir", deck_path, mm_libs, wanted)
    with open(os.path.join(work, "ngspice.log"), errors="replace") as f:
        log0 = f.read()
    values0 = seed_values(log0.splitlines(), wanted)
    status0, dc0 = classify(log0, values0, wanted)
    seeds = [{"seed": start, "status": status0, "dc": dc0, "values": values0}]
    sdir = os.path.join(work, "seeds")
    os.makedirs(sdir, exist_ok=True)
    with open(os.path.join(sdir, "mc_deck.cir"), "w") as fh:
        fh.write("\n".join(lines) + "\n")
    procs = max(1, min(int(inputs.get("parallel", len(os.sched_getaffinity(0)))), 64))
    jobs = [(sdir, root, s, top_text(mm_libs, settings, s, opt_line), wanted) for s in range(start + 1, start + n)]
    with Pool(procs) as pool:
        seeds += pool.map(run_seed, jobs)
    os.remove(os.path.join(sdir, "mc_deck.cir"))
    if not os.listdir(sdir):
        os.rmdir(sdir)

    diagnostics = [d for d in response["diagnostics"] if d.get("severity") != "info"]
    m = statistics(seeds, wanted)
    ok = [s for s in seeds if s["status"] == "ok"]
    varies = any((m.get(k + ".sigma") or {}).get("value") for k in wanted)
    if len(ok) >= 2 and not varies:
        diagnostics.insert(0, {"severity": "error", "source": "adapter", "message":
                               "no measurement varies over {} seeds: the mismatch models are not active (instance parameter {}, sections {})".format(
                                   len(ok), facts["instance_param"], ", ".join(r["mismatch"] for r in lib_rows if r["mismatch"]))})
    bad = [s["seed"] for s in seeds if s["status"] != "ok"]
    if bad:
        diagnostics.append({"severity": "warning", "source": "adapter", "message":
                            "{} of {} seeds have no value (no_dc {}, failed {}): seeds {}; logs in work/seeds".format(
                                len(bad), len(seeds), m["seeds_no_dc"]["value"], m["seeds_failed"]["value"], bad[:20])})
    nolib = [r["path"] + (" " + r["section"] if r["section"] else "") for r in lib_rows if not r["mismatch"]]
    if nolib:
        diagnostics.append({"severity": "info", "source": "adapter", "message": "libs without a mismatch section (kept): " + "; ".join(nolib)})
    table = {"schema": MC_SCHEMA, "measurements": wanted, "seeds": seeds, "options": options,
             "mismatch": {"libs": lib_rows, "instance_param": facts["instance_param"], "instances": counts}}
    path = os.path.join(work, "mc.json")
    with open(path, "w") as fh:
        json.dump(table, fh, indent=1)
        fh.write("\n")
    response["outputs"] = [o for o in response["outputs"] if not o["path"].endswith("mc.json")]
    response["outputs"].append({"path": na.display_path(path, root), "sha256": na.sha256(path), "bytes": os.path.getsize(path), "role": "monte_carlo"})
    response["measurements"] = m
    response["diagnostics"] = diagnostics
    response["status"] = "completed" if ok and (len(ok) < 2 or varies) else "failed"
    return response
