"""Make the one-line timing summary from the OpenSTA reports. Usage: summary.py <reports directory>"""
import re
import sys
from pathlib import Path

reports = Path(sys.argv[1])
wns = float(re.search(r"(-?\d+\.\d+)", (reports / "wns.rpt").read_text()).group(1))
tns = float(re.search(r"(-?\d+\.\d+)", (reports / "tns.rpt").read_text()).group(1))
slack = re.search(r"(-?\d+\.\d+)\s+slack", (reports / "setup.rpt").read_text())
worst = float(slack.group(1)) if slack else wns
print(f"corner slow_1p08V_125C  worst setup slack {worst:.3f} ns  wns {wns:.3f}  tns {tns:.3f}  {'MET' if worst >= 0 else 'VIOLATED'}")
