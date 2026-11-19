"""Unit tests of the operation device_limits of the ngspice adapter (deck text and parsing). They do not need ngspice."""

import unittest

import device_limits as dl


class DeviceLimitsText(unittest.TestCase):
    DEV = [{"device": "q.xdut.xq1.qnpn13g2", "kind": "hbt"}]

    def test_control_text_op_and_peak(self):
        t = dl.control_text(self.DEV, {"step_s": 1e-13, "stop_s": 9e-9, "start_s": 8.5e-9, "dc": "op"})
        self.assertIn("\nop\n", t)
        self.assertIn("print @q.xdut.xq1.qnpn13g2[ic]", t)
        self.assertIn("tran 1e-13 9e-09 8.5e-09 1e-13", t)
        self.assertIn("print maximum(@q.xdut.xq1.qnpn13g2[vbe]) minimum(@q.xdut.xq1.qnpn13g2[vbe])", t)
        self.assertNotIn("mean(", t)

    def test_control_text_mean(self):
        t = dl.control_text(self.DEV, {"step_s": 1e-13, "stop_s": 9e-9, "start_s": 8.5e-9, "dc": "mean"})
        self.assertNotIn("\nop\n", t)
        self.assertIn("wrdata means.dat @q.xdut.xq1.qnpn13g2[vbe] @q.xdut.xq1.qnpn13g2[vbc] @q.xdut.xq1.qnpn13g2[ic] @q.xdut.xq1.qnpn13g2[ib]", t)
        for q in ("vbe", "vbc", "ic", "ib"):
            self.assertIn("@q.xdut.xq1.qnpn13g2[%s]" % q, [w for line in t.splitlines() if line.startswith("save ") for w in line.split()[1:]])

    def test_whole_period_means(self):
        import math
        # 10.3 periods of a sine; the charging current cos() has mean 0 over whole periods, not over the window
        t = [k * 1e-3 for k in range(10301)]
        vbe = [0.8 + 0.1 * math.sin(2 * math.pi * x) for x in t]
        ib = [1e-6 + 1e-4 * math.cos(2 * math.pi * x) for x in t]
        plain = sum(ib) / len(ib)
        self.assertGreater(abs(plain - 1e-6), 1e-6)
        (mv, mi), n = dl.whole_period_means(t, [vbe, ib], 0)
        self.assertIn(n, (9, 10))  # rising crossings near 0, 1, ..., 10
        self.assertAlmostEqual(mv, 0.8, places=6)
        self.assertAlmostEqual(mi / 1e-6, 1.0, places=3)
        # a device without signal: the plain mean, 0 periods
        (c,), n = dl.whole_period_means(t[:10], [[0.5] * 10], 0)
        self.assertEqual(n, 0)
        self.assertAlmostEqual(c, 0.5)


if __name__ == "__main__":
    unittest.main()
