"""Unit tests for the ngspice adapter. They do not need ngspice."""

import os
import shutil
import tempfile
import unittest

import ngspice_adapter as adapter

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def read_log():
    with open(os.path.join(FIXTURES, "ngspice.log")) as f:
        return f.read().splitlines()


class ParseLogTest(unittest.TestCase):
    def test_requested_measurements(self):
        wanted = {"gain_db": "dB", "ugf_hz": "Hz", "ph_rad": "rad", "pm_raw": "rad", "pm_deg": "deg", "noise": "V"}
        m, diags = adapter.parse_log(read_log(), wanted)
        self.assertEqual(m["gain_db"], {"value": 48.3317, "unit": "dB", "status": "measured",
                                        "source": "work/ngspice.log:5"})
        self.assertEqual(m["ugf_hz"]["value"], 1.34562e7)
        self.assertEqual(m["ph_rad"]["status"], "failed")
        self.assertEqual(m["pm_raw"]["status"], "failed")
        self.assertEqual(m["noise"], {"value": None, "unit": "V", "status": "missing"})
        # A repeated name keeps the last value and gives a warning.
        self.assertEqual(m["pm_deg"]["value"], 77.0)
        self.assertTrue(any("pm_deg appears 2 times" in d["message"] for d in diags))

    def test_all_values_without_request(self):
        m, _ = adapter.parse_log(read_log(), {})
        self.assertEqual(sorted(m), ["gain_db", "inoise_spectrum[0]", "pm_deg", "ugf_hz"])
        self.assertIsNone(m["gain_db"]["unit"])

    def test_diagnostics(self):
        _, diags = adapter.parse_log(read_log(), {})
        severities = [(d["severity"], d["source"]) for d in diags]
        self.assertIn(("error", "work/ngspice.log:7"), severities)
        self.assertIn(("warning", "work/ngspice.log:11"), severities)

    def test_analysis_banner_is_not_a_value(self):
        m, _ = adapter.parse_log(["Doing analysis at TEMP = 27.000000 and TNOM = 27.000000"], {})
        self.assertEqual(m, {})


class ClosureTest(unittest.TestCase):
    def test_include_tree(self):
        root = os.path.join(FIXTURES, "tree")
        c = adapter.Closure(root)
        c.add_netlist(os.path.join(root, "deck.spice"), "deck", "include")
        self.assertEqual([(f["path"], f["role"]) for f in c.files],
                         [("deck.spice", "deck"), ("sub/a.spice", "include"), ("b.spice", "include"),
                          ("models.lib", "include")])
        self.assertEqual(c.missing, ["missing.spice (from deck.spice)"])
        self.assertEqual(c.files[0]["sha256"], adapter.sha256(os.path.join(root, "deck.spice")))


class LintTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, name, text):
        os.makedirs(os.path.dirname(os.path.join(self.root, name)) or self.root, exist_ok=True)
        with open(os.path.join(self.root, name), "w") as f:
            f.write(text)

    def lint(self, files):
        return adapter.lint({"contract": adapter.CONTRACT, "operation": "lint", "root": self.root,
                             "inputs": {"files": files}})

    def test_options_that_add_elements(self):
        lines = ["* tb", ".option rshunt=5e5", ".options gmin=1e-12 reltol=1e-4", ".control",
                 "option gmin=1n cshunt=1f", ".endc", "* .option rshunt=1"]
        d = adapter.lint_lines(lines, "tb.spice")
        self.assertEqual([x["source"] for x in d], ["tb.spice:2", "tb.spice:5", "tb.spice:5"])
        self.assertIn("connects a 500 kΩ resistor from each node to ground", d[0]["message"])
        self.assertIn("a conductance of 1 nS", d[1]["message"])
        self.assertIn("a 1 fF capacitor", d[2]["message"])
        self.assertTrue(all(x["severity"] == "warning" for x in d))

    def test_spice_numbers(self):
        self.assertEqual([adapter.spice_number(t) for t in ("5e5", "500k", "1meg", "2.2Meg", "1m", "x")],
                         [5e5, 5e5, 1e6, 2.2e6, 1e-3, None])

    def test_lint_follows_design_includes(self):
        self.write("tb.spice", '* tb\n.include "sub/opts.inc"\n.lib /pdk/models.lib tt\n')
        self.write("sub/opts.inc", "* opts\n.option rshunt=1meg\n")
        r = self.lint(["tb.spice", "nope.spice"])
        self.assertEqual(r["status"], "completed")
        self.assertEqual([(x["severity"], x["source"]) for x in r["diagnostics"]],
                         [("warning", os.path.join("sub", "opts.inc") + ":2"), ("error", "adapter")])

    def test_lint_needs_files(self):
        self.assertEqual(self.lint("tb.spice")["status"], "failed")


class SimulateInputTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.work = os.path.join(self.root, "work")
        os.mkdir(self.work)

    def tearDown(self):
        shutil.rmtree(self.root)
        os.environ.pop("SIMRA_TEST_LIBDIR", None)

    def request(self, inputs):
        return {"contract": adapter.CONTRACT, "experiment": "t", "operation": "simulate", "root": self.root,
                "work_dir": self.work, "inputs": inputs}

    def test_missing_deck_is_a_failed_run(self):
        r = adapter.simulate(self.request({"deck": "nope.spice"}))
        self.assertEqual(r["status"], "failed")
        self.assertIn("deck not found", r["diagnostics"][0]["message"])

    def test_missing_library_is_a_failed_run(self):
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n")
        os.environ["SIMRA_TEST_LIBDIR"] = "/nonexistent"
        r = adapter.simulate(self.request({"deck": "tb.spice", "libs": [{"path": "$SIMRA_TEST_LIBDIR/x.lib",
                                                                          "section": "tt"}]}))
        self.assertEqual(r["status"], "failed")
        self.assertIn("/nonexistent/x.lib", r["diagnostics"][0]["message"])

    def test_simulate_warns_about_options(self):
        # A stand-in for ngspice that prints one value: the test does not need ngspice.
        bin_dir = os.path.join(self.root, "bin")
        os.mkdir(bin_dir)
        with open(os.path.join(bin_dir, "ngspice"), "w") as f:
            f.write("#!/bin/sh\necho 'gain_db = 46.1'\n")
        os.chmod(os.path.join(bin_dir, "ngspice"), 0o755)
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n.option rshunt=5e5\n")
        path = os.environ["PATH"]
        os.environ["PATH"] = bin_dir + os.pathsep + path
        try:
            r = adapter.simulate(self.request({"deck": "tb.spice", "measurements": {"gain_db": "dB"}}))
        finally:
            os.environ["PATH"] = path
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["measurements"]["gain_db"]["value"], 46.1)
        self.assertEqual([(d["severity"], d["source"]) for d in r["diagnostics"]], [("warning", "tb.spice:2")])


if __name__ == "__main__":
    unittest.main()
