"""Unit tests of the operation oscillator of the ngspice adapter. They do not need ngspice."""

import math
import os
import shutil
import tempfile
import subprocess
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

    def test_startup_t90(self):
        # a sine of 1 V whose amplitude grows linearly to 1 V at t = 10 (period 1), then stays
        t = [k / 200.0 for k in range(0, 4001)]
        y = [min(1.0, x / 10.0) * math.sin(2 * math.pi * x) for x in t]
        t90 = osc.startup_t90(t, y, 1.0)
        self.assertTrue(8.0 <= t90 <= 9.0, t90)
        self.assertIsNone(osc.startup_t90(t, [0.1 * v for v in y], 2.0))

    def test_resolve_instances(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "core.spice"), "w") as fh:
                fh.write(".subckt core a b\nxq1 a b e 0 npn13G2 Nx=2 selft=0\nr1 e 0 10\n.ends core\n")
            circuit = ['.include "%s"' % os.path.join(d, "core.spice"), "xdut n1 n2 core", "v1 n1 0 1"]
            isf = {"sources": [{"name": "ce", "instance": {"subckt": "core", "name": "xq1", "pins": [0, 2]}, "psd_a2_hz": 1e-22},
                               {"name": "rb", "instance": {"subckt": "core", "name": "xq1", "pin": 1}, "psd_v2_hz": 1e-19}],
                   "devices": [{"name": "q1", "instance": {"subckt": "core", "name": "xq1"},
                                "sweep": [["c", 0, 1, 0.1], ["b", 0, 1, 0.1]]}]}
            out, r, err = osc.resolve_instances(circuit, isf)
            self.assertIsNone(err)
            self.assertNotIn("include", out[0])  # the file that defines core is inlined
            self.assertEqual(r["sources"][0]["nodes"], "a e")
            self.assertEqual(r["sources"][0]["_subckt"], "core")
            self.assertEqual(r["sources"][1]["vsource"], "Vsimra_isf_rb")
            self.assertIn("Vsimra_isf_rb b simra_isf_rb 0", out)
            self.assertIn("xq1 a simra_isf_rb e 0 npn13G2 Nx=2 selft=0", out)
            self.assertIsNotNone(osc.series_line(out, "Vsimra_isf_rb"))
            self.assertEqual(r["devices"][0]["lines"], ["xq1 c b 0 0 npn13G2 Nx=2 selft=0"])
            self.assertIsNone(isf["sources"][0].get("nodes"))  # the input is not changed
            _, _, err = osc.resolve_instances(circuit, {"sources": [{"name": "x", "instance": {"subckt": "core", "name": "xq9", "pins": [0, 1]}}]})
            self.assertIn("no instance xq9", err)
        finally:
            shutil.rmtree(d)

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
                          ([{"name": "x", "nodes": "a b"}], "psd_a2_hz, thermal_ohm or shot"), ([], "non-empty"),
                          ([{"name": "x y", "nodes": "a b", "psd_a2_hz": 1}], "name of letters"),
                          ([{"name": "x", "nodes": "a b", "psd_a2_hz": [1, 2, 3]}], "one number per phase (4)")):
            self.assertIn(text, osc.check_sources(bad, self.CIRCUIT, 4))
        self.assertIsNone(osc.check_sources([{"name": "x", "nodes": "a b", "psd_a2_hz": [1, 2, 3, 4]}], self.CIRCUIT, 4))



