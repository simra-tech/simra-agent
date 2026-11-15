#!/usr/bin/env python3
"""Unit tests of the openEMS adapter that need no openEMS and no gdstk: stackup, plan, mesh, log, Touchstone, merge.
The real solver run is the container test (test/openems-container.test.mjs)."""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import openems_adapter as oa  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
LINE = {"M1": [[(0, -60), (300, -60), (300, 60), (0, 60)]], "M2": [[(0, -9), (300, -9), (300, 9), (0, 9)]]}
PORTS = [{"name": "in", "x": 0, "y": 0, "from": "M1", "to": "M2"}, {"name": "out", "x": 300, "y": 0, "from": "M1", "to": "M2"}]


def stackup():
    return oa.read_stackup(os.path.join(FIX, "stackup-small.xml"))


class Stackup(unittest.TestCase):
    def test_dielectrics_bottom_first_and_layer_offset(self):
        st = stackup()
        self.assertEqual([d["name"] for d in st["dielectrics"]], ["Si", "Ox", "AIR"])
        self.assertEqual((st["dielectrics"][1]["zmin"], st["dielectrics"][1]["zmax"]), (50.0, 60.0))
        self.assertEqual(st["top"], 160.0)
        m2 = [l for l in st["layers"] if l["name"] == "M2"][0]
        self.assertEqual((m2["zmin"], m2["zmax"], m2["gds"]), (56.0, 58.0, 134))

    def test_metal_layers_skip_dielectric_material(self):
        self.assertEqual([l["name"] for l in oa.metal_layers(stackup())], ["M1", "M2", "V1"])

    def test_via_from_sheet_below_to_its_top(self):
        st = stackup()
        v1 = [l for l in st["layers"] if l["name"] == "V1"][0]
        self.assertEqual(oa.via_z(v1, st), (51.0, 56.0))

    def test_port_heights(self):
        st = stackup()
        self.assertEqual(oa.port_z("M1", st), 51.0)
        self.assertEqual(oa.port_z("bottom", st), 0.0)
        self.assertIsNone(oa.port_z("V1", st))


class Mesh(unittest.TestCase):
    def test_fixed_lines_kept_and_max_cell(self):
        lines = oa.smooth_lines([0, 10, 11, 50], 5)
        for x in (0, 10, 11, 50):
            self.assertIn(x, lines)
        cells = [b - a for a, b in zip(lines, lines[1:])]
        self.assertLessEqual(max(cells), 5 + 1e-9)
        self.assertGreater(min(cells), 0)

    def test_graded_growth_in_a_long_gap(self):
        lines = oa.smooth_lines([0, 1, 100], 20, ratio=1.4)
        cells = [b - a for a, b in zip(lines, lines[1:])]
        growth = max(max(b / a, a / b) for a, b in zip(cells, cells[1:]))
        self.assertLess(growth, 2.0)
        self.assertLess(len(lines), 40)


class Plan(unittest.TestCase):
    def plan(self, **kw):
        inputs = dict({"band_hz": [1e9, 60e9], "points": 60, "ports": PORTS}, **kw)
        return oa.build_plan(inputs, stackup(), LINE)

    def test_plan_ports_metals_band(self):
        p = self.plan()
        self.assertEqual([(q["z0"], q["z1"]) for q in p["ports"]], [(51.0, 56.0), (51.0, 56.0)])
        self.assertEqual(p["excite"], [1, 2])
        self.assertEqual(len(p["f_hz"]), 60)
        self.assertEqual(p["boundaries"], oa.DEFAULT_BOUNDARIES)
        self.assertEqual({m["name"]: m["kind"] for m in p["metals"]}, {"M1": "sheet", "M2": "sheet"})
        for z in (0.0, 51.0, 56.0, 160.0):
            self.assertIn(z, p["mesh"]["z"])
        self.assertEqual(p["cells"], (len(p["mesh"]["x"]) - 1) * (len(p["mesh"]["y"]) - 1) * (len(p["mesh"]["z"]) - 1))

    def test_bad_inputs_are_refused_with_the_reason(self):
        for kw, text in (({"ports": []}, "ports"), ({"band_hz": [5e9, 1e9]}, "band_hz"), ({"excite": [3]}, "excite"),
                         ({"ports": [dict(PORTS[0], to="V1")]}, "conductor layers"), ({"ports": [dict(PORTS[0], to="M1")]}, "same height"),
                         ({"boundaries": ["PML_8"]}, "boundaries")):
            with self.assertRaises(ValueError) as e:
                self.plan(**kw)
            self.assertIn(text, str(e.exception))


