"""Test adapter for the job watchdog: it sleeps inputs.seconds, then writes a completed response."""
import json
import sys
import time

request = json.load(open(sys.argv[1]))
time.sleep(float(request["inputs"].get("seconds", 1)))
with open(request["response_path"], "w") as f:
    json.dump({"contract": "simra.adapter/0", "status": "completed", "tool": {"name": "sleeper", "version": "1"},
               "input_files": {"files": [], "complete": True}, "outputs": [], "measurements": {}, "diagnostics": []}, f)
