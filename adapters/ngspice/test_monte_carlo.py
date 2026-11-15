"""Tests of the monte_carlo and device_limits helpers (no ngspice needed)."""

import os
import shutil
import tempfile
import unittest

import device_limits as dl
import monte_carlo as mc


class MonteCarloHelpers(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_mismatch_libs(self):
        lib = self.write("corner.lib", ".LIB hbt_typ\n.ENDL hbt_typ\n.LIB hbt_typ_mismatch\n.ENDL\n.lib res_typ\n.endl\n")
        out, rows = mc.mismatch_libs([(lib, "hbt_typ"), (lib, "res_typ"), (lib, None)], "_mismatch")
        self.assertEqual(out[0], (lib, "hbt_typ_mismatch"))
        self.assertEqual(out[1], (lib, "res_typ"))
        self.assertEqual([r["mismatch"] for r in rows], ["hbt_typ_mismatch", None, None])

    def test_inline_deck_and_instance_param(self):
        self.write("cell.spice", ".subckt cell a b\nXQ1 a b 0 0 npn13G2\n+ Nx=2\nXR1 a b 0 rppd w=1u l=2u mm_ok=0\n.ends\n.end\n")
        outside = os.path.join(tempfile.mkdtemp(), "models.lib")
        with open(outside, "w") as f:
            f.write("* models\n")
        deck = self.write("tb/deck.spice", '* bench\n.include "../cell.spice"\n.include "{}"\nX1 a b cell\n.control\nXq should not change npn13G2\n.endc\n.end\n'.format(outside))
        lines = mc.inline_deck(deck, self.dir)
        text = "\n".join(lines)
        self.assertIn("* begin include cell.spice", text)
        self.assertIn("XQ1 a b 0 0 npn13G2 Nx=2", text)  # continuation joined
        self.assertNotIn("\n.end\n* end include", text)
        self.assertIn('.include "{}"'.format(os.path.realpath(outside)), text)
        out, counts = mc.add_instance_param(lines, ["npn13G2", "rppd"], "mm_ok=1")
        joined = "\n".join(out)
        self.assertIn("XQ1 a b 0 0 npn13G2 Nx=2 mm_ok=1", joined)
        self.assertIn("rppd w=1u l=2u mm_ok=0", joined)  # an explicit value is kept
        self.assertIn("Xq should not change npn13G2", joined)  # control block untouched
        self.assertEqual(counts, {"npn13g2": 1, "rppd": 1})
        shutil.rmtree(os.path.dirname(outside))

    def test_classify_and_statistics(self):
        self.assertEqual(mc.classify("Note: Starting dynamic gmin stepping\n", {"a": 1.0}, {"a": "V"}), ("ok", "fallback"))
        self.assertEqual(mc.classify("Error: Transient op failed\n", {"a": None}, {"a": "V"}), ("no_dc", "none"))
        self.assertEqual(mc.classify("", {"a": None}, {"a": "V"}), ("failed", "newton"))
        seeds = [{"seed": 1, "status": "ok", "dc": "newton", "values": {"a": 1.0}},
                 {"seed": 2, "status": "ok", "dc": "fallback", "values": {"a": 3.0}},
                 {"seed": 3, "status": "no_dc", "dc": "none", "values": {"a": None}}]
        m = mc.statistics(seeds, {"a": "V"})
        self.assertEqual(m["a.mean"]["value"], 2.0)
        self.assertAlmostEqual(m["a.sigma"]["value"], 2 ** 0.5)
        self.assertEqual(m["a.mean"]["status"], "failed")  # a seed has no value
        self.assertEqual((m["seeds_ok"]["value"], m["seeds_no_dc"]["value"], m["seeds_fallback"]["value"]), (2, 1, 1))

    def test_option_line(self):
        self.assertEqual(mc.option_line({"reltol": 1e-3, "itl1": 1000}), ".options itl1=1000 reltol=0.001")
        self.assertIsNone(mc.option_line({"reltol": "x"}))
        self.assertIsNone(mc.option_line({"bad name": 1}))


LISTING = """   111 : q.xdut.xq1.qnpn13g2 c b 0 xdut.xq1.s1 xdut.xq1.t xdut.xq1:npn13g2_nx_vbic dtemp=0 m=1 area=1
   113 : r.xdut.xq1.rsub xdut.xq1.s1 0 r=500
   450 : n.xm1.nsg13_lv_nmos vcc g 0 0 xm1:sg13g2_lv_nmos_psp w=2e-06 l=1.3e-07 nf=2
   451 : n.xm2.nsg13_hv_pmos vcc g 0 0 xm2:sg13g2_hv_pmos_psp w=2e-06
"""
CLASSES = {"hbt": {"kind": "hbt", "letter": "q", "models": "^npn13g2[lv]?_nx_vbic$"},
           "mos_lv": {"kind": "mos", "letter": "n", "models": "^sg13g2_lv_[np]mos_psp"}}


class DeviceLimitHelpers(unittest.TestCase):
    def test_listing_and_nx(self):
        devs = dl.listing_devices(LISTING.splitlines(), CLASSES)
        self.assertEqual([(d["device"], d["class"], d["model"]) for d in devs],
                         [("q.xdut.xq1.qnpn13g2", "hbt", "npn13g2_nx_vbic"), ("n.xm1.nsg13_lv_nmos", "mos_lv", "sg13g2_lv_nmos_psp")])
        nx = dl.nx_map(["XDUT a b cell", ".subckt cell c b", "XQ1 c b 0 0 npn13G2 Nx=2", "XQ2 c b 0 0 npn13G2 Nx={n}", ".ends"], {"npn13g2"})
        self.assertEqual(nx, {"xdut.xq1": 2, "xdut.xq2": None})
        self.assertEqual(dl.device_path("q.xdut.xq1.qnpn13g2"), "xdut.xq1")

    def test_derived_and_peak(self):
        d = dl.derived("hbt", {"vbe": 0.8, "vbc": -0.6, "ic": 2e-3, "ib": -1e-7}, 2)
        self.assertAlmostEqual(d["vce"], 1.4)
        self.assertAlmostEqual(d["vcb"], 0.6)
        self.assertAlmostEqual(d["ic_per_emitter"], 1e-3)
        self.assertIsNone(dl.derived("hbt", {"vbe": 0.8, "vbc": -0.6, "ic": 2e-3}, None)["ic_per_emitter"])
        m = dl.derived("mos", {"vgs": -0.9, "vds": -1.1, "ids": -4e-4, "nf": 2}, None)
        self.assertEqual((m["vgs"], m["vds"], m["id_per_finger"]), (0.9, 1.1, 2e-4))
        p = dl.peak_values("hbt", {"vbe": [0.7, 0.9], "vbc": [-0.8, -0.2]})
        self.assertEqual(p["vce"], [0.7 - (-0.2), 0.9 - (-0.8)])
        self.assertEqual(dl.peak_values("mos", {"vds": [-1.2, 0.1]})["vds"], [0.0, 1.2])

    def test_check_limits(self):
        devs = [{"device": "a", "class": "hbt", "model": "npn13g2_nx_vbic", "dc": {"vce": 1.2, "ic_per_emitter": None}},
                {"device": "b", "class": "hbt", "model": "npn13g2_nx_vbic", "dc": {"vce": 1.7, "ic_per_emitter": 1e-3}}]
        lims = [{"id": "vce", "class": "hbt", "quantity": "vce", "op": "<=", "limit": 1.6, "source": "s"},
                {"id": "ic", "class": "hbt", "quantity": "ic_per_emitter", "op": "<=", "limit": 3.5e-3, "source": "s"},
                {"id": "mos", "class": "mos_lv", "quantity": "vds", "op": "<=", "limit": 1.6, "source": "s"},
                {"id": "vmin", "class": "hbt", "quantity": "vce", "op": ">=", "limit": 1.3, "assumption": "a"}]
        rows = {r["id"]: r for r in dl.check_limits(lims, devs, "dc")}
        self.assertEqual((rows["vce"]["status"], rows["vce"]["device"], rows["vce"]["value"]), ("fail", "b", 1.7))
        self.assertEqual(rows["ic"]["status"], "not_measured")
        self.assertIn("no value for ic_per_emitter of 1 devices (a)", rows["ic"]["reason"])
        self.assertEqual(rows["mos"]["status"], "not_applicable")
        self.assertEqual((rows["vmin"]["status"], rows["vmin"]["device"]), ("fail", "a"))
        self.assertIsNone(dl.check_limit_entries(lims, {"hbt": {"kind": "hbt"}, "mos_lv": {"kind": "mos"}}))
        self.assertIn("a source or an assumption", dl.check_limit_entries([{"id": "x", "class": "hbt", "quantity": "vce", "op": "<=", "limit": 1}], {"hbt": {"kind": "hbt"}}))
        self.assertIn("quantity must be", dl.check_limit_entries([{"id": "x", "class": "hbt", "quantity": "vds", "op": "<=", "limit": 1, "source": "s"}], {"hbt": {"kind": "hbt"}}))


if __name__ == "__main__":
    unittest.main()
