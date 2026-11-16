"""Unit tests for the operation device_crosscheck of the Xyce adapter. They do not need a simulator."""

import os
import shutil
import tempfile
import unittest

import device_crosscheck as dc

INPUTS = {"device": {"cell": "npn13G2", "params": {"Nx": 4}, "pins": ["p2", "p1", "0", "0"]}, "bias_v": [0.88, 1.2],
          "freqs_hz": [61e9, 122.5e9], "ngspice_params": {"sw_nqs": 1}}


class InputsAndDecks(unittest.TestCase):
    def test_inputs(self):
        spec, error = dc.check_inputs(INPUTS)
        self.assertIsNone(error)
        self.assertEqual(spec["tol"], {"dc_rel": 0.02, "y_rel": 0.02})
        for bad in ({"device": {"cell": "npn13G2", "pins": ["p1", "0"]}}, {"bias_v": [1.0]}, {"freqs_hz": []},
                    {"ngspice_params": {"sw_nqs": "1"}}, {"tolerance": {"y_abs": 1}}, {"device": {"cell": "a b", "pins": ["p1", "p2"]}}):
            _, error = dc.check_inputs(dict(INPUTS, **bad))
            self.assertIsNotNone(error, bad)

    def test_reference_temperature(self):
        spec, _ = dc.check_inputs(dict(INPUTS, temp_c=125, reference_temp_c=27))
        self.assertEqual((spec["temp"], spec["ref_temp"]), (125, 27))
        # The same temperature twice is one run.
        self.assertIsNone(dc.check_inputs(dict(INPUTS, temp_c=27, reference_temp_c=27))[0]["ref_temp"])
        self.assertIsNone(dc.check_inputs(INPUTS)[0]["ref_temp"])
        self.assertIsNotNone(dc.check_inputs(dict(INPUTS, reference_temp_c="27"))[1])
        # The reference run has its own files.
        ref = dict(spec, temp=27)
        self.assertIn("wrdata ng_ref_op.dat", dc.ngspice_deck(ref, [("m.lib", "hbt_typ")], "_ref"))
        self.assertIn(".temp 27", dc.ngspice_deck(ref, [("m.lib", "hbt_typ")], "_ref"))
        self.assertIn("file=xy_ref_d1.csv", dc.xyce_deck(ref, [("m.lib", "hbt_typ")], 1, "_ref"))
        self.assertIn(".options device temp=125", dc.xyce_deck(spec, [("m.lib", "hbt_typ")], 0))

    def test_the_setting_of_one_simulator_goes_to_its_deck_only(self):
        spec, _ = dc.check_inputs(INPUTS)
        ng = dc.ngspice_deck(spec, [("/pdk/hbt.lib", "hbt_typ")])
        self.assertIn("xdut p2 p1 0 0 npn13G2 Nx=4 sw_nqs=1", ng)
        self.assertIn('.lib "/pdk/hbt.lib" hbt_typ', ng)
        self.assertIn("ac lin 1 122500000000.0 122500000000.0", ng)
        self.assertEqual(ng.count("wrdata ng_d"), 4)
        xy = dc.xyce_deck(spec, [("/pdk/x/hbt.lib", "hbt_typ")], 1)
        self.assertIn("xdut p2 p1 0 0 npn13G2 Nx=4\n", xy)
        self.assertNotIn("sw_nqs", xy)
        self.assertIn(".ac data=ftab", xy)
        self.assertIn("v1 p1 0 dc 0.88 ac 1", xy)
        self.assertIn(".options device temp=27", xy)
        self.assertIn(".dc v1 0.88 0.88 1", dc.xyce_deck(spec, [], 0))

    def test_missing_libraries(self):
        root = tempfile.mkdtemp(prefix="simra-xc-")
        self.addCleanup(shutil.rmtree, root)
        libs, error = dc.libs_of(root, None, "ngspice_libs")
        self.assertIn("ngspice_libs", error)
        libs, error = dc.libs_of(root, [{"path": "no.lib", "section": "a"}], "xyce_libs")
        self.assertIn("library not found", error)
        with open(os.path.join(root, "m.lib"), "w") as f:
            f.write("* models\n")
        libs, error = dc.libs_of(root, [{"path": "m.lib"}], "xyce_libs")
        self.assertEqual(libs, [(os.path.join(root, "m.lib"), None)])


class Compare(unittest.TestCase):
    def data(self, y21):
        return {"dc": [7.9e-6, 4.555e-3], "y": [[[0.004 + 0.023j, -0.0002 - 0.005j], [y21, 0.002 + 0.0096j]]]}

    def test_an_excess_phase_difference_in_y21_is_a_finding(self):
        spec, _ = dc.check_inputs(dict(INPUTS, freqs_hz=[122.5e9]))
        # 60.9 mS at -37.3 deg against 62.97 mS at -45.1 deg: the values of an HBT without and with the excess phase.
        import cmath
        import math
        a = cmath.rect(0.0609, math.radians(-37.3))
        b = cmath.rect(0.06297, math.radians(-45.1))
        rows, found, dc_max, y_max = dc.compare(spec, self.data(a), self.data(b))
        self.assertEqual(len(found), 1)
        self.assertIn("y21 at 122.5 GHz", found[0])
        self.assertAlmostEqual(y_max, abs(a - b) / abs(b), places=12)
        self.assertGreater(y_max, 0.13)
        self.assertEqual(dc_max, 0.0)
        # the same data on both sides: no finding
        self.assertEqual(dc.compare(spec, self.data(b), self.data(b))[1], [])

    def test_small_entries_use_a_floor_and_dc_has_its_own_tolerance(self):
        spec, _ = dc.check_inputs(dict(INPUTS, freqs_hz=[1e9]))
        ng = {"dc": [8.2e-6, 4.555e-3], "y": [[[1e-6j, 1e-7j], [0.0665, 1.1e-4j]]]}
        xy = {"dc": [7.9e-6, 4.555e-3], "y": [[[1.5e-6j, 1e-7j], [0.0665, 0.7e-4j]]]}
        rows, found, dc_max, y_max = dc.compare(spec, ng, xy)
        # y11 differs by 33 % of itself, but it is far below 2 % of the largest y: no finding for it
        self.assertFalse(any(text.startswith("y11") for text in found))
        self.assertLess(y_max, 0.04)
        self.assertTrue(any(text.startswith("DC current of port 1") for text in found))
        self.assertAlmostEqual(dc_max, 0.3e-6 / 7.9e-6, places=9)

    def test_y_from_the_source_currents(self):
        y = dc.y_from((-1 - 2j, -3 + 0j), (0.5j, -4 + 0j))
        self.assertEqual(y, [[1 + 2j, -0.5j], [3 - 0j, 4 - 0j]])


if __name__ == "__main__":
    unittest.main()
