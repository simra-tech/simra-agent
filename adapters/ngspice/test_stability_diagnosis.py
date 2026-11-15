"""Tests of the stability_diagnosis operation. The mu and netlist parts need no simulator; the node impedance run
needs ngspice (no PDK: the circuit has ideal elements only)."""

import json
import os
import shutil
import tempfile
import unittest

import ngspice_adapter as na
import stability_diagnosis as sd

DECK = """* two-port bench: a tank (1 nH, 1 pF: 5.03 GHz) with a -100 ohm resistor at the input node
.param ltank=1n
Ltank in 0 {ltank}
Ctank in 0 1p
Rneg in 0 -100
Rser in out 20
Rload out 0 200
V1 in 0 dc 0 ac 1 portnum 1 z0 50
V2 out 0 dc 0 ac 0 portnum 2 z0 50
.control
sp lin 11 4.5g 5.5g
.endc
.end
"""


def s2p(points):
    """A version 1 RI 2-port file: [(f, s11, s21, s12, s22)]."""
    rows = ["# Hz S RI R 50"]
    for f, *s in points:
        rows.append(" ".join([repr(f)] + ["{} {}".format(x.real, x.imag) for x in s]))
    return "\n".join(rows) + "\n"


class Unit(unittest.TestCase):
    def test_mu_and_touchstone(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        path = os.path.join(root, "a.s2p")
        with open(path, "w") as fh:
            fh.write(s2p([(4e9, 0.2, 0.5, 0.01, 0.2), (5e9, 1.3 + 0j, 0.5, 0.01, 0.2), (6e9, 0.2, 0.5, 0.01, 0.2)]))
        f, s, z0 = sd.read_touchstone(path)
        self.assertEqual(z0, 50.0)
        self.assertAlmostEqual(s[1][1][0].real, 0.5)  # S21 of version 1 order
        m = sd.mu_summary(f, s, z0, [0, 1e12])
        self.assertEqual(m["f_hz"], 5e9)
        self.assertLess(m["mu"], 1)
        self.assertEqual(m["bands_below_1_hz"], [[5e9, 5e9]])
        self.assertLess(m["zin_ohm"][0], 0)

    def test_walk_counts_device_blocks_not_line_models(self):
        lines = ["* bench", ".subckt amp a b", "xq a b 0 0 npn13g2 nx=2", "xl a b line len=1u", ".ends",
                 ".subckt line p q", "l1 p m 1p", "c1 m 0 1f", "r1 m q 1", ".ends",
                 "xa n1 n2 amp", ".control", "let x = 1", ".endc"]
        subs = sd.subckt_table(lines)
        elements, counted = sd.walk(lines, subs)
        self.assertEqual(sorted(counted), ["n1", "n2"])
        names = {e["name"]: e for e in elements}
        self.assertEqual(names["xa.xq"]["device"], "npn13g2")
        self.assertFalse(names["xa.xl.l1"]["design"])
        self.assertEqual(names["xa.xl.l1"]["nodes"], ["n1", "xa.xl.m"])

    def test_port_lines(self):
        out, n = sd.port_lines(["V1 in 0 dc 0.5 ac 1 portnum 1 z0 75", "R1 in 0 1k"])
        self.assertEqual(n, 1)
        self.assertEqual(out[:2], ["V1 in simra_port_v1 dc 0.5", "RV1_z0 simra_port_v1 0 75.0 noisy=0"])


@unittest.skipUnless(shutil.which("ngspice"), "ngspice is not installed")
class WithNgspice(unittest.TestCase):
    def test_negative_resistance_and_lc_pair(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        os.mkdir(os.path.join(root, "work"))
        with open(os.path.join(root, "bench.spice"), "w") as fh:
            fh.write(DECK)
        with open(os.path.join(root, "t.s2p"), "w") as fh:
            fh.write(s2p([(4.5e9, 0.2, 0.5, 0.01, 0.2), (5e9, 1.4 + 0j, 0.5, 0.01, 0.2), (5.5e9, 0.2, 0.5, 0.01, 0.2)]))
        request = {"contract": na.CONTRACT, "root": root, "work_dir": os.path.join(root, "work"), "experiment": "t",
                   "operation": "stability_diagnosis", "response_path": os.path.join(root, "response.json"),
                   "inputs": {"deck": "bench.spice", "touchstone": "t.s2p", "window": 0.1, "points": 21}}
        resp = sd.stability_diagnosis(request)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        with open(os.path.join(root, "work", "stability.json")) as fh:
            out = json.load(fh)
        self.assertEqual(out["mu"]["f_hz"], 5e9)
        self.assertEqual(out["ports"], 2)
        node = {r["node"]: r for r in out["nodes"]}["in"]
        self.assertAlmostEqual(node["resonance_hz"] / 5.03e9, 1, delta=0.02)
        self.assertEqual(out["element_pairs"][0]["l"], "ltank {ltank}")
        self.assertAlmostEqual(out["element_pairs"][0]["f_res_hz"] / 5.033e9, 1, delta=0.01)
        self.assertIn("in", out["resonant_nodes"] + out["negative_resistance_nodes"])
        self.assertIn("mu min", resp["diagnostics"][-1]["message"])


if __name__ == "__main__":
    unittest.main()
