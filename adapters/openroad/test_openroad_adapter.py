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

    def check(self, name, time_unit=None, text=None, **limits):
        text = orlog.read_text(os.path.join(FIX, name)) if text is None else text
        report = orlog.timing_report(text, time_unit)
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
        # The worst slack is the slack of the path report. The wns line is 0 for each slack that is not negative.
        self.assertAlmostEqual(report["worst_slack"], 2.052)
        self.assertAlmostEqual(report["wns"], 0.0)
        self.assertAlmostEqual(report["slack_lines"][0]["value"], 2.052)
        self.assertEqual((report["period_source"], report["time_unit"], report["time_unit_source"]), ("path", "ns", "assumed"))
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
        _, _, (status, reasons) = self.check("prelayout_no_buffers.log", time_unit="ns", clock_period=100, max_violations=30)
        self.assertEqual(status, "valid")
        _, _, (status, reasons) = self.check("prelayout_no_buffers.log", time_unit="ns", clock_period=1, max_slack_periods=100, max_violations=30)
        self.assertEqual(status, "invalid check")
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


class TimingEvidence(unittest.TestCase):
    """What counts as a timing result, the clock period, the time unit, the violation tables and the path."""

    check = TimingCheck.check

    def test_a_path_header_without_a_slack_line_is_not_run(self):
        report, _, (status, reasons) = self.check(None, text="Startpoint: u0 (rising edge-triggered flip-flop clocked by clk)\n")
        self.assertEqual((report["paths"], report["incomplete_paths"]), (0, 1))
        self.assertEqual(status, "not run")
        self.assertIn("1 path header without a slack line", reasons[0])
        # A header, then an error, then nothing: the path is not complete.
        report, _, (status, _) = self.check(None, text="Startpoint: u0\nEndpoint: u1\nError: out of memory\n")
        self.assertEqual(status, "not run")
        # A text that only starts like a summary line is not one.
        _, _, (status, _) = self.check(None, text="wns max 0 paths reported\n")
        self.assertEqual(status, "not run")

    def test_slack_with_an_exponent(self):
        report, _, (status, _) = self.check(None, text="Startpoint: a\nEndpoint: b\n   1e-3   slack (MET)\n")
        self.assertEqual(status, "valid")
        self.assertAlmostEqual(report["worst_slack"], 0.001)
        report, _, _ = self.check(None, text="  -2.5E+01   slack (VIOLATED)\nworst slack max -2.5e1\n")
        self.assertAlmostEqual(report["worst_slack"], -25.0)

    def test_a_failed_run_appended_to_a_valid_log_is_not_run(self):
        # The fixture is sta_valid.log with sta_not_a_module.log appended: a script that writes its log with '>>'.
        report, _, (status, reasons) = self.check("sta_valid_then_not_a_module.log")
        self.assertEqual(status, "not run")
        self.assertEqual(report["stale"]["last_result_line"], 49)
        self.assertEqual(report["stale"]["problem"]["line"], 50)
        self.assertIn("acc is not a verilog module", reasons[0])
        self.assertIn("older run", reasons[0])
        # Negative control: an error line before the results (a first try, then a good run) does not hide them.
        good = orlog.read_text(os.path.join(FIX, "sta_valid.log"))
        _, _, (status, _) = self.check(None, text="Error: 1390 acc is not a verilog module.\n" + good)
        self.assertEqual(status, "valid")

    def test_a_rise_and_a_fall_edge_do_not_give_the_period(self):
        # A path from a rising-edge to a falling-edge flip-flop at a period of 10 ns: the edges are 5 ns apart.
        report, _, (status, _) = self.check("sta_half_cycle.log")
        self.assertEqual(status, "valid")
        self.assertAlmostEqual(report["worst_slack"], 4.346)
        self.assertIsNone(report["period"])
        self.assertIsNone(report["worst_path"]["period"])
        # With the create_clock line of the script in the log, the period is the declared one.
        text = "create_clock -name clk -period 10 [get_ports clk]\n" + orlog.read_text(os.path.join(FIX, "sta_half_cycle.log"))
        report, _, _ = self.check(None, text=text)
        self.assertEqual((report["period"], report["period_source"]), (10.0, "create_clock"))
        # The same edge of one clock two times gives the period; a create_clock line of that clock goes first.
        report, _, _ = self.check("sta_valid.log")
        self.assertAlmostEqual(report["period"], 7.1)
        report, _, _ = self.check(None, text="create_clock -name clk -period 14.2 [get_ports clk]\ncreate_clock -name other -period 3 [get_ports c2]\n"
                                  + orlog.read_text(os.path.join(FIX, "sta_valid.log")))
        self.assertEqual((report["period"], report["period_source"]), (14.2, "create_clock"))

    def test_a_negative_slack_without_a_period_leaves_the_limit_unchecked(self):
        text = orlog.read_text(os.path.join(FIX, "sta_half_cycle.log")).replace("4.346   slack (MET)", "-60.000   slack (VIOLATED)")
        report, violations, (status, reasons) = self.check(None, text=text)
        limit = orlog.slack_limit(report)
        self.assertEqual((limit["evaluated"], limit["beyond"]), (False, False))
        self.assertIn("no clock period", limit["why"])
        self.assertEqual(status, "valid", "an unchecked limit is not a reason; the adapter reports it as not run")
        # With the period from the caller and the unit of the log: -60 ns at 10 ns is 6 periods, inside the limit.
        _, _, (status, _) = self.check(None, text=text, time_unit="ns", clock_period=10)
        self.assertEqual(status, "valid")
        _, _, (status, _) = self.check(None, text=text, time_unit="ns", clock_period=5)
        self.assertEqual(status, "invalid check")

    def test_report_in_ps(self):
        # The log has the output of report_units ('time 1ps'): slack -104.2 ps at a period of 7100 ps.
        report, _, (status, _) = self.check("sta_units_ps.log", clock_period=7.1)
        self.assertEqual((report["time_unit"], report["time_unit_source"]), ("ps", "log"))
        self.assertAlmostEqual(report["worst_slack"], -0.1042)
        self.assertAlmostEqual(report["period"], 7.1)
        self.assertEqual(status, "valid")
        limit = orlog.slack_limit(report, 7.1)
        self.assertTrue(limit["evaluated"])
        self.assertAlmostEqual(limit["periods"], 0.1042 / 7.1)

    def test_period_from_the_caller_needs_the_unit_of_the_log(self):
        text = "wns max -200\nworst slack max -200\n"
        report, _, (status, _) = self.check(None, text=text, clock_period=10)
        self.assertEqual(report["time_unit_source"], "assumed")
        limit = orlog.slack_limit(report, 10)
        self.assertFalse(limit["evaluated"])
        self.assertIn("time_unit", limit["why"])
        self.assertEqual(status, "valid")
        _, _, (status, _) = self.check(None, text=text, time_unit="ps", clock_period=10)
        self.assertEqual(status, "valid")
        _, _, (status, reasons) = self.check(None, text=text, time_unit="ns", clock_period=10)
        self.assertEqual(status, "invalid check")
        self.assertIn("20.0 clock periods negative", reasons[0])
        # The boundary: 10 periods negative is inside the limit, more is beyond it.
        _, _, (status, _) = self.check(None, text="worst slack max -100\n", time_unit="ns", clock_period=10)
        self.assertEqual(status, "valid")
        _, _, (status, _) = self.check(None, text="worst slack max -100.001\n", time_unit="ns", clock_period=10)
        self.assertEqual(status, "invalid check")

    def test_the_table_after_the_repair_replaces_the_table_before_it(self):
        # The accumulator after the placement: 200 fanout violators before repair_design (25 rows kept), 2 after it.
        _, violations, (status, reasons) = self.check("placed_repair_before_and_after.log")
        self.assertEqual(violations["found"], {"fanout": 200})
        self.assertEqual(violations["buffers"], 201)
        self.assertEqual(violations["before_repair"], {"fanout": 25})
        self.assertEqual(violations["remaining"], {"fanout": 2})
        self.assertEqual(status, "invalid check")
        self.assertIn("2 max fanout", reasons[0])
        _, _, (status, _) = self.check("placed_repair_before_and_after.log", max_violations=2)
        self.assertEqual(status, "valid")
        # The same log without the table after the repair (a clean report prints no table): no violation remains.
        text = orlog.read_text(os.path.join(FIX, "placed_repair_before_and_after.log"))
        head, tail = text.split("report after the repair\n")
        clean = head + "report after the repair\n" + tail[tail.index("Startpoint:"):]
        _, violations, (status, _) = self.check(None, text=clean)
        self.assertEqual((violations["before_repair"], violations["remaining"]), ({"fanout": 25}, {}))
        self.assertEqual(status, "valid")
        # Two tables of one kind with no repair between them: the newest one counts.
        table = "max slew\n\nPin  Limit  Slew  Slack\n-----\n{}\n[INFO] next\n"
        row = "u{}/A  2.51  3.00  -0.49 (VIOLATED)\n"
        two = table.format("".join(row.format(k) for k in range(5))) + table.format(row.format(0))
        self.assertEqual(orlog.design_violations(two)["remaining"], {"slew": 1})

    def test_a_create_clock_line_of_another_clock_is_not_the_period(self):
        # A clk path at 7.1 ns with a slack of -80 ns: more than 10 periods negative.
        base = orlog.read_text(os.path.join(FIX, "sta_valid.log")).replace("2.052   slack (MET)", "-80.000   slack (VIOLATED)")
        report, _, (status, _) = self.check(None, text=base)
        self.assertEqual(status, "invalid check")
        report, _, (status, _) = self.check(None, text="create_clock -name other -period 100 [get_ports c2]\n" + base)
        self.assertEqual((report["period_source"], status), ("path", "invalid check"))
        self.assertAlmostEqual(report["period"], 7.1)
        # A declaration without -name has the name of its port.
        report, _, _ = self.check(None, text="create_clock -period 14.2 [get_ports clk]\ncreate_clock -period 100 [get_ports c2]\n" + base)
        self.assertEqual((report["period"], report["period_source"]), (14.2, "create_clock"))
        # Without a path report the clock is not known: one declared period is used, two different ones are not.
        report, _, _ = self.check(None, text="create_clock -name a -period 5 [get_ports a]\nwns max -1\n")
        self.assertEqual(report["period"], 5.0)
        report, _, _ = self.check(None, text="create_clock -name a -period 5 [get_ports a]\ncreate_clock -name b -period 9 [get_ports b]\nwns max -1\n")
        self.assertIsNone(report["period"])

    def test_a_table_that_is_cut_off_does_not_erase_a_count(self):
        table = "max fanout\n\nPin  Limit Fanout  Slack\n-----------------\nu1/X  8  12  -4 (VIOLATED)\n\n"
        self.assertEqual(orlog.design_violations(table)["remaining"], {"fanout": 1})
        # The log ends after the heading of a second table: the first count stays.
        _, violations, (status, _) = self.check(None, text=table + "wns max 0.1\nmax fanout\n")
        self.assertEqual(violations["remaining"], {"fanout": 1})
        self.assertEqual(status, "invalid check")
        # A complete second table without rows replaces the count.
        empty = "max fanout\n\nPin  Limit Fanout  Slack\n-----------------\n\n[INFO] next\n"
        self.assertEqual(orlog.design_violations(table + empty)["remaining"], {"fanout": 0})

    def test_clock_network_cells_are_not_stages(self):
        text = orlog.read_text(os.path.join(FIX, "sta_valid.log"))
        launch = "   0.000    0.000 ^ _910_/CLK (sg13g2_dfrbpq_1)\n"
        self.assertIn(launch, text)
        buffered = text.replace(launch, "   0.100    0.100 ^ clkbuf_0_clk/X (sg13g2_buf_8)\n   0.100    0.200 ^ clkbuf_1_0__f_clk/X (sg13g2_buf_8)\n" + launch)
        report, _, _ = self.check(None, text=buffered)
        self.assertEqual((report["worst_path"]["stages"], report["worst_path"]["logic_depth"]), (21, 20))
        self.assertEqual(report["worst_path"]["cells"][0], "sg13g2_dfrbpq_1")


