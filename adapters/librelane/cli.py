#!/usr/bin/env python3
"""Command line for the librelane and openroad adapters, without the Simra runner: it writes the request, runs the
adapter in this process and prints the result. Use it in a flow script or a shell.

  cli.py read <run> [--against <run>|auto] [--launcher <file> ...]
  cli.py compare <run> <against>
  cli.py replay <run> <step> [KEY=JSON ...] [--state-in <state.json>] [--out <dir>]
  cli.py parse <openroad log> [--liberty <file> ...]
  cli.py preflight [--pdk-root <dir>] [--pdk <name>]

Common options: --root <design dir> (default: the parent of the runs directory, or the current directory),
--json (print the response as JSON). The exit code is 0 when the adapter completed and gave no warning or error,
1 when it gave a warning or an error, 2 for a wrong call. `replay` needs LibreLane in the environment (run it in
the tool container); its work is in --out (default: <design dir>/replay/<run tag>-<step>-<time>).
"""

import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)

import librelane_adapter  # noqa: E402


def take(args, flag, many=False):
    values = []
    while flag in args:
        i = args.index(flag)
        if i + 1 >= len(args):
            raise SystemExit("{} needs a value".format(flag))
        values.append(args[i + 1])
        del args[i:i + 2]
    return values if many else (values[-1] if values else None)


def main(argv):
    args = list(argv[1:])
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0 if args else 2
    as_json = "--json" in args
    if as_json:
        args.remove("--json")
    root = take(args, "--root")
    against, state_in, out = take(args, "--against"), take(args, "--state-in"), take(args, "--out")
    launchers, liberty = take(args, "--launcher", True), take(args, "--liberty", True)
    pdk_root, pdk = take(args, "--pdk-root"), take(args, "--pdk")
    operation, rest = args[0], args[1:]
    adapter = "openroad" if operation == "parse" else "librelane"
    inputs = {}
    try:
        if operation in ("read", "compare", "replay"):
            run = os.path.abspath(rest[0])
            inputs["run"] = run
            root = root or os.path.dirname(os.path.dirname(run))
            if operation == "read":
                if against:
                    inputs["against"] = against if against == "auto" else os.path.abspath(against)
                if launchers:
                    inputs["launcher"] = [os.path.abspath(p) for p in launchers]
            elif operation == "compare":
                inputs["against"] = os.path.abspath(rest[1])
            else:
                inputs["step"] = rest[1]
                inputs["set"] = {}
                for item in rest[2:]:
                    key, _, value = item.partition("=")
                    try:
                        inputs["set"][key] = json.loads(value)
                    except ValueError:
                        inputs["set"][key] = value
                if state_in:
                    inputs["state_in"] = os.path.abspath(state_in)
        elif operation == "parse":
            inputs["log"] = os.path.abspath(rest[0])
            if liberty:
                inputs["liberty"] = [os.path.abspath(p) for p in liberty]
        elif operation == "preflight":
            if pdk_root:
                inputs["pdk_root"] = pdk_root
            if pdk:
                inputs["pdk"] = pdk
        else:
            raise IndexError
    except IndexError:
        sys.stderr.write(__doc__)
        return 2
    root = os.path.abspath(root or os.getcwd())
    if operation == "replay":
        work = os.path.abspath(out) if out else os.path.join(
            root, "replay", "{}-{}-{}".format(os.path.basename(inputs["run"]), inputs["step"], time.strftime("%Y%m%d-%H%M%S")))
        os.makedirs(work, exist_ok=True)
        keep = True
    else:
        work = tempfile.mkdtemp(prefix="simra-flow-")
        keep = False
    request = {"contract": "simra.adapter/0", "experiment": None, "adapter": adapter, "operation": operation, "inputs": inputs,
               "root": root, "work_dir": work, "response_path": os.path.join(work, "response.json")}
    with open(os.path.join(work, "request.json"), "w") as f:
        json.dump(request, f, indent=1)
    if adapter == "openroad":
        import openroad_adapter
        code = openroad_adapter.main(["openroad_adapter.py", os.path.join(work, "request.json")])
    else:
        code = librelane_adapter.main(["librelane_adapter.py", os.path.join(work, "request.json")])
    if code != 0:
        return 2
    with open(request["response_path"]) as f:
        response = json.load(f)
    if not keep:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
    if as_json:
        json.dump(response, sys.stdout, indent=1)
        sys.stdout.write("\n")
    else:
        print("{} {}: {}".format(adapter, operation, response["status"]))
        for name, m in response["measurements"].items():
            value = "-" if m.get("value") is None else m["value"]
            level = " [{}]".format(m["level"]) if m.get("level") else ""
            print("  {} = {} {} ({}{}){}".format(name, value, m.get("unit") or "", m.get("status"),
                                                 ", " + str(m["source"]) if m.get("source") else "", level))
        for line in response.get("report") or []:
            print("  | " + line)
        for d in response["diagnostics"]:
            print("  {}: {}".format(d["severity"].upper(), d["message"]))
        if keep:
            print("  work directory: " + work)
    bad = response["status"] != "completed" or any(d["severity"] in ("warning", "error") for d in response["diagnostics"])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
