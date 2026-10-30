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

    def test_sourcepath_of_spiceinit(self):
        # ngspice finds ".lib models.lib" in a directory that .spiceinit adds to sourcepath.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        os.makedirs(os.path.join(d, "pdk", "models"))
        with open(os.path.join(d, "pdk", "models", "models.lib"), "w") as f:
            f.write("* models\n")
        with open(os.path.join(d, ".spiceinit"), "w") as f:
            f.write("setcs sourcepath = ( $sourcepath $SIMRA_TEST_PDK/models )\n")
        with open(os.path.join(d, "deck.spice"), "w") as f:
            f.write(".lib models.lib tt\n")
        os.environ["SIMRA_TEST_PDK"] = os.path.join(d, "pdk")
        self.addCleanup(os.environ.pop, "SIMRA_TEST_PDK")
        self.assertEqual(adapter.sourcepath(os.path.join(d, ".spiceinit")), [os.path.join(d, "pdk", "models")])
        c = adapter.Closure(d, adapter.sourcepath(os.path.join(d, ".spiceinit")))
        c.add_netlist(os.path.join(d, "deck.spice"), "deck", "include")
        self.assertEqual(c.missing, [])
        self.assertEqual([f["role"] for f in c.files], ["deck", "include"])


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


class OperatingPointTest(unittest.TestCase):
    """The show tables in fixtures/op-*.log are from ngspice 47: the OTA of evals/ota-sizing at ss, IHP SG13CMOS5L
    (PSP, VCM = 0.55 V) and SKY130 (BSIM4, VCM = 1.0 V)."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.work = os.path.join(self.root, "work")
        os.mkdir(self.work)
        self.saved = {k: os.environ.get(k) for k in ("PATH", "PDK", "SIMRA_TECHNOLOGY_DIR")}
        os.environ.pop("SIMRA_TECHNOLOGY_DIR", None)

    def tearDown(self):
        shutil.rmtree(self.root)
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def pack(self, pdk):
        return adapter.find_technology(None, pdk)[1]["ngspice"]["operating_point"]

    def show(self, name, pdk):
        op = self.pack(pdk)
        with open(os.path.join(FIXTURES, name)) as f:
            return adapter.parse_show(f.read().splitlines(), op["device_letter"], op["params"])

    def test_the_packs_of_the_repository(self):
        self.assertEqual(adapter.find_technology(None, "ihp-sg13cmos5l")[1]["name"], "ihp-sg13")
        self.assertEqual(adapter.find_technology(None, "ihp-sg13g2")[1]["name"], "ihp-sg13")
        self.assertEqual(adapter.find_technology(None, "sky130A")[1]["name"], "sky130")
        self.assertEqual(adapter.find_technology("sky130", "ihp-sg13g2")[1]["name"], "sky130")
        _, _, error = adapter.find_technology(None, "gf180mcuD")
        self.assertIn("no technology pack for PDK 'gf180mcuD'", error)
        self.assertIn("sky130 (sky130A, sky130B)", error)
        for pdk in ("ihp-sg13g2", "sky130A"):
            self.assertEqual(sorted(self.pack(pdk)["params"]), sorted(adapter.OP_QUANTITIES))

    def test_psp_show_table(self):
        devices, warnings = self.show("op-psp.log", "ihp-sg13cmos5l")
        self.assertEqual(warnings, [])
        self.assertEqual([d["device"] for d in devices], ["xdut.xm" + n for n in "76432158"])
        xm5 = devices[6]["values"]
        self.assertEqual((xm5["vds"], xm5["vdsat"], xm5["id"]), (0.139311, 0.190882, 1.85412e-05))
        vov, margin, region = adapter.classify(xm5)
        self.assertEqual(region, "triode")
        self.assertAlmostEqual(margin, 0.139311 - 0.190882)
        self.assertAlmostEqual(vov, 0.466599 - 0.285853)
        self.assertEqual([adapter.classify(d["values"])[2] for d in devices].count("saturation"), 7)

    def test_bsim4_show_table(self):
        devices, warnings = self.show("op-bsim4.log", "sky130A")
        self.assertEqual(warnings, [])
        self.assertEqual(len(devices), 8)
        self.assertEqual({adapter.classify(d["values"])[2] for d in devices}, {"saturation"})
        self.assertEqual(sorted(devices[0]["values"]), sorted(adapter.OP_QUANTITIES))

    def test_regions_use_magnitudes(self):
        pmos = {"vgs": -0.5, "vth": -0.4, "vds": -0.05, "vdsat": -0.1}
        self.assertEqual(adapter.classify(pmos)[2], "triode")
        self.assertEqual(adapter.classify(dict(pmos, vgs=-0.3))[2], "subthreshold")
        self.assertEqual(adapter.classify(dict(pmos, vds=-0.5))[2], "saturation")
        self.assertEqual(adapter.classify({"vgs": 0.5}), (None, None, None))

    def test_a_name_without_path_gives_a_warning(self):
        lines = ["device m.xverylongname_abcdefgh", "model sky130_fd_pr__nfet_", "vgs 0.7", "vth 0.5", "vds 0.1",
                 "vdsat 0.2", "id 1e-6", "gm 1e-5", "gds 1e-7"]
        devices, warnings = adapter.parse_show(lines, "m", self.pack("sky130A")["params"])
        self.assertEqual(devices[0]["device"], "m.xverylongname_abcdefgh")
        self.assertIn("shortened", warnings[0])

    def test_operating_point_removes_the_analyses(self):
        os.mkdir(os.path.join(self.root, "tb"))
        with open(os.path.join(self.root, "ota.spice"), "w") as f:
            f.write("* ota\n")
        with open(os.path.join(self.root, "tb", "tb.spice"), "w") as f:
            f.write("* tb\n.include \"../ota.spice\"\n.param vcm=0.55\nVinp inp 0 dc {vcm} ac 1\n.op\n"
                    ".ac dec 10 1 1G\n.meas ac gain max vdb(out)\n.control\nac dec 10 1 1G\nmeas ac g max vdb(out)\n"
                    ".endc\n.options gmin=1e-12\n.end\n")
        bin_dir = os.path.join(self.root, "bin")
        os.mkdir(bin_dir)
        with open(os.path.join(bin_dir, "ngspice"), "w") as f:
            f.write("#!/bin/sh\ncat '{}'\n".format(os.path.join(FIXTURES, "op-psp.log")))
        os.chmod(os.path.join(bin_dir, "ngspice"), 0o755)
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        os.environ["PDK"] = "ihp-sg13cmos5l"
        r = adapter.operating_point({"contract": adapter.CONTRACT, "experiment": "t", "operation": "operating_point",
                                     "root": self.root, "work_dir": self.work, "inputs": {"deck": "tb/tb.spice"}})
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["tool"]["technology"], "ihp-sg13")
        with open(os.path.join(self.work, "op.cir")) as f:
            body = f.read().splitlines()
        self.assertEqual(body[1:5], ["* tb", '.include "{}"'.format(os.path.join(self.root, "tb", "../ota.spice")),
                                     ".param vcm=0.55", "Vinp inp 0 dc {vcm} ac 1"])
        self.assertEqual(body[5:], [".options gmin=1e-12", ".control", "op", "set width=10000",
                                    "show n : vgs vth vds vdss ids gm gds", ".endc", ".end"])
        self.assertEqual(len(r["measurements"]), 8 * 9)
        self.assertEqual(r["measurements"]["xdut.xm5.vdsat"], {"value": 0.190882, "unit": "V", "status": "measured",
                                                                "source": "work/ngspice.log"})
        warnings = [d["message"] for d in r["diagnostics"] if d["severity"] == "warning"]
        self.assertEqual(warnings, ["xdut.xm5 is in triode: vov = 0.181 V, vds = 0.139 V, vdsat = 0.191 V, margin = -0.052 V"])
        self.assertIn("technology", [f["role"] for f in r["input_files"]["files"]])
        self.assertIn("work/operating_point.json", [o["path"] for o in r["outputs"]])

    def test_operating_point_without_a_pack(self):
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n")
        os.environ["PDK"] = "gf180mcuD"
        r = adapter.operating_point({"root": self.root, "work_dir": self.work, "inputs": {"deck": "tb.spice"}})
        self.assertEqual(r["status"], "failed")
        self.assertIn("no technology pack for PDK 'gf180mcuD'", r["diagnostics"][0]["message"])


if __name__ == "__main__":
    unittest.main()
