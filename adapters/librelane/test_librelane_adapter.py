"""Tests of the LibreLane run reader, the comparison of two runs and the request checks of the replay.
The run directories are made in a temporary directory: small files with the structure of a LibreLane run."""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)

import librelane_adapter  # noqa: E402
import librelane_run as reader  # noqa: E402

FIX = os.path.join(os.path.dirname(HERE), "openroad", "fixtures")
CORNERS = ["nom_fast_1p32V_m40C", "nom_slow_1p08V_125C", "nom_typ_1p20V_25C"]
TYP = "nom_typ_1p20V_25C"


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        if isinstance(data, str):
            f.write(data)
        else:
            json.dump(data, f)


def slack(corner, setup, hold):
    return {"timing__setup__ws__corner:" + corner: setup, "timing__hold__ws__corner:" + corner: hold}


def make_run(design, tag, settings=None, netlist="module a; endmodule\n", buffers=17, mid_corners=(TYP,), slow_lib="slow.lib",
             repair_log="hold_closed.log"):
    """A run with the steps: synthesis, timing without wires (all corners), placement, clock tree, repair, timing."""
    run = os.path.join(design, "runs", tag)
    resolved = {"DESIGN_DIR": design, "STA_CORNERS": CORNERS, "DEFAULT_CORNER": TYP, "VERILOG_FILES": [os.path.join(design, "src", "a.v")],
                "CTS_X": None, "SYNTH_Y": 1}
    resolved.update(settings or {})
    write(os.path.join(run, "resolved.json"), resolved)
    metrics = {}

    def step(index, name, sid, variables, fresh=None, views=None, own_metrics=True, log=None):
        directory = os.path.join(run, "{:02d}-{}".format(index, name))
        config = {"meta": {"step": sid}}
        config.update({k: resolved.get(k) for k in variables})
        write(os.path.join(directory, "config.json"), config)
        write(os.path.join(directory, "state_in.json"), {"metrics": dict(metrics)})
        metrics.update(fresh or {})
        state = {"metrics": dict(metrics)}
        for key, text in (views or {}).items():
            path = os.path.join(directory, "a.{}.v".format(key))
            write(path, text)
            state[key] = path
        write(os.path.join(directory, "state_out.json"), state)
        if fresh is not None and own_metrics:
            write(os.path.join(directory, "or_metrics_out.json"), fresh)
        if log:
            shutil.copy(os.path.join(FIX, log), os.path.join(directory, name + ".log"))
        return directory

    step(6, "yosys-synthesis", "Yosys.Synthesis", ["SYNTH_Y", "VERILOG_FILES"], views={"nl": netlist})
    pre = {}
    for corner, values in zip(CORNERS, ((4.3, -0.04), (0.95, 0.23), (3.0, 0.1))):
        pre.update(slack(corner, *values))
    directory = step(12, "openroad-staprepnr", "OpenROAD.STAPrePNR", [], fresh=pre, own_metrics=False)
    for corner in CORNERS:
        lib = os.path.join(FIX, slow_lib if "slow" in corner else "slow.lib")
        text = "Reading cell library for the '{}' corner at '{}'…\n".format(corner, lib) if "slow" in corner else "\n"
        write(os.path.join(directory, corner, "sta.log"), text)
    step(28, "openroad-globalplacement", "OpenROAD.GlobalPlacement", [], fresh={"design__instance__count": 100})
    step(35, "openroad-cts", "OpenROAD.CTS", ["CTS_X"], fresh={"design__instance__count__class:clock_buffer": buffers},
         views={"nl": netlist + "// buffers {}\n".format(buffers)})
    step(37, "openroad-resizertimingpostcts", "OpenROAD.ResizerTimingPostCTS", [], fresh={"design__instance__count": 120}, log=repair_log)
    mid = {}
    for corner in mid_corners:
        mid.update(slack(corner, 1.6, 0.03))
    step(38, "openroad-stamidpnr-2", "OpenROAD.STAMidPNR", ["PNR_CORNERS"] if False else [], fresh=mid)
    return run


