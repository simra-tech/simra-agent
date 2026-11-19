"""Tests of the device_budget operation. The two-port and noise-fit formulas need no simulator; the run needs ngspice
(no PDK: a small-signal hybrid-pi subcircuit with noisy resistors)."""

import cmath
import json
import math
import os
import shutil
import tempfile
import unittest

import device_budget as db
import ngspice_adapter as na

FAKE = """.lib x
.subckt fakeq c b e bn
rb b bi 30
rpi bi e 10k
cpi bi e 10f
g1 c e bi e 0.05
ro c e 500
cmu bi c 1f
.ends
.endl x
"""


class Formulas(unittest.TestCase):
    def test_two_port_of_a_unilateral_amplifier_and_a_noise_fit(self):
        # S21 = 10, S12 small, matched: MSG = |S21/S12|, K large
        r = db.two_port([0j, 0.01 + 0j, 10 + 0j, 0j], 50.0)
        self.assertAlmostEqual(r["msg_db"], 30.0, places=6)
        self.assertGreater(r["k"], 1)
        self.assertIsNotNone(r["mag_db"])
        # synthetic noise parameters: Fmin 1.5, Rn 20 ohm, Yopt 0.015 - 0.008j
        yopt = complex(0.015, -0.008)
        pts = []
        for z in [complex(a, b) for a in (25, 50, 100) for b in (-40, 0, 40)]:
            ys = 1 / z
            pts.append((ys, 1.5 + 20 / ys.real * abs(ys - yopt) ** 2))
        fmin, rn, y, res = db.fit_noise(pts)
        self.assertAlmostEqual(fmin, 1.5, places=9)
        self.assertAlmostEqual(rn, 20, places=7)
        self.assertAlmostEqual(abs(y - yopt), 0, places=9)
        self.assertLess(res, 1e-9)


@unittest.skipUnless(shutil.which("ngspice"), "ngspice is not installed")
class WithNgspice(unittest.TestCase):
    def test_budget_of_a_linear_device(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        os.mkdir(os.path.join(root, "work"))
        with open(os.path.join(root, "fake.lib"), "w") as fh:
            fh.write(FAKE)
        req = {"contract": na.CONTRACT, "root": root, "work_dir": os.path.join(root, "work"), "experiment": "t",
               "operation": "device_budget", "response_path": os.path.join(root, "r.json"),
               "inputs": {"device": "fakeq", "libs": [{"path": "fake.lib", "section": "x"}], "vce": 1.2, "vbe": 0.0,
                          "freq_hz": [10e9], "ft_hz": 100e9}}
        resp = db.device_budget(req)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        # gm 50 mS, C 11 fF: |h21| = gm / (w C) at 100 GHz, fT about gm / (2 pi C) = 723 GHz (the 1 fF feedback lowers it)
        self.assertAlmostEqual(m["ft_hz"]["value"] / (0.05 / (2 * math.pi * 11e-15)), 1, delta=0.1)
        self.assertLess(m["noise_fit_rel_residual"]["value"], 1e-3)
        self.assertGreater(m["nfmin_db"]["value"], 0)


if __name__ == "__main__":
    unittest.main()