class SpefCheck(unittest.TestCase):
    def test_triplets_are_segments(self):
        # A hand-written file: 5 segments, 2 of them '0:0:0'. The share of 0 ohm segments is 2/5.
        counts = orspef.read_spef(os.path.join(FIX, "hand_triplets.spef"))
        self.assertEqual((counts["nets"], counts["res_segments"], counts["res_zero_segments"], counts["res_bad_rows"]), (2, 5, 2, 0))
        self.assertAlmostEqual(counts["res_zero_fraction"], 0.4)
        self.assertAlmostEqual(counts["res_total_ohm"], 1 + 12.0 + 4.0)  # the typical value of each triplet
        self.assertAlmostEqual(counts["cap_total_pf"], 0.003)
        status, reason = orspef.check_spef(counts)
        self.assertEqual(status, "invalid")
        self.assertIn("2 of 5 resistance segments are 0 ohm", reason)
        self.assertEqual(orspef.check_spef(counts, 0.5)[0], "valid")
        self.assertEqual(orspef.spef_value("0.5:0.6:0.7"), [0.5, 0.6, 0.7])
        self.assertIsNone(orspef.spef_value("0.5:0.6"))

    def test_a_corner_without_resistance_is_invalid(self):
        net = "*D_NET n1 2.0\n*CONN\n*I u1:A I\n*CAP\n1 n1:1 2.0\n*RES\n{}*END\n"
        with tempfile.TemporaryDirectory() as work:
            counts = self.spef(work, net.format("".join("{} n1:{} n1:{} 0:0:1\n".format(k, k, k + 1) for k in range(1, 5))))
            self.assertEqual(counts["res_segments"], 4)
            self.assertEqual(counts["res_zero_by_corner"], [4, 4, 0])
            self.assertEqual(counts["res_zero_segments"], 4)
            status, reason = orspef.check_spef(counts)
            self.assertEqual(status, "invalid")
            self.assertIn("best and typical", reason)
            # One corner with too many 0 ohm segments, the other corners fine.
            mixed = self.spef(work, net.format("1 n1:1 n1:2 1:1:0\n2 n1:2 n1:3 1:1:0\n3 n1:3 n1:4 1:1:1\n4 n1:4 n1:5 2\n"))
            self.assertEqual(mixed["res_zero_by_corner"], [0, 0, 2])
            status, reason = orspef.check_spef(mixed)
            self.assertEqual(status, "invalid")
            self.assertIn("worst corner", reason)
            self.assertEqual(orspef.check_spef(mixed, 0.5)[0], "valid")

    def test_small_negative_values(self):
        net = "*D_NET n1 2.0\n*CONN\n*I u1:A I\n*CAP\n1 n1:1 2.0\n*RES\n{}*END\n"
        with tempfile.TemporaryDirectory() as work:
            # -5e-7 ohm is not the noise of an extraction without resistance (about 1e-16): it is a negative value.
            small = self.spef(work, net.format("1 n1:1 n1:2 -5e-7\n2 n1:2 n1:3 1\n3 n1:3 n1:4 1\n4 n1:4 n1:5 1\n"))
            self.assertEqual(small["res_negative_segments"], 1)
            self.assertEqual(orspef.check_spef(small)[0], "invalid")
            noise = self.spef(work, net.format("1 n1:1 n1:2 -5e-16\n2 n1:2 n1:3 1\n3 n1:3 n1:4 1\n4 n1:4 n1:5 1\n"))
            self.assertEqual((noise["res_negative_segments"], noise["res_zero_segments"]), (0, 1))
            self.assertEqual(orspef.check_spef(noise)[0], "valid")

    def test_damaged_gzip_data_is_an_error_of_the_read(self):
        import gzip
        with tempfile.TemporaryDirectory() as work:
            with open(os.path.join(FIX, "acc_lef_res.spef"), "rb") as f:
                packed = bytearray(gzip.compress(f.read()))
            for k in range(40, 400):
                packed[k] ^= 0xFF  # a valid header, then a damaged block
            path = os.path.join(work, "x.spef.gz")
            with open(path, "wb") as f:
                f.write(bytes(packed))
            with self.assertRaises(OSError):
                orspef.read_spef(path)

    def test_unknown_unit_is_invalid(self):
        counts = orspef.read_spef(os.path.join(FIX, "hand_unknown_unit.spef"))
        self.assertEqual(counts["unit_errors"], ["*R_UNIT 1 BOGUS"])
        status, reason = orspef.check_spef(counts)
        self.assertEqual(status, "invalid")
        self.assertIn("*R_UNIT 1 BOGUS", reason)

    def spef(self, work, body, units="*C_UNIT 1 FF\n*R_UNIT 1 OHM\n"):
        path = os.path.join(work, "x.spef")
        with open(path, "w") as f:
            f.write('*SPEF "ieee 1481-1999"\n*DESIGN "x"\n' + units + "\n" + body)
        return orspef.read_spef(path)

    def test_negative_values_bad_rows_and_missing_units_are_invalid(self):
        net = "*D_NET n1 2.0\n*CONN\n*I u1:A I\n*CAP\n1 n1:1 2.0\n*RES\n{}*END\n"
        with tempfile.TemporaryDirectory() as work:
            negative = self.spef(work, net.format("1 n1:1 n1:2 -1\n"))
            self.assertEqual((negative["res_segments"], negative["res_negative_segments"], negative["res_zero_segments"]), (1, 1, 0))
            self.assertIn("negative", orspef.check_spef(negative)[1])
            triplet = self.spef(work, net.format("1 n1:1 n1:2 -2:5:8\n2 n1:2 n1:3 5\n"))
            self.assertEqual(triplet["res_negative_segments"], 1)
            self.assertEqual(orspef.check_spef(triplet)[0], "invalid")
            bad = self.spef(work, net.format("1 n1:1 n1:2 12.5\n2 n1:2 n1:3 abc\n3 n1:3\n"))
            self.assertEqual((bad["res_segments"], bad["res_bad_rows"]), (1, 2))
            status, reason = orspef.check_spef(bad)
            self.assertEqual(status, "invalid")
            self.assertIn("2 rows of the *RES sections are not a resistance", reason)
            no_unit = self.spef(work, net.format("1 n1:1 n1:2 12.5\n"), units="*C_UNIT 1 FF\n")
            self.assertEqual(no_unit["unit_errors"], ["no *R_UNIT line"])
            self.assertEqual(orspef.check_spef(no_unit)[0], "invalid")
            # Negative control: the same net with a plain value and the units is valid.
            self.assertEqual(orspef.check_spef(self.spef(work, net.format("1 n1:1 n1:2 12.5\n")))[0], "valid")

    def test_a_gz_file_that_is_not_gzip_data_is_an_error_of_the_read(self):
        with tempfile.TemporaryDirectory() as work:
            path = os.path.join(work, "x.spef.gz")
            with open(path, "w") as f:
                f.write(orlog.read_text(os.path.join(FIX, "acc_lef_res.spef")))
            with self.assertRaises(OSError):
                orspef.read_spef(path)

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
        self.assertEqual(response["measurements"]["worst_slack_ns"]["value"], 2.052)
        self.assertEqual(response["measurements"]["wns_ns"]["value"], 0.0)
        self.assertEqual(response["measurements"]["slack_limit_check"]["value"], 1)
        self.assertEqual(response["diagnostics"], [])
        self.assertEqual(response["input_files"]["files"][0]["role"], "log")
        relaxed = self.run_op("timing", {"log": "prelayout_no_buffers.log", "max_slack_periods": 20, "max_violations": 30})
        self.assertEqual(relaxed["status"], "completed")
        self.assertAlmostEqual(relaxed["measurements"]["worst_slack_ns"]["value"], -158.792)
        self.assertEqual(self.run_op("timing", {"log": "sta_valid.log", "max_violations": -1})["status"], "failed")

    def test_timing_invalid_report_has_no_slack_number(self):
        response = self.run_op("timing", {"log": "prelayout_no_buffers.log"})
        shown = json.dumps([response["report"], response["diagnostics"], response["measurements"]["timing_check"]])
        self.assertNotIn("158.79", shown)
        self.assertNotIn("1905506", shown)
        self.assertIn("15.9 clock periods negative", shown)
        self.assertIn("2 stages, logic depth 1", shown)

    def test_timing_units_and_unchecked_limit(self):
        ps = self.run_op("timing", {"log": "sta_units_ps.log", "clock_period_ns": 7.1})
        self.assertEqual(ps["status"], "completed")
        self.assertAlmostEqual(ps["measurements"]["worst_slack_ns"]["value"], -0.1042)
        self.assertAlmostEqual(ps["measurements"]["clock_period_ns"]["value"], 7.1)
        self.assertEqual(ps["measurements"]["slack_limit_check"]["value"], 1)
        self.assertIn("time unit of the log: ps (stated in the log)", ps["report"])
        with tempfile.TemporaryDirectory() as work:
            with open(os.path.join(work, "summary.log"), "w") as f:
                f.write("wns max -200\nworst slack max -200\n")
            request = {"contract": "simra.adapter/0", "experiment": None, "adapter": "openroad", "operation": "timing",
                       "inputs": {"log": "summary.log", "clock_period_ns": 10}, "root": work, "work_dir": work,
                       "response_path": os.path.join(work, "response.json")}

            def run(**inputs):
                request["inputs"] = dict({"log": "summary.log", "clock_period_ns": 10}, **inputs)
                with open(os.path.join(work, "request.json"), "w") as f:
                    json.dump(request, f)
                self.assertEqual(openroad_adapter.main(["openroad_adapter.py", os.path.join(work, "request.json")]), 0)
                with open(request["response_path"]) as f:
                    return json.load(f)

            unknown = run()
            self.assertEqual(unknown["measurements"]["slack_limit_check"]["status"], "missing")
            self.assertTrue(unknown["measurements"]["slack_limit_check"]["reason"].startswith("not run: "))
            self.assertIn("slack limit check: not run", " ".join(unknown["report"]))
            self.assertEqual([d["severity"] for d in unknown["diagnostics"]], ["warning"])
            self.assertEqual(run(time_unit="ps")["status"], "completed")
            self.assertAlmostEqual(run(time_unit="ps")["measurements"]["worst_slack_ns"]["value"], -0.2)
            self.assertEqual(run(time_unit="ns")["status"], "failed")
            self.assertEqual(run(time_unit="weeks")["status"], "failed")

    def test_timing_appended_failure_is_not_run(self):
        response = self.run_op("timing", {"log": "sta_valid_then_not_a_module.log"})
        self.assertEqual(response["status"], "failed")
        self.assertTrue(response["measurements"]["timing_check"]["reason"].startswith("not run: the last run in the log"))
        self.assertEqual(response["measurements"]["worst_slack_ns"]["status"], "missing")
        self.assertNotIn("worst_path_stages", response["measurements"])

    def test_spef_triplets_units_and_unreadable_files(self):
        triplets = self.run_op("spef", {"spef": "hand_triplets.spef"})
        self.assertEqual(triplets["status"], "failed")
        self.assertEqual((triplets["measurements"]["res_segments"]["value"], triplets["measurements"]["res_zero_segments"]["value"]), (5, 2))
        unit = self.run_op("spef", {"spef": "hand_unknown_unit.spef"})
        self.assertEqual(unit["status"], "failed")
        self.assertEqual(unit["measurements"]["res_total_ohm"]["status"], "failed")
        self.assertEqual(unit["measurements"]["res_segments"]["value"], 2)
        with tempfile.TemporaryDirectory() as work:
            with open(os.path.join(work, "x.spef.gz"), "w") as f:
                f.write("not gzip data")
            request = {"contract": "simra.adapter/0", "experiment": None, "adapter": "openroad", "operation": "spef",
                       "inputs": {"spef": "x.spef.gz"}, "root": work, "work_dir": work, "response_path": os.path.join(work, "response.json")}
            with open(os.path.join(work, "request.json"), "w") as f:
                json.dump(request, f)
            self.assertEqual(openroad_adapter.main(["openroad_adapter.py", os.path.join(work, "request.json")]), 0)
            with open(request["response_path"]) as f:
                response = json.load(f)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["report"], ["spef check: not run"])
        self.assertTrue(response["measurements"]["spef_check"]["reason"].startswith("not run: the file x.spef.gz cannot be read"))

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