class Log(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(FIX, name)) as fh:
            return oa.read_log(fh.read(), -40)

    def test_pml_run_reaches_the_end_criterion(self):
        c = self.read("log-pml-converged.log")
        self.assertTrue(c["end_criteria_reached"])
        self.assertEqual((c["timesteps"], c["cells"]), (17010, 67473))
        self.assertAlmostEqual(c["energy_end_db"], -41.96)

    def test_mur_run_stops_at_max_timesteps(self):
        c = self.read("log-mur-maxts.log")
        self.assertFalse(c["end_criteria_reached"])
        self.assertEqual(c["timesteps"], 200000)
        self.assertAlmostEqual(c["energy_end_db"], -13.49)

    def test_cut_log_is_not_converged(self):
        self.assertFalse(oa.read_log("[@ 4s] Timestep: 2835 || Energy: ~7.13e-23 (- 0.00dB)\n", -40)["end_criteria_reached"])


def columns_doc(excited, converged=True):
    f = [1e9, 2e9]
    s = {1: [[0.1, 0.11], [0.9, 0.89]], 2: [[0.9, 0.89], [0.2, 0.21]]}
    cols = {str(k): {"re": s[k], "im": [[0.0, 0.01], [0.0, -0.01]]} for k in excited}
    conv = {str(k): {"end_criteria_reached": converged, "energy_end_db": -41.0 if converged else -13.0, "timesteps": 17000,
                     "cells": 1000, "solve_s": 2.0} for k in excited}
    return {"schema": oa.COLUMNS_SCHEMA, "cell": "line", "ports": ["in", "out"], "r_ohm": [50.0, 50.0], "f_hz": f,
            "columns": cols, "convergence": conv, "cells": 1000, "boundaries": oa.DEFAULT_BOUNDARIES, "end_criteria_db": -40.0}


class Merge(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="simra-oems-")
        self.work = os.path.join(self.root, "work")

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_merge(self, docs, **inputs):
        paths = []
        for i, d in enumerate(docs):
            p = os.path.join(self.root, "c%d.json" % i)
            with open(p, "w") as fh:
                json.dump(d, fh)
            paths.append("c%d.json" % i)
        return oa.merge({"root": self.root, "work_dir": self.work, "inputs": dict({"columns": paths}, **inputs)})

    def test_two_columns_make_a_touchstone_in_2_port_order(self):
        r = self.run_merge([columns_doc([1]), columns_doc([2])])
        self.assertEqual(r["status"], "completed", r["diagnostics"])
        ts = [o for o in r["outputs"] if o["role"] == "touchstone"][0]
        self.assertEqual(ts["path"], "work/line.s2p")
        with open(os.path.join(self.root, ts["path"])) as fh:
            rows = [l.split() for l in fh if not l.startswith(("!", "#"))]
        # S11 S21 S12 S22 at 1 GHz
        self.assertEqual([float(x) for x in rows[0][1::2]], [0.1, 0.9, 0.9, 0.2])
        self.assertEqual(r["measurements"]["end_criteria_reached_p2"]["value"], 1)

    def test_missing_port_and_double_port_are_refused(self):
        self.assertIn("no column for port(s) 2", self.run_merge([columns_doc([1])])["diagnostics"][0]["message"])
        self.assertIn("more than one", self.run_merge([columns_doc([1]), columns_doc([1, 2])])["diagnostics"][0]["message"])

    def test_unconverged_column_is_refused_unless_allowed(self):
        r = self.run_merge([columns_doc([1]), columns_doc([2], converged=False)])
        self.assertEqual(r["status"], "failed")
        self.assertIn("did not reach the end criterion", r["diagnostics"][0]["message"])
        r = self.run_merge([columns_doc([1]), columns_doc([2], converged=False)], allow_unconverged=True)
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["diagnostics"][0]["severity"], "warning")

    def test_different_bands_are_refused(self):
        other = columns_doc([2])
        other["f_hz"] = [1e9, 3e9]
        self.assertIn("differ in f_hz", self.run_merge([columns_doc([1]), other])["diagnostics"][0]["message"])


class Touchstone(unittest.TestCase):
    def test_four_port_rows_wrap_at_four_pairs(self):
        d = tempfile.mkdtemp()
        try:
            s = [[[complex(i, j) for j in range(4)] for i in range(4)]]
            p = os.path.join(d, "x.s4p")
            oa.write_touchstone(p, [1e9], s, 50, ["c"])
            with open(p) as fh:
                body = [l for l in fh if not l.startswith(("!", "#"))]
            self.assertEqual(len(body), 4)
            self.assertEqual(len(body[0].split()), 9)
        finally:
            shutil.rmtree(d)


class Simulate(unittest.TestCase):
    def test_missing_gds_is_refused(self):
        r = oa.simulate({"root": tempfile.gettempdir(), "work_dir": tempfile.mkdtemp(), "inputs": {"stackup": "x.xml"}})
        self.assertEqual(r["status"], "failed")
        self.assertIn("'gds' is required", r["diagnostics"][0]["message"])


if __name__ == "__main__":
    unittest.main()
