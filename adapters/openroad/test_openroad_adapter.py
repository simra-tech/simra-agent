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
import openroad_spef as orspef  # noqa: E402

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


class TimingCheck(unittest.TestCase):
    """The logs are of public designs (see fixtures/README.md)."""

    def check(self, name, **limits):
        text = orlog.read_text(os.path.join(FIX, name))
        report = orlog.timing_report(text)
        return report, orlog.design_violations(text), orlog.check_timing(report, orlog.design_violations(text), **limits)

    def test_signed_netlist_is_not_run(self):
        report, _, (status, reasons) = self.check("sta_signed_syntax_error.log")
        self.assertEqual(status, "not run")
        self.assertEqual(report["paths"], 0)
        self.assertIn("line 1: Error: 171 fir.nl.v line 8, syntax error", reasons[0])

    def test_renamed_module_is_not_run(self):
        _, _, (status, reasons) = self.check("sta_not_a_module.log")
        self.assertEqual(status, "not run")
        self.assertIn("acc is not a verilog module", reasons[0])

    def test_negative_control_a_timing_log_is_valid(self):
        report, violations, (status, reasons) = self.check("sta_valid.log")
        self.assertEqual((status, reasons), ("valid", []))
        self.assertAlmostEqual(report["worst_slack"], 0.0)
        self.assertAlmostEqual(report["slack_lines"][0]["value"], 2.052)
        self.assertAlmostEqual(report["period"], 7.1)
        self.assertEqual(report["worst_path"]["stages"], 21)
        self.assertEqual(report["worst_path"]["logic_depth"], 20)
        self.assertEqual(violations["remaining"], {})

    def test_check_before_placement_is_invalid(self):
        report, violations, (status, reasons) = self.check("prelayout_no_buffers.log")
        self.assertEqual(status, "invalid check")
        self.assertAlmostEqual(report["worst_slack"], -158.792)
        self.assertAlmostEqual(report["period"], 10.0)
        self.assertEqual(violations["buffers"], 0)
        self.assertEqual(violations["remaining"], {"slew": 25, "fanout": 1, "capacitance": 1})
        self.assertIn("15.9 clock periods negative", reasons[0])
        self.assertIn("25 max slew", reasons[1])
        self.assertIn("the repair inserted 0 buffers", reasons[1])
        # The reading that the run gives: the worst path is one flip-flop and one cell.
        self.assertEqual((report["worst_path"]["stages"], report["worst_path"]["logic_depth"]), (2, 1))
        self.assertEqual(report["worst_path"]["cells"], ["sg13g2_dfrbpq_2", "sg13g2_mux2_1"])

    def test_limits_are_inputs(self):
        # A higher multiple of the period and a higher count: the same log gives no finding.
        _, _, (status, _) = self.check("prelayout_no_buffers.log", max_slack_periods=20, max_violations=30)
        self.assertEqual(status, "valid")
        # A period given by the caller replaces the period of the path report.
        _, _, (status, reasons) = self.check("prelayout_no_buffers.log", clock_period=100, max_violations=30)
        self.assertEqual(status, "valid")
        _, _, (status, reasons) = self.check("sta_valid.log", clock_period=0.1, max_slack_periods=0)
        self.assertEqual(status, "valid", "a slack that is not negative is never beyond the limit")

    def test_violations_left_after_a_repair(self):
        # The accumulator before the placement: the repair inserted buffers, fanout violations remain, the slack is small.
        report, violations, (status, reasons) = self.check("prelayout_fanout_left.log")
        self.assertEqual(violations["found"], {"fanout": 200})
        self.assertEqual(violations["buffers"], 66)
        self.assertEqual(violations["remaining"], {"fanout": 25})
        self.assertEqual(status, "invalid check")
        self.assertEqual(len(reasons), 1)
        self.assertIn("25 max fanout", reasons[0])
        _, _, (status, _) = self.check("prelayout_fanout_left.log", max_violations=25)
        self.assertEqual(status, "valid")

    def test_negative_control_repair_logs_without_timing_reports(self):
        # A log of a flow step with a hold repair table has slack numbers in the table only: no violation tables.
        text = orlog.read_text(os.path.join(FIX, "hold_closed.log"))
        self.assertEqual(orlog.design_violations(text)["remaining"], {})


