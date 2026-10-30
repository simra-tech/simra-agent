"""Unit tests for the ngspice adapter. They do not need ngspice."""

import json
import os
import shutil
import tempfile
import unittest

import ngspice_adapter as adapter

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def read_log(name="ngspice.log"):
    with open(os.path.join(FIXTURES, name)) as f:
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


class SweepTest(unittest.TestCase):
    """fixtures/sweep.log has three ROW lines (vcm = 0.4, 0.55, 0.7). pm_deg has no value at vcm = 0.55, and
    only the last line has the key "extra"."""

    def test_table(self):
        table, sources = adapter.parse_rows(read_log("sweep.log"))
        self.assertEqual(table["sweep"], "vcm")
        self.assertEqual(table["columns"], ["idd_a", "gain_db", "pm_deg", "extra"])
        self.assertEqual(table["rows"][1], {"vcm": 0.55, "idd_a": 1.25e-4, "gain_db": 50.0, "pm_deg": None, "extra": None})
        self.assertEqual(table["rows"][2]["extra"], 1.0)
        self.assertEqual(sources, ["work/ngspice.log:4", "work/ngspice.log:7", "work/ngspice.log:9"])
        self.assertEqual(adapter.parse_rows(read_log()), (None, []))

    def test_row_values(self):
        self.assertEqual([adapter.row_number(t) for t in ("1k", "2.5e-3", "1meg", "", "nan", "$&x", "1e999", "4kx")],
                         [1e3, 2.5e-3, 1e6, None, None, None, None, None])

    def test_min_and_max_with_the_sweep_point(self):
        m, diags = adapter.parse_log(read_log("sweep.log"), {"gain_db": "dB", "pm_deg": "deg"})
        self.assertEqual(m["gain_db.min"], {"value": 48.51, "unit": "dB", "status": "measured",
                                            "source": "work/ngspice.log:4", "at": {"vcm": 0.4}})
        self.assertEqual(m["gain_db.max"], {"value": 50.0, "unit": "dB", "status": "measured",
                                            "source": "work/ngspice.log:7", "at": {"vcm": 0.55}})
        # A point without a value: never a value, and one warning.
        self.assertEqual(m["pm_deg.min"], {"value": None, "unit": "deg", "status": "failed",
                                           "source": "work/ngspice.log:7", "at": None})
        self.assertEqual(m["pm_deg.max"]["status"], "failed")
        self.assertEqual([d["message"] for d in diags], ["pm_deg: 1 of 3 sweep points have no value"])
        # A wanted ROW column is not a missing scalar; columns that are not wanted are not reported.
        self.assertEqual(sorted(m), ["gain_db.max", "gain_db.min", "pm_deg.max", "pm_deg.min"])

    def test_all_columns_without_request(self):
        m, diags = adapter.parse_log(read_log("sweep.log"), {})
        self.assertEqual(sorted(m), ["extra.max", "extra.min", "gain", "gain_db.max", "gain_db.min", "idd_a.max",
                                     "idd_a.min", "pm_deg.max", "pm_deg.min"])
        self.assertIsNone(m["idd_a.max"]["unit"])
        self.assertEqual(m["idd_a.max"]["at"], {"vcm": 0.7})
        self.assertEqual(m["extra.min"]["status"], "failed")
        self.assertIn("extra: 2 of 3 sweep points have no value", [d["message"] for d in diags])

    def test_scalar_and_column_are_independent(self):
        log = read_log("sweep.log") + ["gain_db = 4.7e+01"]
        m, _ = adapter.parse_log(log, {"gain_db": "dB", "noise": "V"})
        self.assertEqual(m["gain_db"]["value"], 47.0)
        self.assertEqual(m["gain_db.min"]["value"], 48.51)
        self.assertEqual(m["noise"]["status"], "missing")


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

    def test_root_through_a_link(self):
        # On macOS the temporary directory /var/folders is a link to /private/var/folders.
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        os.makedirs(os.path.join(d, "real"))
        os.symlink(os.path.join(d, "real"), os.path.join(d, "link"))
        root = os.path.join(d, "link")
        with open(os.path.join(root, "deck.spice"), "w") as f:
            f.write("* deck\n.option rshunt=5e5\n")
        c = adapter.Closure(root)
        c.add_netlist(os.path.join(root, "deck.spice"), "deck", "include")
        self.assertEqual([f["path"] for f in c.files], ["deck.spice"])
        self.assertEqual([w["source"] for w in adapter.lint_netlist(os.path.join(root, "deck.spice"), root)], ["deck.spice:2"])


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
            f.write("#!/bin/sh\necho 'gain_db = 46.1'\necho \"input_dir = $NGSPICE_INPUT_DIR\"\n")
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
        # Includes relative to the design root are found, as in the input hashes.
        self.assertEqual(open(os.path.join(self.work, "ngspice.log")).read().splitlines()[1],
                         "input_dir = " + os.path.realpath(self.root))
        self.assertEqual([(d["severity"], d["source"]) for d in r["diagnostics"]], [("warning", "tb.spice:2")])


    def fake_ngspice(self, script):
        """A stand-in for ngspice on PATH, for this test only."""
        bin_dir = os.path.join(self.root, "bin")
        os.mkdir(bin_dir)
        with open(os.path.join(bin_dir, "ngspice"), "w") as f:
            f.write("#!/bin/sh\n" + script)
        os.chmod(os.path.join(bin_dir, "ngspice"), 0o755)
        path = os.environ["PATH"]
        os.environ["PATH"] = bin_dir + os.pathsep + path
        self.addCleanup(os.environ.__setitem__, "PATH", path)

    def test_params_and_temp_follow_the_include(self):
        self.fake_ngspice("cat '{}'\n".format(os.path.join(FIXTURES, "sweep.log")))
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n.param cl=1p\n.temp 27\n")
        r = adapter.simulate(self.request({"deck": "tb.spice", "temp_c": -40,
                                           "params": {"vdd": 1.2, "cl": "2p", "vcm": "{vdd/2}", "n": 3}}))
        self.assertEqual(r["status"], "completed")
        with open(os.path.join(self.work, "top.cir")) as f:
            body = f.read().splitlines()
        self.assertEqual(body[1:], ['.include "{}"'.format(os.path.realpath(os.path.join(self.root, "tb.spice"))),
                                    ".param cl=2p", ".param n=3", ".param vcm={vdd/2}", ".param vdd=1.2", ".temp -40",
                                    ".end"])
        # The sweep table is a hashed output.
        with open(os.path.join(self.work, "sweep.json")) as f:
            table = json.load(f)
        self.assertEqual(table, adapter.parse_rows(read_log("sweep.log"))[0])
        self.assertIn("work/sweep.json", [o["path"] for o in r["outputs"]])
        self.assertEqual(r["measurements"]["gain_db.min"]["at"], {"vcm": 0.4})

    def test_no_sweep_table_without_rows(self):
        self.fake_ngspice("echo 'gain_db = 46.1'\n")
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n")
        r = adapter.simulate(self.request({"deck": "tb.spice"}))
        self.assertEqual(r["status"], "completed")
        self.assertFalse(os.path.exists(os.path.join(self.work, "sweep.json")))
        with open(os.path.join(self.work, "top.cir")) as f:
            self.assertEqual(f.read().splitlines()[-1], ".end")

    def test_bad_params_and_temp_are_a_failed_run(self):
        with open(os.path.join(self.root, "tb.spice"), "w") as f:
            f.write("* tb\n")
        for inputs, message in (({"params": [1]}, "input 'params' must be an object"),
                                ({"params": {"cl": None}}, "the value of 'cl' must be a finite number"),
                                ({"params": {"cl": True}}, "the value of 'cl' must be a finite number"),
                                ({"params": {"cl": float("inf")}}, "the value of 'cl' must be a finite number"),
                                ({"params": {"cl": "1p\n.option rshunt=1"}}, "one-line string"),
                                ({"params": {"c l": 1}}, "'c l' is not a parameter name"),
                                ({"temp_c": "27"}, "input 'temp_c' must be a finite number"),
                                ({"temp_c": float("nan")}, "input 'temp_c' must be a finite number")):
            r = adapter.simulate(self.request(dict(inputs, deck="tb.spice")))
            self.assertEqual(r["status"], "failed", inputs)
            self.assertIn(message, r["diagnostics"][0]["message"])
            self.assertFalse(os.path.exists(os.path.join(self.work, "top.cir")))


