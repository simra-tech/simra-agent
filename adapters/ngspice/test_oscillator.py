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


class Conduction(unittest.TestCase):
    def test_table_linear_and_outside(self):
        # grid in the swept voltages (u, w), mapped to the axes x = u - 0.1 w, y = 0.5 w + 0.05 u (a sheared grid)
        n1, n2 = 21, 11
        xs, ys, f = [], [], []
        for j in range(n2):
            for i in range(n1):
                u, w = -1 + 0.1 * i, 0.1 * j
                xs.append(u - 0.1 * w)
                ys.append(0.5 * w + 0.05 * u)
                f.append(3 * xs[-1] - 2 * ys[-1] + 1)  # linear in the axes: exact under linear interpolation
        t = osc.Table(xs, ys, {"ic": f}, n1, n2)
        for x, y in ((0.0, 0.2), (-0.5, 0.31), (0.77, 0.43)):
            self.assertAlmostEqual(t(x, y)["ic"], 3 * x - 2 * y + 1, places=9)
        self.assertIsNone(t(5.0, 5.0))

    def test_model_lines(self):
        circuit = [".lib /m/cornerHBT.lib hbt_typ", "vcc vcc 0 1.8", ".subckt sub a b", "r1 a b 1k", ".ends sub",
                   "xq1 c b e 0 npn13G2", ".param k=2", ".options reltol=1e-5"]
        self.assertEqual(osc.model_lines(circuit), [".lib /m/cornerHBT.lib hbt_typ", ".subckt sub a b", "r1 a b 1k",
                                                    ".ends sub", ".param k=2", ".options reltol=1e-5"])
        text, _ = osc.table_deck([], [], {"name": "q", "lines": ["x1 c b 0 0 npn13G2"], "sweep": [["c", 0, 1, 0.5], ["b", 0, 1, 0.5]],
                                         "axes": ["a", "b"], "currents": {"ic": "c"}}, "t.dat", circuit)
        self.assertLess(text.index(".lib /m/cornerHBT.lib"), text.index("x1 c b 0 0 npn13G2"))
        self.assertNotIn("vcc vcc 0 1.8", text)

    def test_deck_and_checks(self):
        dev = {"name": "q1", "lines": ["x1 c b 0 0 npn13G2 Nx=2"], "sweep": [["c", -1, 2.6, 0.01], ["b", -0.6, 1.1, 0.005]],
               "axes": ["@q.x1.q[vbe]", "@q.x1.q[vbc]"], "at": ["@q.xq1.q[vbe]", "@q.xq1.q[vbc]"],
               "currents": {"ic": "@q.x1.q[ic]", "ib": "@q.x1.q[ib]"}}
        text, n = osc.table_deck([("m.lib", "hbt_typ")], [".temp 27"], dev, "t.dat")
        self.assertEqual(n, 4)
        self.assertIn("dc Vsimra_t1 -1 2.6 0.01 Vsimra_t2 -0.6 1.1 0.005", text)
        self.assertIn("wrdata t.dat @q.x1.q[vbe] @q.x1.q[vbc] @q.x1.q[ib] @q.x1.q[ic]", text)
        self.assertEqual(osc.grid_shape(dev), (361, 341))
        self.assertIsNone(osc.check_devices([dev]))
        self.assertIn("each isf device needs", osc.check_devices([{"name": "q1"}]))
        src = [{"name": "be", "nodes": "b e", "shot": {"device": "q1", "current": "ib"},
                "flicker": {"device": "q1", "current": "ib", "kf": 1e-8, "af": 1.8, "bf": 1}}]
        self.assertIsNone(osc.check_sources(src, [], 32, [dev]))
        src[0]["shot"] = {"device": "q2", "current": "ib"}
        self.assertIn("must name a device", osc.check_sources(src, [], 32, [dev]))
        src[0]["shot"] = {"device": "q1", "current": "ib"}
        del src[0]["flicker"]["kf"]
        self.assertIn("flicker needs", osc.check_sources(src, [], 32, [dev]))


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
