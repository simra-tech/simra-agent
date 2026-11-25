"""Tests of the OpenROAD log readers and the parse operation. The fixtures are logs of public designs
(examples/acc-sg13g2, examples/shreg-sg13g2), shortened."""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)

import openroad_adapter  # noqa: E402
import openroad_log as orlog  # noqa: E402

FIX = os.path.join(HERE, "fixtures")


def patterns(name):
    text = orlog.read_text(os.path.join(FIX, name))
    found = orlog.messages(text)
    hold = [t for t in orlog.repair_tables(text) if t["kind"] == "hold"]
    return hold, [f["pattern"] for t in hold for f in orlog.diagnose_repair(t, found)]


class RepairTables(unittest.TestCase):
    def test_buffer_limit(self):
        hold, found = patterns("hold_buffer_limit.log")
        self.assertEqual(hold[0]["endpoints_found"], 11976)
        self.assertEqual(hold[0]["final"]["buffers"], 7971)
        self.assertIn("buffer_limit", found)
        self.assertNotIn("one_pass_per_endpoint", found)

    def test_one_sweep(self):
        hold, found = patterns("hold_one_sweep.log")
        self.assertAlmostEqual(hold[0]["final"]["wns"], -0.404)
        self.assertIn("one_pass_per_endpoint", found)
        self.assertNotIn("buffer_limit", found)

    def test_second_sweep_is_margin_only(self):
        _, found = patterns("hold_second_sweep.log")
        self.assertEqual(found, ["margin_only"])

    def test_negative_control_closed_repair_is_silent(self):
        hold, found = patterns("hold_closed.log")
        self.assertTrue(hold)
        self.assertEqual(found, [])


class OtherReaders(unittest.TestCase):
    def test_global_route(self):
        route = orlog.global_route(orlog.read_text(os.path.join(FIX, "global_route.log")))
        self.assertEqual(route["total"]["demand"], 6949)
        self.assertAlmostEqual(route["total"]["usage_pct"], 17.11)
        self.assertEqual(route["total"]["overflow"], 0)
        self.assertEqual(len(route["congestion"]), 7)
        self.assertEqual(route["wirelength_um"], 78357)

    def test_library_loads(self):
        loads = orlog.library_loads(orlog.read_text(os.path.join(FIX, "global_route.log")))
        self.assertEqual({e["corner"] for e in loads}, {"nom_typ_1p20V_25C"})

    def test_label_mismatch(self):
        header = orlog.liberty_conditions(os.path.join(FIX, "typ_named_slow.lib"))
        self.assertEqual(header["voltage"], 1.2)
        wrong = orlog.label_mismatch("nom_slow_1p08V_125C", header)
        self.assertEqual(len(wrong), 2)

    def test_negative_control_right_label_is_silent(self):
        header = orlog.liberty_conditions(os.path.join(FIX, "slow.lib"))
        self.assertEqual(orlog.label_mismatch("nom_slow_1p08V_125C", header), [])
        self.assertEqual(orlog.label_mismatch("my_corner", header), [])
        self.assertEqual(orlog.corner_conditions("nom_fast_1p32V_m40C")["temperature"], -40)


class ParseOperation(unittest.TestCase):
    def run_parse(self, inputs):
        with tempfile.TemporaryDirectory() as work:
            request = {"contract": "simra.adapter/0", "experiment": None, "adapter": "openroad", "operation": "parse",
                       "inputs": inputs, "root": FIX, "work_dir": work, "response_path": os.path.join(work, "response.json")}
            path = os.path.join(work, "request.json")
            with open(path, "w") as f:
                json.dump(request, f)
            self.assertEqual(openroad_adapter.main(["openroad_adapter.py", path]), 0)
            with open(request["response_path"]) as f:
                return json.load(f)

    def test_parse_buffer_limit(self):
        response = self.run_parse({"log": "hold_buffer_limit.log", "liberty": ["slow.lib"]})
        self.assertEqual(response["status"], "completed")
        self.assertEqual(response["measurements"]["errors"]["value"], 1)
        severities = [d["severity"] for d in response["diagnostics"]]
        self.assertIn("error", severities)
        self.assertTrue(any("buffer_limit" in d["message"] for d in response["diagnostics"]))
        self.assertTrue(any(line.startswith("liberty slow.lib") for line in response["report"]))

    def test_parse_route(self):
        response = self.run_parse({"log": "global_route.log"})
        self.assertEqual(response["measurements"]["route_overflow"]["value"], 0)
        self.assertEqual(response["diagnostics"], [])

    def test_missing_log_fails(self):
        self.assertEqual(self.run_parse({"log": "none.log"})["status"], "failed")


if __name__ == "__main__":
    unittest.main()
