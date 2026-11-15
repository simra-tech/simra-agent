"""Unit tests of the operation oscillator of the ngspice adapter. They do not need ngspice."""

import math
import os
import shutil
import tempfile
import unittest

import oscillator as osc


class Helpers(unittest.TestCase):
    def test_crossings_and_interp(self):
        t = [i * 0.1 for i in range(41)]
        y = [math.sin(2 * math.pi * x) for x in t]
        z = osc.crossings(t, y)
        self.assertEqual(len(z), 3)  # rising crossings at 1, 2, 3 (not at t = 0: the sample before is missing)
        for a, b in zip(z, (1.0, 2.0, 3.0)):
            self.assertAlmostEqual(a, b, places=9)
        self.assertAlmostEqual(osc.interp([0, 1, 2], [0, 10, 0], 0.25), 2.5)

    def test_triangle(self):
        self.assertEqual(osc.tri(2.0, 1e-9, 1e-12), "pwl(0 0 1e-09 0 1.001e-09 2 1.002e-09 0)")

    def test_read_wrdata(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "x.dat")
            with open(p, "w") as fh:
                fh.write(" 0 1 0 2\n 1e-12 1.5 1e-12 2.5\n")
            self.assertEqual(osc.read_wrdata(p, 2), ([0.0, 1e-12], [[1.0, 1.5], [2.0, 2.5]]))
        finally:
            shutil.rmtree(d)


class Sources(unittest.TestCase):
    CIRCUIT = ["vcn1 a c1i 0", "vbn1 b b1i dc 0", "vbb vb 0 1.2", "xq1 c1i b1i e 0 npn"]

    def test_series_line(self):
        self.assertEqual(osc.series_line(self.CIRCUIT, "VCN1"), 0)
        self.assertEqual(osc.series_line(self.CIRCUIT, "vbn1"), 1)
        self.assertIsNone(osc.series_line(self.CIRCUIT, "vbb"))  # not 0 V: not a series noise source
        self.assertIsNone(osc.series_line(self.CIRCUIT, "xq1"))

    def test_check(self):
        ok = [{"name": "tank", "nodes": "vcc a", "psd_a2_hz": 1e-22, "mult": 2},
              {"name": "ce", "nodes": "c1i e", "shot": "@q.xq1.q[ic]"},
              {"name": "rc", "vsource": "vcn1", "psd_v2_hz": 1e-18}]
        self.assertIsNone(osc.check_sources(ok, self.CIRCUIT))
        for bad, text in ((ok + [ok[0]], "given twice"), ([{"name": "x", "vsource": "vbb", "psd_v2_hz": 1}], "value 0"),
                          ([{"name": "x", "nodes": "a", "psd_a2_hz": 1}], "two node names"),
                          ([{"name": "x", "nodes": "a b"}], "psd_a2_hz or shot"), ([], "non-empty"),
                          ([{"name": "x y", "nodes": "a b", "psd_a2_hz": 1}], "name of letters"),
                          ([{"name": "x", "nodes": "a b", "psd_a2_hz": [1, 2, 3]}], "one number per phase (4)")):
            self.assertIn(text, osc.check_sources(bad, self.CIRCUIT, 4))
        self.assertIsNone(osc.check_sources([{"name": "x", "nodes": "a b", "psd_a2_hz": [1, 2, 3, 4]}], self.CIRCUIT, 4))


if __name__ == "__main__":
    unittest.main()