class Reader(unittest.TestCase):
    def setUp(self):
        self.design = tempfile.mkdtemp()
        write(os.path.join(self.design, "src", "a.v"), "module a; endmodule\n")
        old = 1_600_000_000
        os.utime(os.path.join(self.design, "src", "a.v"), (old, old))

    def tearDown(self):
        shutil.rmtree(self.design)

    def call(self, operation, inputs):
        work = tempfile.mkdtemp(dir=self.design)
        request = {"contract": "simra.adapter/0", "experiment": None, "adapter": "librelane", "operation": operation,
                   "inputs": inputs, "root": self.design, "work_dir": work, "response_path": os.path.join(work, "response.json")}
        path = os.path.join(work, "request.json")
        write(path, request)
        self.assertEqual(librelane_adapter.main(["librelane_adapter.py", path]), 0)
        with open(request["response_path"]) as f:
            return json.load(f)

    def warnings(self, response):
        return [d["message"] for d in response["diagnostics"] if d["severity"] == "warning"]

    def test_levels_and_carried_corners(self):
        make_run(self.design, "r1")
        response = self.call("read", {"run": "runs/r1"})
        m = response["measurements"]
        self.assertEqual(m["setup_ws_ns@" + TYP]["level"], "placement_estimate")
        self.assertEqual(m["setup_ws_ns@nom_slow_1p08V_125C"]["level"], "no_wires")
        self.assertEqual(m["setup_ws_ns@nom_slow_1p08V_125C"]["value"], 0.95)
        self.assertEqual(m["clock_buffers"]["value"], 17)
        carried = [w for w in self.warnings(response) if "carry the old values" in w]
        self.assertEqual(len(carried), 1)
        self.assertIn("nom_slow_1p08V_125C", carried[0])

    def test_negative_control_clean_run_is_silent(self):
        make_run(self.design, "r1", mid_corners=CORNERS)
        response = self.call("read", {"run": "runs/r1", "against": "auto"})
        self.assertEqual(response["status"], "completed")
        self.assertEqual(self.warnings(response), [])

    def test_label_mismatch(self):
        make_run(self.design, "r1", mid_corners=CORNERS, slow_lib="typ_named_slow.lib")
        found = self.warnings(self.call("read", {"run": "runs/r1"}))
        self.assertEqual(len(found), 1)
        self.assertIn("the corner name says 1.08 V", found[0])

    def test_repair_pattern_and_unfinished_step(self):
        run = make_run(self.design, "r1", mid_corners=CORNERS, repair_log="hold_one_sweep.log")
        os.remove(os.path.join(run, "38-openroad-stamidpnr-2", "state_out.json"))
        found = self.warnings(self.call("read", {"run": "runs/r1"}))
        self.assertTrue(any("one pass for each violating end point" in w for w in found))
        self.assertTrue(any("has no state_out.json" in w for w in found))

    def test_newer_source(self):
        make_run(self.design, "r1", mid_corners=CORNERS)
        os.utime(os.path.join(self.design, "src", "a.v"), None)
        future = os.path.getmtime(os.path.join(self.design, "src", "a.v")) + 100
        os.utime(os.path.join(self.design, "src", "a.v"), (future, future))
        found = self.warnings(self.call("read", {"run": "runs/r1"}))
        self.assertTrue(any("newer than the run" in w and "src/a.v" in w for w in found))

    def test_compare_no_effect(self):
        make_run(self.design, "base", mid_corners=CORNERS)
        make_run(self.design, "d4", settings={"CTS_X": 50}, mid_corners=CORNERS)
        response = self.call("compare", {"run": "runs/d4", "against": "runs/base"})
        self.assertEqual(response["measurements"]["effect"]["value"], 0)
        self.assertEqual(response["measurements"]["settings_changed"]["value"], 1)
        self.assertIn("had no effect", self.warnings(response)[0])
        auto = self.warnings(self.call("read", {"run": "runs/d4", "against": "auto"}))
        self.assertTrue(any("had no effect" in w for w in auto))

    def test_negative_control_compare_effect_is_silent(self):
        make_run(self.design, "base", mid_corners=CORNERS)
        make_run(self.design, "d5", settings={"CTS_X": 60}, buffers=21, mid_corners=CORNERS)
        response = self.call("compare", {"run": "runs/d5", "against": "runs/base"})
        self.assertEqual(response["measurements"]["effect"]["value"], 1)
        self.assertEqual(self.warnings(response), [])
        self.assertEqual(self.warnings(self.call("read", {"run": "runs/d5", "against": "auto"})), [])

    def test_compare_other_input(self):
        make_run(self.design, "base", mid_corners=CORNERS)
        make_run(self.design, "d4", settings={"CTS_X": 50}, netlist="module a; wire w; endmodule\n", mid_corners=CORNERS)
        response = self.call("compare", {"run": "runs/d4", "against": "runs/base"})
        self.assertEqual(response["measurements"]["effect"]["status"], "failed")
        self.assertIn("another input differs", self.warnings(response)[0])

    def test_replay_rejects_a_variable_that_the_step_does_not_read(self):
        make_run(self.design, "r1")
        response = self.call("replay", {"run": "runs/r1", "step": 38, "set": {"CTS_X": 300}})
        self.assertEqual(response["status"], "failed")
        message = response["diagnostics"][0]["message"]
        self.assertIn("does not read CTS_X", message)
        self.assertIn("35-openroad-cts", message)

    def test_replay_unknown_step_and_not_a_run(self):
        make_run(self.design, "r1")
        self.assertEqual(self.call("replay", {"run": "runs/r1", "step": 99})["status"], "failed")
        self.assertEqual(self.call("read", {"run": "src"})["status"], "failed")


if __name__ == "__main__":
    unittest.main()