class SpefCheck(unittest.TestCase):
    def test_extraction_with_layer_resistance_is_valid(self):
        counts = orspef.read_spef(os.path.join(FIX, "acc_lef_res.spef"))
        self.assertEqual((counts["design"], counts["nets"], counts["nets_with_res"]), ("acc", 12, 12))
        self.assertEqual(counts["res_zero_segments"], 0)
        self.assertGreater(counts["res_total_ohm"], 100)
        self.assertEqual(orspef.check_spef(counts), ("valid", None))

    def test_extraction_without_layer_resistance_is_invalid(self):
        counts = orspef.read_spef(os.path.join(FIX, "acc_lef_res_no_resistance.spef"))
        self.assertEqual(counts["nets"], 12)
        self.assertGreaterEqual(counts["res_segments"], counts["nets"])
        self.assertEqual(counts["res_zero_segments"], counts["res_segments"])
        self.assertLess(counts["res_total_ohm"], 1e-9)
        self.assertGreater(counts["cap_total_pf"], 0)
        status, reason = orspef.check_spef(counts)
        self.assertEqual(status, "invalid")
        self.assertIn("are 0 ohm", reason)

    def test_share_of_zero_segments_and_files_without_segments(self):
        with tempfile.TemporaryDirectory() as work:
            def spef(body):
                path = os.path.join(work, "x.spef")
                with open(path, "w") as f:
                    f.write('*SPEF "ieee 1481-1999"\n*DESIGN "x"\n*C_UNIT 1 FF\n*R_UNIT 1 KOHM\n\n' + body)
                return orspef.read_spef(path)
            net = "*D_NET n{0} 2.0\n*CONN\n*I u{0}:A I\n*CAP\n1 n{0}:1 2.0\n*RES\n1 n{0}:1 n{0}:2 {1}\n2 n{0}:2 n{0}:3 {2}\n*END\n\n"
            mixed = spef(net.format(1, 0.5, 0) + net.format(2, 0.25, 0.25))
            self.assertEqual((mixed["res_segments"], mixed["res_zero_segments"], mixed["nets_all_zero"]), (4, 1, 0))
            self.assertAlmostEqual(mixed["res_total_ohm"], 1000.0)
            self.assertAlmostEqual(mixed["cap_total_pf"], 0.004)
            self.assertEqual(orspef.check_spef(mixed)[0], "valid")
            self.assertEqual(orspef.check_spef(mixed, 0.1)[0], "invalid")
            half = spef(net.format(1, 0, 0) + net.format(2, 0.25, 0.25))
            status, reason = orspef.check_spef(half)
            self.assertEqual(status, "invalid")
            self.assertIn("1 nets have only such segments (first: n1)", reason)
            no_res = spef("*D_NET n1 2.0\n*CONN\n*I u1:A I\n*CAP\n1 n1:1 2.0\n*END\n")
            self.assertIn("no resistance segment", orspef.check_spef(no_res)[1])
            self.assertIn("no net", orspef.check_spef(spef(""))[1])


class TimingAndSpefOperations(unittest.TestCase):
    def run_op(self, operation, inputs):
        with tempfile.TemporaryDirectory() as work:
            request = {"contract": "simra.adapter/0", "experiment": None, "adapter": "openroad", "operation": operation,
                       "inputs": inputs, "root": FIX, "work_dir": work, "response_path": os.path.join(work, "response.json")}
            path = os.path.join(work, "request.json")
            with open(path, "w") as f:
                json.dump(request, f)
            self.assertEqual(openroad_adapter.main(["openroad_adapter.py", path]), 0)
            with open(request["response_path"]) as f:
                return json.load(f)

    def test_timing_not_run(self):
        response = self.run_op("timing", {"log": "sta_signed_syntax_error.log"})
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["measurements"]["timing_check"]["status"], "failed")
        self.assertTrue(response["measurements"]["timing_check"]["reason"].startswith("not run: "))
        self.assertEqual(response["measurements"]["worst_slack_ns"]["status"], "missing")
        self.assertIsNone(response["measurements"]["worst_slack_ns"]["value"])
        self.assertEqual(response["report"][0], "timing check: not run")
        self.assertTrue(response["diagnostics"][0]["message"].startswith("not run: "))

    def test_timing_invalid_check_gives_the_path_and_no_slack(self):
        response = self.run_op("timing", {"log": "prelayout_no_buffers.log"})
        m = response["measurements"]
        self.assertEqual(response["status"], "failed")
        self.assertTrue(m["timing_check"]["reason"].startswith("invalid check: "))
        self.assertEqual((m["worst_slack_ns"]["status"], m["worst_slack_ns"]["value"]), ("failed", None))
        self.assertEqual(m["worst_path_stages"]["value"], 2)
        self.assertEqual(m["worst_path_logic_depth"]["value"], 1)
        self.assertEqual(m["repair_buffers"]["value"], 0)
        self.assertEqual(m["max_slew_violations"]["value"], 25)
        self.assertEqual(m["clock_period_ns"]["value"], 10.0)
        self.assertEqual([d["severity"] for d in response["diagnostics"]], ["error", "warning"])
        self.assertIn("do not report the slack of this check", response["diagnostics"][1]["message"])

    def test_timing_valid(self):
        response = self.run_op("timing", {"log": "sta_valid.log"})
        self.assertEqual(response["status"], "completed")
        self.assertEqual(response["measurements"]["timing_check"]["value"], 1)
        self.assertEqual(response["measurements"]["worst_slack_ns"]["value"], 0.0)
        self.assertEqual(response["diagnostics"], [])
        self.assertEqual(response["input_files"]["files"][0]["role"], "log")
        relaxed = self.run_op("timing", {"log": "prelayout_no_buffers.log", "max_slack_periods": 20, "max_violations": 30})
        self.assertEqual(relaxed["status"], "completed")
        self.assertAlmostEqual(relaxed["measurements"]["worst_slack_ns"]["value"], -158.792)
        self.assertEqual(self.run_op("timing", {"log": "sta_valid.log", "max_violations": -1})["status"], "failed")

    def test_spef(self):
        good = self.run_op("spef", {"spef": "acc_lef_res.spef"})
        self.assertEqual(good["status"], "completed")
        self.assertEqual(good["measurements"]["spef_check"]["value"], 1)
        self.assertEqual(good["measurements"]["res_zero_fraction"]["value"], 0)
        self.assertEqual(good["report"][0], "spef check: valid")
        bad = self.run_op("spef", {"spef": "acc_lef_res_no_resistance.spef"})
        self.assertEqual(bad["status"], "failed")
        self.assertEqual(bad["measurements"]["spef_check"]["status"], "failed")
        self.assertTrue(bad["measurements"]["spef_check"]["reason"].startswith("invalid: all "))
        self.assertEqual(bad["measurements"]["res_zero_fraction"]["value"], 1)
        self.assertEqual(bad["report"][0], "spef check: invalid")
        self.assertIn("-lef_res", bad["diagnostics"][0]["message"])
        self.assertEqual(self.run_op("spef", {"spef": "none.spef"})["status"], "failed")


if __name__ == "__main__":
    unittest.main()
