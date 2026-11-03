#!/usr/bin/env python3
# The other designer of the layout-stale-state task. The sandbox starts this script before the agent, from the
# read-only directory /companion. It waits for the first DRC report of the agent, then commits a new version of
# block.gds to the design repository, as a colleague would.
#
# 1. Wait for the first complete marker database (a *.lyrdb file that ends with </report-database>) anywhere under
#    the workspace, then wait delay_s more. If no report comes, act fallback_s after the start.
# 2. If answer.json exists and is a final claim (it parses as JSON and has drc_clean true, or every row of checks
#    has ran true), log "skipped: final answer.json exists" and stop. A preliminary answer.json (for example
#    drc_clean false before the first DRC) does not stop the commit.
# 3. Else copy the new version over block.gds and commit it as the colleague. Log "applied <time> sha256:<hash>",
#    with "(preliminary answer.json present)" when a preliminary answer.json exists.
#
# The settings are in companion.json next to this script: gds (the new version), target (the file in the
# workspace), message (the commit message), delay_s and fallback_s. The log goes to standard output, one line per
# event, each line with an ISO time (UTC, milliseconds).
#
# Usage: companion.py [--work /work] [--dir /companion] [--once] [--started <epoch s>] [--delay <s>] [--fallback <s>]
#   --once: check the trigger one time and act if it is due, without a wait (for tests). The trigger time is then
#   the modification time of the first complete report. --started: the start time for the fallback (default: now).

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

END = b"</report-database>"


def now_iso(t=None):
    t = time.time() if t is None else t
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def complete(path):
    """True if the file is a complete marker database: it ends with </report-database> (and white space)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 256))
            return f.read().rstrip().endswith(END)
    except OSError:
        return False


def first_report(work):
    """The complete marker database with the earliest modification time under work (not under .git), or None."""
    best = None
    for root, dirs, files in os.walk(work):
        dirs[:] = [d for d in dirs if d != ".git"]
        for name in files:
            if not name.endswith(".lyrdb"):
                continue
            path = os.path.join(root, name)
            if not complete(path):
                continue
            mtime = os.path.getmtime(path)
            if best is None or mtime < best[1]:
                best = (path, mtime)
    return best


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def final_answer(path):
    """None if the file does not exist; True if it is a final claim (JSON with drc_clean true, or every row of checks
    with ran true); else False (a preliminary or unreadable answer.json)."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            a = json.load(f)
    except (OSError, ValueError):
        return False
    if not isinstance(a, dict):
        return False
    if a.get("drc_clean") is True:
        return True
    checks = a.get("checks")
    return isinstance(checks, list) and len(checks) > 0 and all(isinstance(c, dict) and c.get("ran") is True for c in checks)


def apply(work, cfg, src_dir):
    """Copy the new version over the target and commit it as the colleague. Returns the log line."""
    final = final_answer(os.path.join(work, "answer.json"))
    if final:
        return "skipped: final answer.json exists"
    note = " (preliminary answer.json present)" if final is False else ""
    target = os.path.join(work, cfg["target"])
    tmp = os.path.join(work, f".{cfg['target']}.colleague")
    shutil.copyfile(os.path.join(src_dir, cfg["gds"]), tmp)
    os.replace(tmp, target)
    git = ["git", "-c", "safe.directory=*", "-c", "user.name=colleague", "-c", "user.email=colleague@localhost"]
    # The variables override an author of the environment.
    env = {**os.environ, "GIT_AUTHOR_NAME": "colleague", "GIT_AUTHOR_EMAIL": "colleague@localhost",
           "GIT_COMMITTER_NAME": "colleague", "GIT_COMMITTER_EMAIL": "colleague@localhost"}
    error = ""
    for _ in range(10):
        r = subprocess.run(git + ["commit", "-q", "-m", cfg["message"], "--", cfg["target"]], cwd=work, env=env,
                           capture_output=True, text=True)
        if r.returncode == 0:
            break
        error = (r.stderr or r.stdout).strip().replace("\n", " ")
        # Another git process (the agent) can hold the index lock for a short time.
        time.sleep(1)
    else:
        return f"applied {now_iso()} sha256:{sha256(target)} commit failed: {error}{note}"
    head = subprocess.run(git + ["rev-parse", "HEAD"], cwd=work, capture_output=True, text=True).stdout.strip()
    return f"applied {now_iso()} sha256:{sha256(target)} commit {head}{note}"


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="The colleague of the layout-stale-state task.")
    ap.add_argument("--work", default="/work")
    ap.add_argument("--dir", default=here, help="the directory of companion.json and the new version")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--started", type=float)
    ap.add_argument("--delay", type=float)
    ap.add_argument("--fallback", type=float)
    a = ap.parse_args(argv)
    with open(os.path.join(a.dir, "companion.json")) as f:
        cfg = json.load(f)
    delay = cfg.get("delay_s", 30) if a.delay is None else a.delay
    fallback = cfg.get("fallback_s", 480) if a.fallback is None else a.fallback
    started = time.time() if a.started is None else a.started
    if not a.once:
        print(f"start {now_iso(started)} target {cfg['target']} delay_s {delay:g} fallback_s {fallback:g}", flush=True)
    trigger = None
    while True:
        now = time.time()
        if trigger is None:
            found = first_report(a.work)
            if found:
                # The deck writes the report at its end: its modification time is the time of the first complete report.
                trigger = (found[0], min(found[1], now))
                print(f"trigger {now_iso(trigger[1])} {os.path.relpath(found[0], a.work)}", flush=True)
        if trigger is not None and now >= trigger[1] + delay:
            break
        if now >= started + fallback:
            print(f"fallback {now_iso(now)} no complete report after {fallback:g} s", flush=True)
            break
        if a.once:
            print(f"waiting {now_iso(now)}", flush=True)
            return 0
        time.sleep(2)
    line = apply(a.work, cfg, a.dir)
    print(line if line.startswith("applied") else f"{line} ({now_iso()})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
