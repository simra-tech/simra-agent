"""Unit tests for the operation check_design of the ngspice adapter. They do not need ngspice."""

import json
import os
import shutil
import tempfile
import unittest

import design_check as adapter
import ngspice_adapter

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "design")
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
        errors = [(d["source"], d["message"]) for d in r["diagnostics"] if d["severity"] == "error"]
        self.assertEqual(r["measurements"]["design_errors"]["value"], len(errors))
        return errors

    def ota(self, path=IHP, old=None, new=None):
        with open(path) as f:
            text = f.read()
        if old is not None:
            self.assertIn(old, text)
            text = text.replace(old, new, 1)
        return text

    def test_ihp_ota_passes(self):
        r = self.check(self.ota(), limits={"c_f": 2e-12})
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
        r = self.check(self.ota(self.SKY130), technology=None, limits={"c_f": 2e-12})
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 42.0)
        self.assertEqual(r["measurements"]["mos_count"]["value"], 8)

    def test_the_adapter_runs_the_operation(self):
        with open(os.path.join(self.root, "d.spice"), "w") as f:
            f.write(self.ota())
        request = {"contract": ngspice_adapter.CONTRACT, "operation": "check_design", "root": self.root,
                   "work_dir": self.work, "response_path": os.path.join(self.root, "response.json"),
                   "inputs": {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "technology": "ihp-sg13"}}
        with open(os.path.join(self.root, "request.json"), "w") as f:
            json.dump(request, f)
        self.assertEqual(ngspice_adapter.main(["ngspice_adapter.py", os.path.join(self.root, "request.json")]), 0)
        with open(request["response_path"]) as f:
            r = json.load(f)
        self.assertEqual([r["status"], r["measurements"]["design_errors"]["value"]], ["completed", 0])

    def test_hierarchy_counts_each_instance(self):
        with open(os.path.join(FIXTURES, "hier.spice")) as f:
            r = self.check(f.read(), "sky130", subckt="top", pins=["in", "out", "vdd", "vss"], elements=["mos", "r"])
        self.assertEqual(self.errors(r), [])
        self.assertEqual(r["measurements"]["gate_area_um2"]["value"], 12.0)
        self.assertEqual(r["measurements"]["mos_count"]["value"], 5)

    def test_a_block_that_instantiates_itself(self):
        with open(os.path.join(FIXTURES, "loop.spice")) as f:
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
        # The adapter measures an area; a limit on it is a requirement, not an input.
        r = self.check(self.ota(), limits={"gate_area_um2": 20})
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["diagnostics"][0]["message"], "input 'limits' must be {name: positive number} with names "
                                                         "r_ohm, c_f")

    def test_elements_not_allowed(self):
        r = self.check(self.ota(), elements=["mos", "c"])
        self.assert_error(r, 14, "Rz: an ideal resistor is not allowed by elements (mos, c)")

    def test_devices_of_the_contract(self):
        # IHP: the HV devices are in the pack, but not in the model library of the corner of the task.
        text = self.ota(old="XM8 ibias ibias vss vss sg13_lv_nmos", new="XM8 ibias ibias vss vss sg13_hv_nmos")
        r = self.check(text, devices=["sg13_lv_nmos", "sg13_lv_pmos"])
        self.assertEqual(self.errors(r), [("d.spice:6", "XM8: sg13_hv_nmos is not in the devices of the design "
                                                        "contract (sg13_lv_nmos, sg13_lv_pmos)")])
        self.assertEqual(r["measurements"]["mos_count"]["value"], 7)  # the line is not counted
        with open(os.path.join(self.work, "design.json")) as f:
            self.assertEqual(json.load(f)["devices"], ["sg13_lv_nmos", "sg13_lv_pmos"])
        # Without devices, every device of the pack is allowed.
        r = self.check(text)
        self.assertEqual(self.errors(r), [])
        with open(os.path.join(self.work, "design.json")) as f:
            self.assertIsNone(json.load(f)["devices"])
        # The names compare without case.
        self.assertEqual(self.errors(self.check(self.ota(), devices=["SG13_LV_NMOS", "sg13_lv_pmos"])), [])
        # SKY130: the HVT PMOS is in the pack, but not in the list.
        text = self.ota(self.SKY130, old="XM6 out y vdd vdd sky130_fd_pr__pfet_01v8 ",
                        new="XM6 out y vdd vdd sky130_fd_pr__pfet_01v8_hvt ")
        r = self.check(text, "sky130", devices=["sky130_fd_pr__nfet_01v8", "sky130_fd_pr__pfet_01v8"])
        self.assertEqual(self.errors(r), [("d.spice:13", "XM6: sky130_fd_pr__pfet_01v8_hvt is not in the devices of "
                                                         "the design contract (sky130_fd_pr__nfet_01v8, "
                                                         "sky130_fd_pr__pfet_01v8)")])

    def test_devices_that_the_pack_does_not_have(self):
        # A name that the pack does not have is an error of the task author: the run fails.
        r = self.check(self.ota(), devices=["sg13_lv_nmos", "sky130_fd_pr__nfet_01v8"])
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["diagnostics"][0]["message"],
                         "input 'devices': sky130_fd_pr__nfet_01v8 is not a device of technology pack ihp-sg13; its "
                         "devices are sg13_lv_nmos, sg13_lv_pmos, sg13_hv_nmos, sg13_hv_pmos")
        r = self.check(self.ota(self.SKY130), "sky130", devices=["sg13_lv_nmos"])
        self.assertEqual(r["status"], "failed")
        self.assertIn("sg13_lv_nmos is not a device of technology pack sky130", r["diagnostics"][0]["message"])
        r = self.check(self.ota(), devices="sg13_lv_nmos")
        self.assertEqual([r["status"], r["diagnostics"][0]["message"]],
                         ["failed", "input 'devices' must be a list of device names of the technology pack"])

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
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "limits": {"area_um2": 1}},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "limits": {"c_f": -1}},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "devices": "sg13_lv_nmos"},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "devices": []},
                       {"file": "d.spice", "subckt": "ota", "pins": OTA_PINS, "devices": ["sg13_lv_nmos", ""]}):
            with self.subTest(inputs=inputs):
                r = adapter.check_design({"root": self.root, "work_dir": self.work,
                                          "inputs": dict(inputs, technology="ihp-sg13")})
                self.assertEqual(r["status"], "failed")
        r = self.check(self.ota(), technology=None)
        self.assertEqual(r["status"], "failed")
        self.assertIn("no technology pack for PDK 'None'", r["diagnostics"][0]["message"])

    def test_passive_area_from_the_pack(self):
        # Rz 5k and Cc 1p count with the facts of $PDK in ngspice.passives: R x w_min^2 / R_sheet and C / density.
        cases = [("ihp-sg13cmos5l", self.IHP, 30.0, 5e3 * 0.5 ** 2 / 1360 + 1e-12 / 1.287e-15),
                 ("ihp-sg13g2", self.IHP, 30.0, 5e3 * 0.5 ** 2 / 1360 + 1e-12 / 1.5e-15),
                 ("sky130A", self.SKY130, 42.0, 5e3 * 0.35 ** 2 / 2000 + 1e-12 / 2e-15)]
        for pdk, path, gate, passive in cases:
            with self.subTest(pdk=pdk):
                os.environ["PDK"] = pdk
                r = self.check(self.ota(path), technology=None)
                self.assertEqual(self.errors(r), [])
                m = {k: v["value"] for k, v in r["measurements"].items()}
                self.assertEqual(m["gate_area_um2"], gate)
                self.assertAlmostEqual(m["passive_area_um2"], passive, places=6)
                self.assertAlmostEqual(m["area_um2"], gate + passive, places=6)
                with open(os.path.join(self.work, "design.json")) as f:
                    elements = {e["name"]: e for e in json.load(f)["elements"]}
                self.assertAlmostEqual(elements["Rz"]["params"]["area_um2"] + elements["Cc"]["params"]["area_um2"],
                                       passive, places=6)
        self.assertEqual([round(p, 3) for *_, p in cases], [777.92, 667.586, 500.306])

    def test_passive_area_counts_each_instance(self):
        # R1 10k in block top: 10e3 x 0.35^2 / 2000 = 0.6125 um2.
        os.environ["PDK"] = "sky130A"
        with open(os.path.join(FIXTURES, "hier.spice")) as f:
            r = self.check(f.read(), None, subckt="top", pins=["in", "out", "vdd", "vss"], elements=["mos", "r"])
        self.assertEqual(self.errors(r), [])
        self.assertEqual([r["measurements"][k]["value"] for k in ("gate_area_um2", "passive_area_um2", "area_um2")],
                         [12.0, 0.6125, 12.6125])

    def test_area_counts_a_resistor_chain(self):
        # Eight 1 MOhm resistors in series on an input pass each element limit; area_um2 counts each of them.
        chain = "\n".join("Rch{} c{} c{} 1meg".format(i, i, i + 1) for i in range(8)).replace("c0 ", "inp ", 1)
        text = self.ota(old="Rz y z 5k", new="Rz y z 5k\n" + chain.replace("c8 1meg", "vss 1meg"))
        os.environ["PDK"] = "ihp-sg13cmos5l"
        r = self.check(text, technology=None, limits={"r_ohm": 1e6})
        self.assertEqual(self.errors(r), [])
        self.assertAlmostEqual(r["measurements"]["area_um2"]["value"],
                               30 + 8.005e6 * 0.5 ** 2 / 1360 + 1e-12 / 1.287e-15, places=6)

    def test_passive_area_without_pack_facts(self):
        # sky130B has no ngspice.passives facts: the area of R and C is not known, and a warning tells why. It is not
        # a design error. Without R and C the area is known (0).
        os.environ["PDK"] = "sky130B"
        r = self.check(self.ota(self.SKY130), technology=None)
        self.assertEqual(self.errors(r), [])
        self.assertEqual([r["measurements"][k]["status"] for k in ("gate_area_um2", "passive_area_um2", "area_um2")],
                         ["measured", "failed", "failed"])
        self.assertEqual([(d["severity"], d["source"], d["message"]) for d in r["diagnostics"]],
                         [("warning", "d.spice:6", "the area of R and C is not known: technology pack sky130 has no "
                                                   "ngspice.passives facts for them for PDK 'sky130B'; area_um2 is not "
                                                   "measured")])
        text = self.ota(self.SKY130, old="Rz y z 5k", new="* no Rz").replace("Cc z out 1p", "* no Cc")
        r = self.check(text, technology=None)
        self.assertEqual(r["diagnostics"], [])
        self.assertEqual([r["measurements"][k]["value"] for k in ("passive_area_um2", "area_um2")], [0.0, 42.0])

    def test_pack_passives(self):
        # Each PDK of ngspice.passives is a PDK of the pack; each value is positive and has a source.
        for name in ("ihp-sg13", "sky130"):
            pack = adapter.find_technology(name, None, "devices")[1]
            for pdk, facts in pack["ngspice"]["passives"].items():
                with self.subTest(pdk=pdk):
                    self.assertIn(pdk, pack["pdks"])
                    self.assertTrue(facts["r"]["sheet_ohm"] > 0 and facts["r"]["width_min_m"] > 0)
                    self.assertTrue(facts["c"]["density_f_per_m2"] > 0)
                    self.assertTrue(facts["r"]["source"] and facts["c"]["source"])
                    self.assertTrue(facts["r"]["device"] and facts["c"]["device"])

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
