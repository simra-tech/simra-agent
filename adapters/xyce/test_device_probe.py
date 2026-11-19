"""Unit tests of the operation probe_devices of the xyce adapter: the classification of one probe deck from the logs
of "Xyce -norun" and of the run, and the csv value. The fixtures are Xyce 7.10 outputs (fixtures/README.md)."""

import os
import shutil
import tempfile
import unittest

import device_probe

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def lines(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return f.read().splitlines()


class ClassifyTest(unittest.TestCase):
    def test_hbt_simulates_with_fidelity_warnings(self):
        value = device_probe.read_value(os.path.join(FIXTURES, "probe-hbt_npn13G2.csv"))
        self.assertAlmostEqual(value, -5.92127198e-04)
        status, reason, warnings, gaps = device_probe.classify(lines("probe-hbt_npn13G2.norun.log"), [], value, "/design", "/design/work")
        self.assertEqual((status, reason, gaps), ("simulates", None, []))
        self.assertTrue(warnings and warnings[0].startswith("parameter ignored: No model parameter VBE_MAX"))

    def test_r3_cmc_resistor_card_is_a_gap(self):
        status, reason, _, gaps = device_probe.classify(lines("probe-res_rsil.norun.log"), None, None, "/design", "/design/work")
        self.assertEqual(status, "fails")
        self.assertEqual(gaps, ["parameter_unrecognized"])
        self.assertEqual(reason, "parameter unrecognized: Unrecognized parameter 1 for device YR3_CMC!R1 (/pdk/ihp-sg13g2/libs.tech/xyce/models/resistors_mod.lib:66)")

    def test_missing_varactor_subcircuit_is_a_gap(self):
        status, reason, _, gaps = device_probe.classify(lines("probe-varactor_hv.norun.log"), None, None, "/design", "/design/work")
        self.assertEqual((status, gaps), ("fails", ["subcircuit_missing"]))
        self.assertTrue(reason.startswith("subcircuit missing: Subcircuit SG13_HV_SVARICAP has not been defined for instance XDUT"))

    def test_no_value_after_a_clean_parse_is_parses(self):
        status, reason, _, _ = device_probe.classify(lines("probe-hbt_npn13G2.norun.log"), ["DC Operating Point Failed."], None, "/d", "/d/w")
        self.assertEqual((status, reason), ("parses", "DC Operating Point Failed."))

    def test_read_value_needs_the_column(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "x.csv")
        with open(path, "w") as f:
            f.write("V(A)\n1.0\n")
        self.assertIsNone(device_probe.read_value(path))
        self.assertIsNone(device_probe.read_value(os.path.join(d, "none.csv")))


if __name__ == "__main__":
    unittest.main()
