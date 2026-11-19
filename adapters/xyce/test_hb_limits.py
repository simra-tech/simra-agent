"""Tests of hb_limits without Xyce: the HBT instances with Xyce node names, the device element of a cell, the waveform
from a two-sided spectrum."""

import math
import os
import tempfile
import unittest

import hb_limits as hl


class HbLimitsTest(unittest.TestCase):
    def test_instances_resolve_pins_through_the_hierarchy(self):
        lines = [
            "* deck", "xa in out vcc 0 amp", "xq9 vcc in 0 0 npn13G2 Nx=2",
            ".subckt amp i o v g", "xs1 i mid v g stage", "xq2 o mid g 0 npn13G2 Nx=8", ".ends amp",
            ".subckt stage a b v g", "xq1 v a b g npn13G2 Nx=4", ".ends stage",
        ]
        got = {d["prefix"]: (d["nodes"], d["params"].get("nx")) for d in hl.hbt_instances(lines, {"npn13g2"})}
        self.assertEqual(got["xq9"], (["vcc", "in", "0"], "2"))
        self.assertEqual(got["xa:xq2"], (["out", "xa:mid", "0"], "8"))
        self.assertEqual(got["xa:xs1:xq1"], (["vcc", "in", "xa:mid"], "4"))

    def test_cell_element_from_the_libraries(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "corner.lib"), "w") as f:
                f.write(".lib hbt_typ\n.include 'mod.lib'\n.endl\n")
            with open(os.path.join(d, "mod.lib"), "w") as f:
                f.write(".subckt npn13G2 c b e bn\n.param Nx=1\nQnpn13G2 c b e s1 t npn13G2_NX_vbic dtemp=0 m=1\n.ends\n")
            files = hl.lib_files([(os.path.join(d, "corner.lib"), "hbt_typ")])
            self.assertEqual(hl.cell_elements(files, {"npn13g2"}), {"npn13g2": ("qnpn13g2", "npn13g2_nx_vbic")})

    def test_waveform_of_a_two_sided_spectrum(self):
        # x(t) = 1 + 0.5 cos(w t) + 0.2 sin(2 w t): X(0) = 1, X(+-f) = 0.25, X(+-2f) = -+0.1j
        f0 = 61e9
        spec = [(0.0, 1 + 0j), (f0, 0.25 + 0j), (-f0, 0.25 + 0j), (2 * f0, -0.1j), (-2 * f0, 0.1j)]
        w = hl.waveform(spec, f0, 64)
        for k in (0, 5, 17, 40):
            t = k / 64
            self.assertAlmostEqual(w[k], 1 + 0.5 * math.cos(2 * math.pi * t) + 0.2 * math.sin(4 * math.pi * t), places=12)


if __name__ == "__main__":
    unittest.main()