class NoiseTerms(unittest.TestCase):
    """Each source term against its bound (2qI, 4kT/R, 4kTR) at the temperature of the condition, the quasi-static
    flicker formula, and the check of the conduction table (R2 faults of 2026-11-16: a source in the wrong unit,
    noise sources at 27 C at every corner, a missing slow flicker path)."""

    def test_shot_noise_is_2qI_of_the_table_at_each_phase(self):
        cond = {"q1": [{"ic": 2.5e-3, "ib": -1.7e-5}, {"ic": 0.0, "ib": 4e-6}]}
        psd, bound = osc.source_psd({"name": "ce", "nodes": "c e", "shot": {"device": "q1", "current": "ic"}}, 2, cond, None, 398.15)
        self.assertEqual(bound, "2qI")
        self.assertAlmostEqual(psd[0], 2 * 1.602176634e-19 * 2.5e-3, delta=1e-30)
        self.assertEqual(psd[1], 0.0)
        psd, _ = osc.source_psd({"name": "be", "nodes": "b e", "shot": {"device": "q1", "current": "ib"}}, 2, cond, None, 300)
        self.assertAlmostEqual(psd[0], 2 * 1.602176634e-19 * 1.7e-5, delta=1e-32)      # |I|
        psd, _ = osc.source_psd({"name": "x", "nodes": "a b", "shot": "@q[ic]"}, 2, cond, [1e-3, -2e-3], 300)
        self.assertEqual(psd, [2 * 1.602176634e-19 * 1e-3, 2 * 1.602176634e-19 * 2e-3])

    def test_thermal_noise_uses_the_temperature_of_the_condition(self):
        k = 1.380649e-23
        cold, _ = osc.source_psd({"name": "r", "nodes": "a b", "thermal_ohm": 100.0}, 3, {}, None, 233.15)
        hot, bound = osc.source_psd({"name": "r", "nodes": "a b", "thermal_ohm": 100.0}, 3, {}, None, 398.15)
        self.assertEqual(bound, "4kT/R")
        self.assertAlmostEqual(hot[0], 4 * k * 398.15 / 100, delta=1e-36)
        self.assertAlmostEqual(hot[0] / cold[0], 398.15 / 233.15)
        v, bound = osc.source_psd({"name": "rb", "vsource": "vb", "thermal_ohm": 25.0}, 1, {}, None, 300.15)
        self.assertEqual(bound, "4kTR")
        self.assertAlmostEqual(v[0], 4 * k * 300.15 * 25.0, delta=1e-30)
        self.assertIn("positive resistance", osc.check_sources([{"name": "r", "nodes": "a b", "thermal_ohm": -1}], []))
        self.assertIsNone(osc.check_sources([{"name": "r", "nodes": "a b", "thermal_ohm": 50}], []))

    def test_quasi_static_flicker(self):
        fl = {"kf": 1.2e-8, "af": 1.8, "bf": 1.0}
        w = osc.flicker_weight([6e-6, -6e-6, 6e-6], 1.8)
        self.assertAlmostEqual(w, 6e-6 ** 0.9)
        # K 2.3e12 Hz/A (2.3 MHz per uA at 61 GHz), two sources, 1 MHz: L = 2 * 1/2 * K^2 * kf * w^2 / df / df^2
        lq = osc.quasi_static_l(2.3e12, w, fl, 2, 1e6)
        self.assertAlmostEqual(lq, (2.3e12) ** 2 * 1.2e-8 * w ** 2 / 1e6 / 1e12, delta=1e-20)
        # 1/f^3: 10 dB per decade of bf=1 flicker plus 20 dB of the FM
        self.assertAlmostEqual(10 * math.log10(osc.quasi_static_l(2.3e12, w, fl, 2, 1e5) / lq), 30.0)
        src = [{"name": "be", "nodes": "b e", "psd_a2_hz": 1e-24, "flicker": dict(fl, device="q1", current="ib")},
               {"name": "ce", "nodes": "c e", "psd_a2_hz": 1e-24}]
        self.assertIsNone(osc.check_quasi_static([{"source": "be", "step_a": 1e-6}], src))
        self.assertIn("with flicker", osc.check_quasi_static([{"source": "ce"}], src))
        self.assertIn("positive current", osc.check_quasi_static([{"source": "be", "step_a": 0}], src))

    def test_table_check_finds_a_table_of_another_corner(self):
        rows = [{"ic": 2.4e-3}, {"ic": 2.6e-3}]
        self.assertIsNone(osc.table_check(rows, "ic", 2.55e-3, 0.1))
        # R2 slow 125 C with a typical 27 C table: 0.52 mA in the table, 2.31 mA at the terminal
        why = osc.table_check([{"ic": 0.52e-3}], "ic", 2.31e-3, 0.1)
        self.assertIn("does not fit the transient", why)
        t = [0, 1, 2, 3, 4]
        self.assertAlmostEqual(osc.mean_over_periods(t, [0, 2, 0, 2, 0], 0, 4), 1.0)
        self.assertAlmostEqual(osc.mean_over_periods(t, [1, 1, 1, 1, 1], 0.5, 3.5), 1.0)



LC = ["* LC with a nonlinear conductance g1 v - g3 v^3 (negative g1 starts, positive g1 does not)",
      "l1 a 0 1n", "c1 a 0 1p", "bg a 0 i={g1}*v(a)+{g3}*v(a)^3", "ik 0 a pwl(0 0 10p 1m 20p 0)"]


class StartCheck(unittest.TestCase):
    def test_check_points_and_parse(self):
        pts = osc.start_checks(8e-9, 1e-8, True)
        self.assertEqual([round(p[0] * 1e9, 6) for p in pts], [4.0, 6.0])
        self.assertEqual([round(x * 1e9, 6) for x in pts[0][1] + pts[0][2]], [2.0, 3.0, 3.0, 4.0])
        self.assertEqual(osc.start_checks(8e-9, 5e-9, True)[-1][0], 4e-9)   # only points before tstop
        self.assertEqual(osc.start_checks(8e-9, 1e-8, False), [])
        self.assertEqual(osc.no_start("x\nSIMRA_NO_START 4e-09 0.02 0.002\n"), (4e-09, 0.01, 0.001))
        self.assertIsNone(osc.no_start("no line"))

    @unittest.skipUnless(shutil.which("ngspice"), "ngspice is not on PATH")
    def test_a_decaying_oscillator_stops_at_the_first_check_and_a_starting_one_runs_to_the_end(self):
        """A circuit that does not start ends at settle_s/2 with the NO_START line; one that starts slowly (envelope
        growth of about 7 % per ns) and one that is in steady state run to tstop with the full data."""
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work)
        settle, tstop = 8e-9, 1e-8
        start = {"points": osc.start_checks(settle, tstop, True), "expr": "v(a)", "factor": 0.9, "start_v": 0.05}
        cases = {"decays": (0.4e-3, 0.0), "slow_start": (-0.12e-3, 1e-3), "starts": (-3e-3, 1e-3)}
        out = {}
        for name, (g1, g3) in cases.items():
            deck = osc.deck_text([], LC + [".param g1=%g g3=%g" % (g1, g3)], [], [], 1e-12, tstop, ["v(a)"], name + ".dat", start)
            with open(os.path.join(work, name + ".cir"), "w") as fh:
                fh.write(deck)
            log = subprocess.run(["ngspice", "-b", name + ".cir"], cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=120).stdout
            t, _ = osc.read_wrdata(os.path.join(work, name + ".dat"), 1) if os.path.exists(os.path.join(work, name + ".dat")) else ([], [])
            out[name] = (osc.no_start(log), t[-1] if t else None)
        self.assertIsNotNone(out["decays"][0], out)
        self.assertAlmostEqual(out["decays"][0][0], 4e-9)
        self.assertIsNone(out["decays"][1])                      # no data: the run ended at the check
        for name in ("slow_start", "starts"):
            self.assertIsNone(out[name][0], out)
            self.assertAlmostEqual(out[name][1], tstop, delta=2e-12)


if __name__ == "__main__":
    unittest.main()