class OperatingPointTest(unittest.TestCase):
    """The show tables in fixtures/op-*.log are from ngspice 47: the OTA of evals/ota-sizing at ss, IHP SG13CMOS5L
    (PSP, VCM = 0.55 V) and SKY130 (BSIM4, VCM = 1.0 V)."""

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())  # macOS: /var/folders is a link
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


REPO = os.path.dirname(os.path.dirname(HERE))
OTA_PINS = ["inp", "inn", "out", "vdd", "vss", "ibias"]


class CheckDesignTest(unittest.TestCase):
    """check_design against the technology packs of the repository. The OTA netlists are the IHP example
    (examples/ota-sg13g2) and the SKY130 task design (evals/ota-sizing/sky130). Their gate areas, by hand:
    IHP 2x1 + 4x1 + 2 x 4x0.5 + 2 x 4x0.5 + 16x0.5 + 8x1 = 30 um2;
    SKY130 2x1 + 4x1 + 2 x 4x0.5 + 2 x 8x0.5 + 32x0.5 + 8x1 = 42 um2."""

    IHP = os.path.join(REPO, "examples", "ota-sg13g2", "ota.spice")
    SKY130 = os.path.join(REPO, "evals", "ota-sizing", "sky130", "ota.spice")

    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.work = os.path.join(self.root, "work")
        os.mkdir(self.work)
        self.saved = {k: os.environ.get(k) for k in ("PDK", "SIMRA_TECHNOLOGY_DIR")}
        os.environ.pop("SIMRA_TECHNOLOGY_DIR", None)
        os.environ.pop("PDK", None)

    def tearDown(self):
        shutil.rmtree(self.root)
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def check(self, text, technology="ihp-sg13", **inputs):
        with open(os.path.join(self.root, "d.spice"), "w") as f:
            f.write(text)
        inputs = dict({"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "technology": technology}, **inputs)
        return adapter.check_design({"root": self.root, "work_dir": self.work, "inputs": inputs})

    def errors(self, r):
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["measurements"]["design_errors"]["value"], len(r["diagnostics"]))
        self.assertTrue(all(d["severity"] == "error" for d in r["diagnostics"]))
        return [(d["source"], d["message"]) for d in r["diagnostics"]]

    def ota(self, path=IHP, old=None, new=None):
        with open(path) as f:
            text = f.read()
        if old is not None:
            self.assertIn(old, text)
            text = text.replace(old, new, 1)
        return text

    def test_ihp_ota_passes(self):
        r = self.check(self.ota(), limits={"gate_area_um2": 60, "c_f": 2e-12})
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 30.0)
        self.assertEqual(r["measurements"]["mos_count"]["value"], 8)
        self.assertEqual([o["path"] for o in r["outputs"]], ["work/design.json"])
        self.assertEqual([f["role"] for f in r["input_files"]["files"]], ["design", "technology"])
        with open(os.path.join(self.work, "design.json")) as f:
            design = json.load(f)
        self.assertEqual(design["errors"], [])
        self.assertEqual(len(design["elements"]), 10)
        self.assertEqual(design["elements"][0]["params"], {"w": 2e-6, "l": 1e-6, "ng": 1})

    def test_sky130_ota_passes(self):
        # SKY130 sizes are in um without a suffix (the library sets .option scale=1.0u).
        os.environ["PDK"] = "sky130A"  # no technology input: the pack for $PDK
        r = self.check(self.ota(self.SKY130), technology=None, limits={"gate_area_um2": 80, "c_f": 2e-12})
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 42.0)
        self.assertEqual(r["measurements"]["mos_count"]["value"], 8)

    def test_hierarchy_counts_each_instance(self):
        with open(os.path.join(FIXTURES, "design", "hier.spice")) as f:
            r = self.check(f.read(), "sky130", subckt="top", pins=["in", "out", "vdd", "vss"], elements=["mos", "r"])
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 12.0)
        self.assertEqual(r["measurements"]["mos_count"]["value"], 5)

    def test_a_block_that_instantiates_itself(self):
        with open(os.path.join(FIXTURES, "design", "loop.spice")) as f:
            r = self.check(f.read(), subckt="a", pins=["p", "q"])
        self.assertIn(("d.spice:6", ".subckt a instantiates itself (a -> b -> a)"), self.errors(r))
        self.assertEqual(r["measurements"]["gate_area_um2"]["status"], "failed")

    def assert_error(self, r, line, text):
        errors = self.errors(r)
        self.assertTrue(any(s == "d.spice:{}".format(line) and text in m for s, m in errors), errors)

    def test_forbidden_lines(self):
        cases = [
            ("Rz y z 5k", "Vb y z 0.5", "Vb: a voltage source is not allowed"),
            ("Rz y z 5k", ".model nx nmos level=1", "'.model nx nmos level=1': .model is not allowed"),
            ("Rz y z 5k", ".include other.spice", ".include is not allowed"),
            ("Rz y z 5k", "Mx y z vss vss nch w=1u l=1u", "a MOS model instance (M) is not allowed"),
            ("Rz y z 5k", "Rz y z {rz}", "an expression or a quoted value is not allowed"),
            ("Rz y z 5k", "Rz y 0 5k", "node 0 is the global ground"),
        ]
        for old, new, text in cases:
            with self.subTest(new=new):
                self.assert_error(self.check(self.ota(old=old, new=new)), 14, text)

    def test_an_element_outside_the_block(self):
        r = self.check(self.ota() + "Rx out vss 1k\n")
        self.assert_error(r, 17, "'Rx out vss 1k' is outside a .subckt block")

    def test_pins_in_another_order(self):
        r = self.check(self.ota(old="ota inp inn out", new="ota inn inp out"))
        self.assert_error(r, 5, "has the pins 'inn inp out vdd vss ibias'; the design contract gives "
                                "'inp inn out vdd vss ibias'")
        r = self.check(self.ota(old="ota inp inn out vdd vss ibias", new="ota inp inn out vdd vss ibias k=1"))
        self.assert_error(r, 5, "has parameters")

    def test_device_rules(self):
        cases = [
            ("sg13_lv_nmos w=2u", "sg13_lv_nmox w=2u", "sg13_lv_nmox is not a device of the technology pack"),
            ("w=2u l=1u ng=1", "w=0.1u l=1u ng=1", "w is 0.1 µm, below the minimum 0.15 µm of sg13_lv_nmos"),
            ("w=2u l=1u ng=1", "w=0.2u l=1u ng=2", "w is 0.1 µm per finger, below the minimum 0.15 µm"),
            ("w=2u l=1u ng=1", "w=2u l=0.1u ng=1", "l is 0.1 µm, below the minimum 0.13 µm"),
            ("w=2u l=1u ng=1", "w={2u} l=1u ng=1", "an expression or a quoted value is not allowed"),
            ("w=2u l=1u ng=1", "w=2um l=1u ng=1", "w=2um is not a plain number"),
            ("w=2u l=1u ng=1", "l=1u ng=1", "w is required for sg13_lv_nmos"),
            ("w=2u l=1u ng=1", "w=2u l=1u ng=1.5", "ng=1.5 is not an integer"),
            ("w=2u l=1u ng=1", "w=2u l=1u ng=1 mult=2", "mult is not a parameter of sg13_lv_nmos"),
            ("XM8 ibias ibias vss vss", "XM8 ibias ibias vss", "3 nodes; sg13_lv_nmos has 4 terminals"),
        ]
        for old, new, text in cases:
            with self.subTest(new=new):
                self.assert_error(self.check(self.ota(old=old, new=new)), 6, text)

    def test_sky130_minimum_width(self):
        text = self.ota(self.SKY130, old="w=2 l=1 nf=1", new="w=0.3 l=1 nf=1")
        r = self.check(text, "sky130")
        self.assert_error(r, 7, "w is 0.3 µm, below the minimum 0.36 µm of sky130_fd_pr__nfet_01v8")

    def test_limits(self):
        r = self.check(self.ota(), limits={"r_ohm": 1e3})
        self.assert_error(r, 14, "Rz: 5 kΩ is above the limit 1 kΩ (limits.r_ohm)")
        r = self.check(self.ota(), limits={"c_f": 0.5e-12})
        self.assert_error(r, 15, "Cc: 1 pF is above the limit 500 fF (limits.c_f)")
        r = self.check(self.ota(), limits={"gate_area_um2": 20})
        self.assert_error(r, 5, "the gate area (W x L x m of all MOS devices) is 30 µm², above the limit 20 µm²")
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 30.0)

    def test_elements_not_allowed(self):
        r = self.check(self.ota(), elements=["mos", "c"])
        self.assert_error(r, 14, "Rz: an ideal resistor is not allowed by design.elements (mos, c)")

    def test_multiplier_and_case(self):
        # m multiplies the area; names compare without case; a continuation line joins the line before it.
        text = self.ota(old="XM8 ibias ibias vss vss sg13_lv_nmos w=2u l=1u ng=1",
                        new="XM8 ibias ibias vss vss SG13_LV_NMOS w=2u\n* a comment\n+ l=1u ng=1 M=3 $ three in parallel")
        r = self.check(text, pins=[p.upper() for p in OTA_PINS])
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 34.0)

    def test_missing_file_and_missing_block(self):
        r = adapter.check_design({"root": self.root, "work_dir": self.work,
                                  "inputs": {"file": "none.spice", "subckt": "ota", "pins": OTA_PINS, "technology": "sky130"}})
        self.assertEqual(self.errors(r), [("none.spice", "design file not found: none.spice")])
        self.assertEqual(r["measurements"]["gate_area_um2"]["status"], "failed")
        r = self.check(self.ota(), subckt="amp")
        self.assertEqual(self.errors(r), [("d.spice", "no .subckt amp in d.spice")])

    def test_bad_inputs_are_a_failed_run(self):
        for inputs in ({"subckt": "ota", "pins": OTA_PINS}, {"file": "d.spice", "pins": OTA_PINS},
                       {"file": "d.spice", "subckt": "ota", "pins": []},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "elements": ["l"]},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "limits": {"area": 1}},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "limits": {"c_f": -1}}):
            with self.subTest(inputs=inputs):
                r = adapter.check_design({"root": self.root, "work_dir": self.work,
                                          "inputs": dict(inputs, technology="ihp-sg13")})
                self.assertEqual(r["status"], "failed")
        r = self.check(self.ota(), technology=None)
        self.assertEqual(r["status"], "failed")
        self.assertIn("no technology pack for PDK 'None'", r["diagnostics"][0]["message"])

    def test_pack_devices(self):
        # Every device of both packs has its terminals, a source, and a source for each minimum.
        for name in ("ihp-sg13", "sky130"):
            pack = adapter.find_technology(name, None, "devices")[1]["ngspice"]
            self.assertTrue(pack["size_unit_m"] > 0)
            for device, spec in pack["devices"].items():
                with self.subTest(device=device):
                    self.assertEqual(spec["terminals"], ["d", "g", "s", "b"])
                    self.assertTrue(spec["source"])
                    roles = sorted(p["role"] for p in spec["params"].values())
                    self.assertEqual(roles, ["fingers", "length", "multiplier", "width"])
                    for p in spec["params"].values():
                        self.assertTrue(p["source"])


if __name__ == "__main__":
    unittest.main()
