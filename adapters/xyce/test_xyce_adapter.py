"""Unit tests for the Xyce adapter. They do not need Xyce: the fixtures are excerpts of Xyce 7.10 logs and outputs
(fixtures/README.md says where each comes from)."""

import math
import os
import shutil
import tempfile
import unittest

import xyce_adapter as adapter

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def lines(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return f.read().splitlines()


class LogTest(unittest.TestCase):
    def test_psp_model_is_a_gap_and_ignored_soa_parameters_are_warnings(self):
        found = adapter.findings(adapter.log_blocks(lines("norun-psp.log")), "/design", "/design/work")
        classes = [f["class"] for f in found]
        self.assertIn("parameter_unrecognized", classes)
        gap = [f for f in found if f["class"] == "parameter_unrecognized"][0]
        self.assertEqual(gap["groups"], ["D", "YPSP103_VA!M1"])
        self.assertEqual(gap["severity"], "error")
        self.assertTrue(gap["source"].endswith("sg13g2_moslv_mod.lib:74"))
        ignored = [f["groups"][0] for f in found if f["class"] == "parameter_ignored"]
        self.assertEqual(ignored, ["VBE_MAX", "VBC_MAX", "VCE_MAX"])

    def test_bsim4_version_substitution_and_device_count(self):
        log = lines("norun-bsim4.log")
        found = adapter.findings(adapter.log_blocks(log), "/design", "/design/work")
        sub = [f for f in found if f["class"] == "version_substituted"]
        self.assertEqual(len(sub), 1)
        self.assertEqual(sub[0]["groups"][1:], ["BSIM4 version 4.5", "4.6.1"])
        self.assertEqual(sub[0]["severity"], "warning")
        self.assertEqual(adapter.device_counts(log)[0], {"letter": "M", "level": "14", "model": "BSIM4", "count": 1})

    def test_missing_models(self):
        found = adapter.findings(adapter.log_blocks(lines("norun-missing.log")), "/design", "/design/work")
        self.assertEqual([f["groups"][0] for f in found if f["class"] == "model_missing"], ["M1", "M2", "Q1"])

    def test_ignored_dot_line_names_the_line(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        with open(os.path.join(d, "tran.cir"), "w") as f:
            f.write("* rc\n.temp 50\n")
        found = adapter.findings(adapter.log_blocks(lines("temp-ignored.log")), d, d)
        first = found[0]
        self.assertEqual(first["class"], "dot_line_ignored")
        self.assertIn("'.temp 50'", first["message"])
        self.assertEqual(first["source"], "tran.cir:2")

    def test_measure_file(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        shutil.copy(os.path.join(FIXTURES, "measure.mt0"), os.path.join(d, "top.cir.mt0"))
        values = adapter.measure_files(d, "top.cir")
        self.assertEqual(values["VEND"][0][0], 0.9817401)
        self.assertIsNone(values["NOTHERE"][0][0])
        self.assertEqual(values["NEVER"][0][1], "work/top.cir.mt0:3")


class GuardTest(unittest.TestCase):
    def test_temp_line_and_ylin_with_an_ac_analysis(self):
        deck = [("tb.cir", 1, "* tb"), ("tb.cir", 2, ".temp 85"), ("tb.cir", 3, "ylin y1 a 0 b 0 lmod"), ("tb.cir", 4, ".ac lin 10 1e9 2e9")]
        diags = adapter.guard_diagnostics(deck, "simulate")
        self.assertEqual([d["source"] for d in diags], ["tb.cir:2", "tb.cir:4"])
        self.assertIn("ignores .temp", diags[0]["message"])
        self.assertIn("open circuit", diags[1]["message"])
        self.assertEqual([d["source"] for d in adapter.guard_diagnostics(deck, "hb")], ["tb.cir:2"], "YLIN is valid in HB")

    def test_settings_come_before_the_deck(self):
        settings, err = adapter.setting_lines({"params": {"rval": "2k", "c": 1e-6}, "temp_c": -40})
        self.assertIsNone(err)
        self.assertEqual(settings, [".param c=1e-06", ".param rval=2k", ".options device temp=-40"])
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        top = os.path.join(d, "top.cir")
        adapter.write_top(top, "t", settings, [("/m.lib", "tt")], "/deck.cir")
        with open(top) as f:
            text = f.read().splitlines()
        self.assertLess(text.index(".param rval=2k"), text.index('.include "/deck.cir"'))
        self.assertEqual(adapter.setting_lines({"temp_c": "hot"})[1], "input 'temp_c' must be a finite number (degrees Celsius)")

    def test_circuit_lines_remove_analyses_and_outputs(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        with open(os.path.join(d, "sub.cir"), "w") as f:
            f.write("* sub\n")
        with open(os.path.join(d, "amp.cir"), "w") as f:
            f.write("* amp\n.include sub.cir\nr1 a b 1k\n.hb 1e9\n.options hbint numfreq=5\n.options device temp=27\n"
                    ".print hb_fd v(a)\n.step r1 list 1 2\n.end\n")
        kept, removed = adapter.circuit_lines(os.path.join(d, "amp.cir"))
        self.assertEqual(kept[1], '.include "{}"'.format(os.path.join(d, "sub.cir")))
        self.assertIn(".options device temp=27", kept)
        self.assertEqual(removed, [".hb 1e9", ".options hbint numfreq=5", ".print hb_fd v(a)", ".step r1 list 1 2"])


class HarmonicBalanceTest(unittest.TestCase):
    def test_power_per_harmonic_from_a_two_sided_spectrum(self):
        # fixtures/hb-cubic.csv: v(out) = 2 v(a) + 0.4 v(a)^3 with v(a) = 0.25 cos; rl = 50 ohm; i(vcc) = -1.5 mA.
        rows = adapter.read_hb_csv(os.path.join(FIXTURES, "hb-cubic.csv"))
        ports = [("out", {"node": "out", "ref": "0", "r_ohm": 50.0})]
        point, why = adapter.hb_point(rows, ports, {"h1": [1], "h3": [3]}, ["vcc"], [1e9])
        self.assertIsNone(why)
        a1 = 2 * 0.25 + 0.75 * 0.4 * 0.25 ** 3
        a3 = 0.25 * 0.4 * 0.25 ** 3
        self.assertAlmostEqual(point["p"]["out"]["h1"], 10 * math.log10(a1 ** 2 / 2 / 50 / 1e-3), places=9)
        self.assertAlmostEqual(point["p"]["out"]["h3"], 10 * math.log10(a3 ** 2 / 2 / 50 / 1e-3), places=6)
        self.assertAlmostEqual(point["i"]["vcc"], -1.5e-3, places=12)
        _, why = adapter.hb_point(rows, ports, {"h9": [9]}, [], [1e9])
        self.assertIn("not in the output", why)

    def test_p1db_interpolates_inside_a_converged_bracket(self):
        pts = [{"pin": p, "ok": True, "gain": {"out": g}} for p, g in ((-20, 10.0), (-10, 9.8), (0, 9.4), (5, 8.6), (10, 7.0))]
        pin, pout, why = adapter.p1db(pts, "out")
        self.assertIsNone(why)
        self.assertAlmostEqual(pin, 0 + (9.0 - 9.4) * 5 / (8.6 - 9.4))
        self.assertAlmostEqual(pout, pin + 9.0)

    def test_p1db_is_invalid_when_a_point_inside_the_bracket_failed(self):
        pts = [{"pin": p, "ok": ok, "gain": {"out": g} if ok else {}} for p, ok, g in
               ((-20, True, 10.0), (-10, True, 9.8), (0, False, None), (5, True, 8.6), (10, False, None))]
        pin, _, why = adapter.p1db(pts, "out")
        self.assertIsNone(pin)
        self.assertIn("0 dBm did not converge", why)
        # A failed point after the bracket does not matter.
        pts[2] = {"pin": 0, "ok": True, "gain": {"out": 9.4}}
        self.assertIsNotNone(adapter.p1db(pts, "out")[0])
        self.assertIn("no 1 dB compression", adapter.p1db(pts[:2], "out")[2])

    def test_hb_inputs(self):
        spec, err = adapter.hb_inputs({"tones": [1e9], "ports": {"out": {"node": "out", "r_ohm": 50}}})
        self.assertIsNone(err)
        self.assertEqual((spec["harmonics"], spec["startup"], list(spec["products"])), ([25], 10, ["h1", "h2", "h3"]))
        self.assertIn("'products' is required", adapter.hb_inputs({"tones": [1e9, 1.1e9], "ports": {"o": {"node": "o", "r_ohm": 50}}})[1])
        self.assertIn("more harmonics", adapter.hb_inputs({"tones": [1e9], "harmonics": 3, "products": {"h5": [5]},
                                                           "ports": {"o": {"node": "o", "r_ohm": 50}}})[1])
        self.assertIn("'ports' is required", adapter.hb_inputs({"tones": [1e9]})[1])


class TemperatureMethodTest(unittest.TestCase):
    def test_dtemp_tf(self):
        d = tempfile.mkdtemp()
        try:
            lib = os.path.join(d, "cornerHBT.lib")
            with open(lib, "w") as fh:
                fh.write(".LIB hbt_typ\n.param vbic_tf = 1.0\n.include sg13g2_hbt_mod.lib\n.ENDL hbt_typ\n")
            with open(os.path.join(d, "core.spice"), "w") as fh:
                fh.write(".subckt core a b\nxq1 a b 0 0 npn13G2 Nx=2\nxq2 a b 0 0 npn13g2 Nx=8 m=1\nr1 a b 10\n.ends core\n")
            circuit = ['.include "%s"' % os.path.join(d, "core.spice"), "xdut n1 n2 core"]
            inputs, libs, flat, msg, err = adapter.apply_dtemp_tf({"temp_c": 125}, [(lib, "hbt_typ"), ("/x/cornerCAP.lib", "cap_typ")], circuit, d)
            self.assertIsNone(err)
            self.assertEqual(inputs["temp_c"], 27)
            self.assertIsNone(libs[0][1])
            self.assertEqual(libs[1], ("/x/cornerCAP.lib", "cap_typ"))
            text = open(libs[0][0]).read()
            k = ((125 + 273.0) / 300.0) ** 0.7
            self.assertIn("{1.0*%.6f}" % k, text)
            self.assertIn('.include "%s"' % os.path.join(d, "sg13g2_hbt_mod.lib"), text)
            self.assertIn("xq1 a b 0 0 npn13G2 Nx=2 dtemp=98", flat)
            self.assertIn("xq2 a b 0 0 npn13g2 Nx=8 m=1 dtemp=98", flat)
            self.assertIn("r1 a b 10", flat)
            self.assertIn("on 2 npn13G2 instances", msg)
            # unchanged at 27 C; an instance with its own dtemp is an error
            self.assertEqual(adapter.apply_dtemp_tf({"temp_c": 27}, [(lib, "hbt_typ")], circuit, d)[2], circuit)
            bad = ["xq9 a b 0 0 npn13G2 dtemp=3"]
            self.assertIn("already sets dtemp", adapter.apply_dtemp_tf({"temp_c": 125}, [(lib, "hbt_typ")], bad, d)[4])
            self.assertIn("needs the HBT corner library", adapter.apply_dtemp_tf({"temp_c": 125}, [], circuit, d)[4])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
