"""Unit tests of the operation probe_devices of the ngspice adapter: the classification of the ngspice output of one
probe deck, and the decks from a technology pack (with a fake ngspice). The fixtures are ngspice 46 outputs."""

import json
import os
import shutil
import stat
import tempfile
import unittest

import device_probe
import ngspice_adapter as base

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def lines(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return f.read().splitlines()


class ClassifyTest(unittest.TestCase):
    def test_a_value_is_simulates(self):
        status, value, reason, warnings = device_probe.classify(lines("probe-ok.log"))
        self.assertEqual((status, reason), ("simulates", None))
        self.assertAlmostEqual(value, -8.57001e-05)

    def test_an_unknown_subcircuit_or_model_fails_with_the_cause(self):
        self.assertEqual(device_probe.classify(lines("probe-nosub.log"))[:3], ("fails", None, "Error: unknown subckt: xdut a 0 nosuchdev"))
        status, _, reason, _ = device_probe.classify(lines("probe-nomodel.log"))
        self.assertEqual(status, "fails")
        self.assertIn("could not find a valid modelname", reason)

    def test_a_failed_operating_point_parses(self):
        status, value, reason, _ = device_probe.classify(lines("probe-singular.log"))
        self.assertEqual((status, value), ("parses", None))
        self.assertEqual(reason, "Error: Transient op failed, timestep too small")

    def test_an_ignored_model_parameter_is_a_warning(self):
        status, _, _, warnings = device_probe.classify(lines("probe-badparam.log"))
        self.assertEqual(status, "simulates")
        self.assertIn("unrecognized parameter (foo) - ignored", warnings)


FAKE_NGSPICE = """#!/bin/sh
# fake ngspice: a deck with "nosuchdev" fails, a deck with "sleep" hangs, else one value
if grep -q nosuchdev "$2"; then echo "Error: unknown subckt: xdut a 0 nosuchdev"; echo "Simulation interrupted due to error!"; exit 1; fi
if grep -q sleepy "$2"; then sleep 30; fi
echo "i(vprobe) = -1.5e-03"
"""


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d)
        bin_dir = os.path.join(self.d, "bin")
        os.makedirs(bin_dir)
        path = os.path.join(bin_dir, "ngspice")
        with open(path, "w") as f:
            f.write(FAKE_NGSPICE)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        tech = os.path.join(self.d, "tech", "toy")
        os.makedirs(tech)
        with open(os.path.join(self.d, "lib.lib"), "w") as f:
            f.write(".lib tt\n.endl tt\n")
        pack = {"schema": "simra.technology/0", "name": "toy", "pdks": ["toy1"], "device_probe": {"toy1": {
            "libs": {"l": {"ngspice": {"path": "{pdk_root}/lib.lib", "section": "tt"}}},
            "classes": {"good": {"lib": "l", "netlist": ["r1 a 0 1k", "vprobe a 0 1"]},
                        "bad": {"lib": "l", "netlist": ["xdut a 0 nosuchdev", "vprobe a 0 1"]},
                        "slow": {"lib": "l", "netlist": ["* sleepy", "vprobe a 0 1"]},
                        "nolib": {"lib": "other", "netlist": ["vprobe a 0 1"]}}}}}
        with open(os.path.join(tech, "technology.json"), "w") as f:
            json.dump(pack, f)
        self.env = {"PATH": bin_dir + os.pathsep + os.environ["PATH"], "SIMRA_TECHNOLOGY_DIR": os.path.join(self.d, "tech"), "PDK_ROOT": self.d,
                    "SPICE_USERINIT_DIR": self.d, "HOME": self.d}
        self.old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_one_row_per_class(self):
        work = os.path.join(self.d, "work")
        os.makedirs(work)
        resp = device_probe.probe_devices({"root": self.d, "work_dir": work, "inputs": {"pdk": "toy1", "timeout_s": 2}})
        self.assertEqual(resp["status"], "completed")
        with open(os.path.join(work, "probe.json")) as f:
            table = json.load(f)
        rows = {r["class"]: r for r in table["rows"]}
        self.assertEqual(rows["good"]["status"], "simulates")
        self.assertEqual(rows["good"]["value_a"], -1.5e-3)
        self.assertEqual((rows["bad"]["status"], rows["bad"]["reason"]), ("fails", "Error: unknown subckt: xdut a 0 nosuchdev"))
        self.assertEqual((rows["slow"]["status"], rows["slow"]["reason"]), ("not run", "no result in 2 s"))
        self.assertEqual(rows["nolib"]["reason"], "the pack gives no ngspice library for other")
        m = resp["measurements"]
        self.assertEqual([m[k]["value"] for k in ("classes_total", "classes_simulates", "classes_fails", "classes_not_run")], [4, 1, 2, 1])
        self.assertTrue(any(o.get("role") == "probe" for o in resp["outputs"]))
        with open(os.path.join(work, "probe", "good.cir")) as f:
            deck = f.read()
        self.assertIn('.lib "{}/lib.lib" tt'.format(self.d), deck)
        self.assertIn("print i(vprobe)", deck)

    def test_unknown_class_and_pdk(self):
        work = os.path.join(self.d, "work")
        os.makedirs(work)
        bad = device_probe.probe_devices({"root": self.d, "work_dir": work, "inputs": {"pdk": "toy1", "classes": ["nope"]}})
        self.assertIn("unknown device classes: nope", bad["diagnostics"][0]["message"])
        none = device_probe.probe_devices({"root": self.d, "work_dir": work, "inputs": {"pdk": "other"}})
        self.assertIn("no technology pack with device_probe.other", none["diagnostics"][0]["message"])


if __name__ == "__main__":
    unittest.main()
