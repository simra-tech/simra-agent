"""Unit tests of the operation assemble_dc of the ngspice adapter. They do not need ngspice."""

import json
import os
import shutil
import tempfile
import unittest

import assemble_dc as ad

RAW = """Title: * simra
Date: today
Plotname: DC transfer characteristic
Flags: real
No. Variables: 5
No. Points: 2
Variables:
\t0\tv-sweep\tvoltage
\t1\tv(simra_gcl)\tvoltage
\t2\tv(xl.a)\tvoltage
\t3\tvdd#branch\tcurrent
\t4\txq1.q#base\tvoltage
Values:
 0\t1.0
\t1.0
\t0.9
\t-1e-3
\t0.7

 1\t0.0
\t0.0
\t0.95
\t-1.1e-3
\t0.71
"""


class Seeds(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, name, doc):
        with open(os.path.join(self.root, name), "w") as fh:
            json.dump(doc, fh)

    def test_map_filter_and_order(self):
        self.write("a.json", {"v(x1.a)": 1.0, "V(X1.B)": 0.0, "i(vdd)": 1e-3, "v(x1.q#base)": 0.7, "v(0)": 0.0, "x": "text"})
        self.write("b.json", {"nodes": {"v(xl.a)": 0.5, "v(m)": 0.3}})
        seed = ad.read_seeds([{"file": "a.json", "from_prefix": "x1.", "to_prefix": "xl."}, {"file": "b.json"}], self.root)
        self.assertEqual(seed, {"xl.a": 0.5, "xl.b": 0.0, "m": 0.3})  # later seed wins; currents and "#" nodes left out
        seed = ad.read_seeds([{"file": "b.json", "only_prefix": "xl."}], self.root)
        self.assertEqual(seed, {"xl.a": 0.5})
        seed = ad.read_seeds([{"file": "b.json", "to_prefix": "xtop."}], self.root)
        self.assertEqual(seed, {"xtop.xl.a": 0.5, "xtop.m": 0.3})

    def test_errors(self):
        with self.assertRaisesRegex(ValueError, "seeds' is required"):
            ad.read_seeds([], self.root)
        with self.assertRaisesRegex(ValueError, "file not found"):
            ad.read_seeds([{"file": "none.json"}], self.root)
        self.write("a.json", {"v(x1.a)": 1.0})
        with self.assertRaisesRegex(ValueError, "no node voltage"):
            ad.read_seeds([{"file": "a.json", "from_prefix": "x9."}], self.root)


class Clamp(unittest.TestCase):
    def test_one_phase(self):
        lines, n = ad.clamp_lines({"m": 0.3}, [], 12)
        self.assertEqual(n, 1)
        self.assertEqual(lines[1], "Vsimra_gcl simra_gcl 0 1")
        self.assertRegex(lines[2], r"^Bsimra_cl0 m 0 I=exp\(27\.63\d*\*\(min\(v\(simra_gcl\),1\)-1\)\)\*\(v\(m\)-\(0\.3\)\)$")

    def test_phases(self):
        lines, n = ad.clamp_lines({"xb.n": 1.0, "xc.n": 2.0, "z": 0.0}, [["xb."], ["xc."]], 6)
        self.assertEqual(n, 3)
        body = "\n".join(lines)
        self.assertIn("Bsimra_cl0 xb.n 0 I=exp(13.8155106*(min(max(v(simra_gcl)-2,0),1)-1))", body)  # phase 1 first
        self.assertIn("Bsimra_cl1 xc.n 0 I=exp(13.8155106*(min(max(v(simra_gcl)-1,0),1)-1))", body)
        self.assertIn("Bsimra_cl2 z 0 I=exp(13.8155106*(min(max(v(simra_gcl)-0,0),1)-1))", body)  # no phase: after them
        self.assertEqual(ad.clamp_lines({"xb.n": 1.0}, [["xb."], ["xc."]], 6)[1], 2)


class Raw(unittest.TestCase):
    def test_read(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "x.raw")
            with open(p, "w") as fh:
                fh.write(RAW)
            names, points = ad.read_raw_ascii(p)
            self.assertEqual(names, ["v-sweep", "v(simra_gcl)", "v(xl.a)", "#vdd#branch", "#xq1.q#base"])
            self.assertEqual(points, [[1.0, 1.0, 0.9, -1e-3, 0.7], [0.0, 0.0, 0.95, -1.1e-3, 0.71]])
            self.assertEqual(ad.node_key("V(XL.A)"), "xl.a")
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
