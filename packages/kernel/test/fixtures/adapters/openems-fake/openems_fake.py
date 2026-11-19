#!/usr/bin/env python3
"""Fake openEMS adapter for the kernel tests of simra em: "simulate" writes a synthetic column file in the format of
the real adapter (no solver); "merge" is the merge of the real adapter."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "..", "..", "..", "adapters", "openems"))
import openems_adapter as oa  # noqa: E402


def simulate(request):
    inputs, work = request["inputs"], request["work_dir"]
    os.makedirs(work, exist_ok=True)
    n, (k,) = len(inputs["ports"]), inputs["excite"]
    if inputs.get("fail_port") == k:
        return oa.failure("port %d: the solver failed (exit code 1): fake" % k)
    ok = inputs.get("unconverged_port") != k
    re_ = [[0.9 if i + 1 != k else 0.1, 0.8 if i + 1 != k else 0.2] for i in range(n)]
    doc = {"schema": oa.COLUMNS_SCHEMA, "cell": "line", "ports": [p["name"] for p in inputs["ports"]], "r_ohm": [50.0] * n,
           "f_hz": [1e9, 2e9], "columns": {str(k): {"re": re_, "im": [[0.0, 0.0]] * n}},
           "convergence": {str(k): {"end_criteria_reached": ok, "energy_end_db": -41.0 if ok else -13.5, "timesteps": 100,
                                    "cells": 10, "solve_s": 0.1}},
           "cells": 10, "boundaries": oa.DEFAULT_BOUNDARIES, "end_criteria_db": -40.0}
    path = os.path.join(work, "columns.json")
    with open(path, "w") as fh:
        json.dump(doc, fh)
    status = "completed" if ok or inputs.get("allow_unconverged") else "failed"
    diags = [] if ok else [{"severity": "error" if status == "failed" else "warning", "source": "openems",
                            "message": "port %d: the end criterion -40 dB was not reached" % k}]
    return {"contract": oa.CONTRACT, "status": status, "tool": {"name": "openems-fake"}, "input_files": None,
            "outputs": [oa.file_entry(path, request["root"], "sparameter_columns")],
            "measurements": oa.column_measurements(doc["convergence"], False), "diagnostics": diags}


def main():
    with open(sys.argv[1]) as f:
        request = json.load(f)
    response = {"simulate": simulate, "merge": oa.merge}[request["operation"]](request)
    with open(request["response_path"], "w") as f:
        json.dump(response, f)


main()
