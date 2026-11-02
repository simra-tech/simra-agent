"""Tests of the klayout adapter on committed fixtures. They need no KLayout: a fake binary and a fake deck stand in
for KLayout and the PDK. Run: python3 -m unittest discover -s adapters/klayout -p "test_*.py"."""

import json
import os
import re
import shutil
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)

import klayout_adapter as ka  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
TECHNOLOGIES = os.path.join(os.path.dirname(os.path.dirname(HERE)), "technologies")
SPEC_PINS = ["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7", "inp", "inn", "outp", "outn", "ibias", "vss"]
SEEDED_SG13G2 = {"M1.a": 4, "M1.b": 1, "M2.a": 1, "M2.b": 5, "M3.a": 2, "M3.b": 4, "M3.c": 2, "M3.d": 8, "V1.c": 6,
                 "V1.c1": 1, "metal2_drw_Offgrid": 4}
SEEDED_SKY130 = {"m1.1": 4, "m1.2": 1, "via.4a": 2, "m2.1": 1, "m2.2": 5, "m3.1": 2, "m3.2": 4, "m3.4": 2, "m3.6": 8,
                 "m2_OFFGRID": 4}
IHP_LVS = {"match_text": "Congratulations! Netlists match.", "mismatch_text": "Netlists don't match",
           "exit_codes": {"match": [0], "mismatch": [0]}}
SKY_LVS = dict(IHP_LVS, exit_codes={"match": [0], "mismatch": [1]})


def fixture(name):
    return os.path.join(FIXTURES, name)


def text(name):
    with open(fixture(name)) as f:
        return f.read()


def probe(name):
    with open(fixture(name)) as f:
        return json.load(f)


class MarkerDatabase(unittest.TestCase):
    def test_seeded_sg13g2(self):
        table, reason = ka.parse_lyrdb(fixture("drc-sg13g2-seeded.lyrdb"))
        self.assertIsNone(reason)
        self.assertEqual({r["rule"]: r["count"] for r in table}, SEEDED_SG13G2)
        self.assertEqual(sum(r["count"] for r in table), 38)
        counts = [r["count"] for r in table]
        self.assertEqual(counts, sorted(counts, reverse=True))
        first = table[0]
        self.assertEqual((first["rule"], first["cells"]), ("M3.d", {"idac": 8}))
        self.assertIn("Metal3", first["description"])
        v1c = next(r for r in table if r["rule"] == "V1.c")
        self.assertEqual(v1c["cells"], {"unit": 6})
        self.assertEqual(len(v1c["boxes"]), 6)
        self.assertEqual(v1c["boxes"][0], {"cell": "unit", "box": [1.835, 0.405, 1.835, 0.595]})

    def test_seeded_sky130(self):
        table, reason = ka.parse_lyrdb(fixture("drc-sky130-seeded.lyrdb"))
        self.assertIsNone(reason)
        self.assertEqual({r["rule"]: r["count"] for r in table}, SEEDED_SKY130)
        self.assertTrue(all(r["description"] for r in table))

    def test_clean(self):
        table, reason = ka.parse_lyrdb(fixture("drc-sky130-clean.lyrdb"))
        self.assertEqual((table, reason), ([], None))

    def test_truncated(self):
        table, reason = ka.parse_lyrdb(fixture("drc-sg13g2-truncated.lyrdb"))
        self.assertIsNone(table)
        self.assertIn("truncated", reason)

    def test_not_xml(self):
        with tempfile.NamedTemporaryFile("w", suffix=".lyrdb", delete=False) as f:
            f.write("<report-database><items></report-database>\n")
        try:
            table, reason = ka.parse_lyrdb(f.name)
        finally:
            os.remove(f.name)
        self.assertIsNone(table)
        self.assertIn("does not parse", reason)

    def test_value_box(self):
        self.assertEqual(ka.value_box("edge-pair: (0,1.32;-2.405,1.32)|(-2.405,1.44;0,1.44)"), [-2.405, 1.32, 0, 1.44])
        self.assertEqual(ka.value_box("polygon: (1,2;3,2;3,4;1,4)"), [1, 2, 3, 4])
        self.assertIsNone(ka.value_box("text: 'abc'"))

    def test_rule_message_at_the_limit(self):
        # M3.d has 8 markers, all in idac: with the default limit 8 the line gives all boxes and no cell counts.
        table, _ = ka.parse_lyrdb(fixture("drc-sg13g2-seeded.lyrdb"))
        message = ka.rule_message(table[0], 8)
        self.assertTrue(message.startswith("M3.d: 8 markers. Min. Metal3 area"), message)
        self.assertIn(". Boxes (µm, cell coordinates): idac: (-10.185,-7.035;-9.815,-6.665) (-9.185,", message)
        self.assertEqual(len(re.findall(r"\([-\d.]+,[-\d.]+;[-\d.]+,[-\d.]+\)", message)), 8)
        self.assertEqual(message.count("idac"), 1)
        self.assertNotIn("Cells", message)
        self.assertNotIn("more", message)
        self.assertNotIn("drc.json", message)

    def test_rule_message_above_the_limit(self):
        table, _ = ka.parse_lyrdb(fixture("drc-sg13g2-seeded.lyrdb"))
        message = ka.rule_message(table[0], 3)
        self.assertIn(". Cells: idac (8). Boxes (µm, cell coordinates): idac: (", message)
        self.assertEqual(len(re.findall(r"\([-\d.]+,[-\d.]+;[-\d.]+,[-\d.]+\)", message)), 3)
        self.assertTrue(message.endswith(" ... 5 more in work/drc.json"), message)
        self.assertTrue(ka.rule_message(table[0], 0).endswith(". Cells: idac (8). Boxes: 8 in work/drc.json"))

    def test_rule_message_groups_boxes_by_cell(self):
        rule = {"rule": "X.1", "description": "X.1", "count": 4, "cells": {"unit": 2, "idac": 2},
                "boxes": [{"cell": "unit", "box": [0, 0, 1, 1]}, {"cell": "idac", "box": [2, 2, 3, 3]},
                          {"cell": "unit", "box": [0.5, 0, 1.5, 1]}, {"cell": "idac", "box": [4, 4, 5, 5]}]}
        self.assertEqual(ka.rule_message(rule, 8),
                         "X.1: 4 markers. Boxes (µm, cell coordinates): unit: (0,0;1,1) (0.5,0;1.5,1)  idac: (2,2;3,3) (4,4;5,5)")
        self.assertEqual(ka.rule_message(rule, 3),
                         "X.1: 4 markers. Cells: unit (2), idac (2). Boxes (µm, cell coordinates): unit: (0,0;1,1) (0.5,0;1.5,1)"
                         "  idac: (2,2;3,3) ... 1 more in work/drc.json")


class DrcVerdict(unittest.TestCase):
    IHP = {"exit_code_violations": 1, "incomplete_texts": ["generated an exception"]}
    SKY = {"exit_code_violations": None}

    def verdict(self, code, report, rule_set, log=""):
        return ka.drc_verdict(code, fixture(report), log, rule_set)

    def test_completed(self):
        self.assertEqual(len(self.verdict(1, "drc-sg13g2-seeded.lyrdb", self.IHP)[0]), 11)
        self.assertEqual(self.verdict(0, "drc-sky130-clean.lyrdb", self.IHP), ([], None))
        self.assertEqual(len(self.verdict(0, "drc-sky130-seeded.lyrdb", self.SKY)[0]), 10)

    def test_exit_code_disagrees(self):
        for code, report, rule_set in ((0, "drc-sg13g2-seeded.lyrdb", self.IHP), (1, "drc-sky130-clean.lyrdb", self.IHP),
                                       (1, "drc-sky130-seeded.lyrdb", self.SKY), (139, "drc-sky130-clean.lyrdb", self.SKY)):
            table, reason = self.verdict(code, report, rule_set)
            self.assertIsNone(table)
            self.assertIn("exit code {} does not agree".format(code), reason)

    def test_report_absent_or_truncated(self):
        self.assertIn("did not write the report", self.verdict(1, "absent.lyrdb", self.IHP)[1])
        self.assertIn("truncated", self.verdict(1, "drc-sg13g2-truncated.lyrdb", self.IHP)[1])
        self.assertIn("did not run", ka.drc_verdict(None, fixture("drc-sky130-clean.lyrdb"), "", self.SKY)[1])

    def test_incomplete_text(self):
        table, reason = self.verdict(0, "drc-sky130-clean.lyrdb", self.IHP, "density generated an exception: x\n")
        self.assertIsNone(table)
        self.assertIn("did not finish", reason)


class LvsVerdict(unittest.TestCase):
    def test_match(self):
        self.assertEqual(ka.lvs_verdict(0, text("lvs-sg13g2-match.log"), True, probe("lvsdb-sg13g2-match.json"), IHP_LVS),
                         ("match", None))

    def test_mismatch(self):
        self.assertEqual(ka.lvs_verdict(0, text("lvs-sg13g2-mismatch.log"), True, probe("lvsdb-sg13g2-mismatch.json"),
                                        IHP_LVS), ("mismatch", None))
        self.assertEqual(ka.lvs_verdict(1, text("lvs-sky130-mismatch.log"), True, probe("lvsdb-sky130-mismatch.json"),
                                        SKY_LVS), ("mismatch", None))

    def test_log_says_match_database_truncated(self):
        # The files that the broken lvs.sh of layout-false-pass leaves: the log has the match, the database is cut.
        verdict, reason = ka.lvs_verdict(0, text("lvs-sg13g2-broken.log"), True, probe("lvsdb-sg13g2-truncated.json"), IHP_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("does not load", reason)

    def test_log_without_database(self):
        verdict, reason = ka.lvs_verdict(0, text("lvs-sg13g2-match.log"), False, None, IHP_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("did not write the LVS database", reason)

    def test_exit_code_of_a_crash(self):
        verdict, reason = ka.lvs_verdict(139, text("lvs-sg13g2-match.log"), True, probe("lvsdb-sg13g2-match.json"), IHP_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("exit code 139", reason)
        verdict, reason = ka.lvs_verdict(0, text("lvs-sky130-mismatch.log"), True, probe("lvsdb-sky130-mismatch.json"), SKY_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("exit code 0 is not a code of a completed run with a mismatch", reason)

    def test_log_and_database_disagree(self):
        verdict, reason = ka.lvs_verdict(0, text("lvs-sg13g2-match.log"), True, probe("lvsdb-sg13g2-mismatch.json"), IHP_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("deck log has the match text", reason)
        verdict, reason = ka.lvs_verdict(0, "no result here\n", True, probe("lvsdb-sg13g2-match.json"), IHP_LVS)
        self.assertEqual(verdict, "not run")
        self.assertIn("does not have the match text", reason)

    def test_no_compare_result(self):
        verdict, reason = ka.lvs_verdict(0, text("lvs-sg13g2-match.log"), True, {"loaded": True, "compared": False}, IHP_LVS)
        self.assertEqual((verdict, reason), ("not run", "the LVS database has no compare result"))


class PinCheck(unittest.TestCase):
    TOP = probe("lvsdb-sg13g2-match.json")["top"]

    def test_right_pins(self):
        # The extracted circuit sorts its pins by name; the order is the order of the reference netlist.
        self.assertNotEqual([p.lower() for p in self.TOP["layout_pins"]], SPEC_PINS)
        self.assertEqual(ka.pin_check(SPEC_PINS, self.TOP)[:2], (0, []))

    def test_missing_pin(self):
        count, messages, _ = ka.pin_check(SPEC_PINS + ["vdd"], self.TOP)
        self.assertEqual(count, 1)
        self.assertIn("pin vdd: it is not a pin of the extracted top circuit idac", messages[0])
        cheat = probe("lvsdb-sky130-mismatch.json")["top"]
        count, messages, _ = ka.pin_check(SPEC_PINS, cheat)
        self.assertEqual(count, 10)
        self.assertTrue(all("not a pin of the extracted top circuit" in m for m in messages))

    def test_wrong_order(self):
        pins = list(SPEC_PINS)
        pins[8], pins[9] = pins[9], pins[8]  # inn before inp
        count, messages, _ = ka.pin_check(pins, self.TOP)
        self.assertEqual(count, 2)
        self.assertIn("pin inn: it is at position 9 of pins, but at position 10 of the reference circuit IDAC", messages[0])


class TechnologyPacks(unittest.TestCase):
    def packs(self):
        out = {}
        for name in ("ihp-sg13", "sky130"):
            with open(os.path.join(TECHNOLOGIES, name, "technology.json")) as f:
                out[name] = json.load(f)
        return out

    def test_klayout_sections(self):
        for name, pack in self.packs().items():
            section = pack.get("klayout")
            self.assertTrue(section, name)
            for pdk, facts in section.items():
                self.assertIn(pdk, pack["pdks"])
                sets = facts["drc"]["rule_sets"]
                self.assertEqual(sum(1 for s in sets.values() if s["default"]), 1, pdk)
                for set_name, rule_set in sets.items():
                    for key in ("command", "report", "description", "exit_code_violations", "default", "source"):
                        self.assertIn(key, rule_set, "{} {}".format(pdk, set_name))
                    self.assertTrue(rule_set["report"].endswith(".lyrdb"))
                    self.assertIn(rule_set["exit_code_violations"], (None, 1))
                    self.check_placeholders(rule_set["command"], ka.COMMAND_PLACEHOLDERS["drc"])
                    self.check_placeholders([rule_set["report"]], ka.PATH_PLACEHOLDERS)
                lvs = facts["lvs"]
                for key in ("command", "report", "extracted", "match_text", "mismatch_text", "exit_codes", "netlist_format",
                            "description", "source"):
                    self.assertIn(key, lvs, pdk)
                self.assertEqual(sorted(lvs["exit_codes"]), ["match", "mismatch"])
                self.assertIn("{netlist}", " ".join(lvs["command"]))
                self.check_placeholders(lvs["command"], ka.COMMAND_PLACEHOLDERS["lvs"])
                self.check_placeholders([lvs["report"], lvs["extracted"]], ka.PATH_PLACEHOLDERS)

    def check_placeholders(self, words, allowed):
        for word in words:
            for name in re.findall(r"\{(\w+)\}", word):
                self.assertIn(name, allowed, word)

    def test_no_binary_path(self):
        for name, pack in self.packs().items():
            self.assertNotIn("/foss/tools", json.dumps(pack["klayout"]), name)


FAKE_KLAYOUT = """#!/usr/bin/env python3
import json, os, shutil, sys
args = sys.argv[1:]
if args == ["-v"]:
    print("KLayout 0.30.12")
    sys.exit(0)
rd = dict(a.split("=", 1) for a in args if "=" in a)
if "lvsdb" in rd:  # the adapter reads the LVS database with lvsdb_probe.py
    shutil.copy(os.environ["FAKE_PROBE"], rd["result"])
    sys.exit(0)
sys.exit(3)
"""

FAKE_DECK = """import os, shutil, sys
report, extracted = sys.argv[1], sys.argv[2]
if os.environ.get("FAKE_REPORT"):
    shutil.copy(os.environ["FAKE_REPORT"], report)
if extracted != "-":
    open(extracted, "w").write(".SUBCKT idac a b\\n.ENDS\\n")
sys.stdout.write(open(os.environ["FAKE_LOG"]).read() if os.environ.get("FAKE_LOG") else "deck log\\n")
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
"""


class EndToEnd(unittest.TestCase):
    """drc and lvs through main(), with a fake KLayout, a fake deck and a fake technology pack."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        bindir = os.path.join(self.tmp, "kl")
        os.makedirs(bindir)
        self.klayout = os.path.join(bindir, "klayout-bin")
        with open(self.klayout, "w") as f:
            f.write(FAKE_KLAYOUT)
        os.chmod(self.klayout, os.stat(self.klayout).st_mode | stat.S_IEXEC)
        pdk_root = os.path.join(self.tmp, "pdks")
        os.makedirs(os.path.join(pdk_root, "fake"))
        deck = os.path.join(pdk_root, "fake", "deck.py")
        with open(deck, "w") as f:
            f.write(FAKE_DECK)
        tech = os.path.join(self.tmp, "tech", "fake")
        os.makedirs(tech)
        with open(os.path.join(tech, "technology.json"), "w") as f:
            json.dump({"schema": "simra.technology/0", "name": "fake", "pdks": ["fakepdk"], "klayout": {"fakepdk": {
                "drc": {"rule_sets": {"main": {
                    "command": [sys.executable, "{pdk_root}/fake/deck.py", "{report}", "-"],
                    "report": "{run_dir}/{cell}.lyrdb", "description": "fake", "exit_code_violations": None,
                    "default": True, "source": "test"}}},
                "lvs": dict(SKY_LVS, command=[sys.executable, "{pdk_root}/fake/deck.py", "{report}", "{extracted}", "{netlist}"],
                            report="{run_dir}/{gds_stem}.lvsdb", extracted="{run_dir}/{gds_stem}_extracted.cir",
                            netlist_format="SPICE", description="fake", source="test")}}}, f)
        self.root = os.path.join(self.tmp, "design")
        os.makedirs(self.root)
        for name in ("block.gds", "block.spice"):
            with open(os.path.join(self.root, name), "w") as f:
                f.write("x\n")
        self.env = {"SIMRA_TECHNOLOGY_DIR": os.path.join(self.tmp, "tech"), "PDK": "fakepdk", "PDK_ROOT": pdk_root,
                    "SIMRA_KLAYOUT": self.klayout, "PATH": os.path.dirname(sys.executable) + os.pathsep + "/usr/bin:/bin"}
        self.saved = dict(os.environ)
        self.addCleanup(self.restore)
        self.count = 0

    def restore(self):
        os.environ.clear()
        os.environ.update(self.saved)

    def run_op(self, operation, inputs, **fake):
        self.count += 1
        exp = os.path.join(self.root, "simra", "experiments", "e{}".format(self.count))
        os.makedirs(os.path.join(exp, "work"))
        os.environ.clear()
        os.environ.update(self.env)
        os.environ.update({k: v for k, v in fake.items()})
        request = {"contract": ka.CONTRACT, "experiment": "e", "adapter": "klayout", "operation": operation,
                   "inputs": inputs, "root": self.root, "work_dir": os.path.join(exp, "work"),
                   "response_path": os.path.join(exp, "response.json")}
        with open(os.path.join(exp, "request.json"), "w") as f:
            json.dump(request, f)
        self.assertEqual(ka.main(["klayout_adapter.py", os.path.join(exp, "request.json")]), 0)
        self.restore()
        with open(request["response_path"]) as f:
            return json.load(f), exp

    def test_drc_seeded(self):
        r, exp = self.run_op("drc", {"gds": "block.gds", "cell": "idac", "max_examples": 1},
                             FAKE_REPORT=fixture("drc-sky130-seeded.lyrdb"))
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["tool"]["version"], "0.30.12")
        self.assertEqual(r["measurements"]["markers"], {"value": 33, "unit": None, "status": "measured",
                                                        "source": "work/drc/idac.lyrdb"})
        self.assertEqual(r["measurements"]["rules_violated"]["value"], 10)
        errors = [d for d in r["diagnostics"] if d["severity"] == "error"]
        self.assertEqual(len(errors), 10)
        self.assertTrue(errors[0]["message"].startswith("m3.6: 8 markers. m3.6 : min. m3 area"))
        self.assertTrue(errors[0]["message"].endswith(" ... 7 more in work/drc.json"), errors[0]["message"])
        self.assertEqual(r["diagnostics"][-1], {"severity": "warning", "source": "adapter", "message": (
            "Full table: simra/experiments/e1/work/drc.json (all markers of each rule, by cell). "
            "Marker database: simra/experiments/e1/work/drc/idac.lyrdb")})
        self.assertEqual([f["role"] for f in r["input_files"]["files"]], ["layout", "deck", "technology"])
        paths = [o["path"] for o in r["outputs"]]
        self.assertIn("simra/experiments/e1/work/drc/idac.lyrdb", paths)
        self.assertIn("simra/experiments/e1/work/drc.log", paths)
        with open(os.path.join(exp, "work", "drc.json")) as f:
            table = json.load(f)
        self.assertEqual(table["markers"], 33)
        self.assertEqual(len(table["rules"][0]["boxes"]), 8)

    def test_drc_default_limit_and_clean(self):
        # With the default max_examples (8), every rule of the seeded block gives all its boxes.
        r, _ = self.run_op("drc", {"gds": "block.gds", "cell": "idac"}, FAKE_REPORT=fixture("drc-sky130-seeded.lyrdb"))
        errors = [d["message"] for d in r["diagnostics"] if d["severity"] == "error"]
        self.assertEqual(len(errors), 10)
        self.assertFalse([m for m in errors if "more in work/drc.json" in m or "Cells:" in m])
        self.assertIn("idac: (", errors[0])
        self.assertTrue(r["diagnostics"][-1]["message"].startswith("Full table: simra/experiments/e1/work/drc.json"))
        # A clean report gives no rule errors and no table line.
        r, _ = self.run_op("drc", {"gds": "block.gds", "cell": "idac"}, FAKE_REPORT=fixture("drc-sky130-clean.lyrdb"))
        self.assertEqual(r["measurements"]["markers"]["value"], 0)
        self.assertEqual([d["severity"] for d in r["diagnostics"]], ["info"])

    def test_drc_not_run(self):
        for fake, reason in (({"FAKE_REPORT": fixture("drc-sg13g2-truncated.lyrdb")}, "truncated"),
                             ({}, "did not write the report"),
                             ({"FAKE_REPORT": fixture("drc-sky130-clean.lyrdb"), "FAKE_EXIT": "139"}, "exit code 139")):
            r, _ = self.run_op("drc", {"gds": "block.gds", "cell": "idac"}, **fake)
            self.assertEqual(r["status"], "failed")
            for key in ("markers", "rules_violated"):
                self.assertEqual((r["measurements"][key]["status"], r["measurements"][key]["value"]), ("failed", None))
            self.assertEqual(r["measurements"]["runtime_s"]["status"], "measured")
            errors = [d for d in r["diagnostics"] if d["severity"] == "error"]
            self.assertEqual(len(errors), 1)
            self.assertTrue(errors[0]["message"].startswith("not run: "), errors[0]["message"])
            self.assertIn(reason, errors[0]["message"])
            self.assertIn("Last lines of the deck log: ", errors[0]["message"])

    def test_lvs_match_with_pin_warning(self):
        pins = list(SPEC_PINS)
        pins[8], pins[9] = pins[9], pins[8]
        r, exp = self.run_op("lvs", {"gds": "block.gds", "cell": "idac", "netlist": "block.spice", "pins": pins},
                             FAKE_REPORT=fixture("lvs-sky130-mismatch.log"), FAKE_LOG=fixture("lvs-sg13g2-match.log"),
                             FAKE_PROBE=fixture("lvsdb-sg13g2-match.json"))
        self.assertEqual(r["status"], "completed")
        m = {k: v["value"] for k, v in r["measurements"].items()}
        self.assertEqual(list(m), ["match", "unmatched_devices", "unmatched_nets", "unmatched_pins", "runtime_s"])
        self.assertEqual((m["match"], m["unmatched_devices"], m["unmatched_nets"], m["unmatched_pins"]), (1, 0, 0, 2))
        self.assertEqual([d["severity"] for d in r["diagnostics"]], ["warning", "warning"])
        paths = [o["path"] for o in r["outputs"]]
        for name in ("lvs/block.lvsdb", "lvs/block_extracted.cir", "lvs.log", "lvs.json"):
            self.assertIn("simra/experiments/e1/work/" + name, paths)
        self.assertEqual([f["role"] for f in r["input_files"]["files"]], ["layout", "netlist", "deck", "technology"])

    def test_lvs_mismatch(self):
        r, exp = self.run_op("lvs", {"gds": "block.gds", "cell": "idac", "netlist": "block.spice"},
                             FAKE_REPORT=fixture("lvs-sky130-mismatch.log"), FAKE_LOG=fixture("lvs-sky130-mismatch.log"),
                             FAKE_EXIT="1", FAKE_PROBE=fixture("lvsdb-sg13g2-mismatch.json"))
        self.assertEqual(r["status"], "completed")
        m = r["measurements"]
        self.assertEqual((m["match"]["value"], m["unmatched_devices"]["value"], m["unmatched_nets"]["value"]), (0, 30, 30))
        self.assertEqual(m["unmatched_pins"]["status"], "missing")
        errors = [d["message"] for d in r["diagnostics"] if d["severity"] == "error"]
        self.assertTrue(errors[0].startswith("the netlists do not match: 1 circuit does not match"))
        self.assertEqual(sum(e.startswith("device ") for e in errors), 10)
        self.assertEqual(sum(e.startswith("net ") for e in errors), 10)
        self.assertEqual(errors[-1], "40 more unmatched items are in work/lvs.json")
        with open(os.path.join(exp, "work", "lvs.json")) as f:
            self.assertEqual(len(json.load(f)["devices"]), 30)

    def test_lvs_printed_match_truncated_database(self):
        r, _ = self.run_op("lvs", {"gds": "block.gds", "cell": "idac", "netlist": "block.spice", "pins": SPEC_PINS},
                           FAKE_REPORT=fixture("lvs-sky130-mismatch.log"), FAKE_LOG=fixture("lvs-sg13g2-broken.log"),
                           FAKE_PROBE=fixture("lvsdb-sg13g2-truncated.json"))
        self.assertEqual(r["status"], "failed")
        for key in ("match", "unmatched_devices", "unmatched_nets", "unmatched_pins"):
            self.assertEqual(r["measurements"][key]["status"], "failed")
        errors = [d["message"] for d in r["diagnostics"] if d["severity"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].startswith("not run: the LVS database does not load in KLayout"))

    def test_lvs_no_database(self):
        r, _ = self.run_op("lvs", {"gds": "block.gds", "cell": "idac", "netlist": "block.spice"},
                           FAKE_LOG=fixture("lvs-sg13g2-match.log"), FAKE_PROBE=fixture("lvsdb-sg13g2-match.json"))
        self.assertEqual(r["status"], "failed")
        self.assertIn("did not write the LVS database", r["diagnostics"][0]["message"])

    def test_klayout_not_found(self):
        self.env["SIMRA_KLAYOUT"] = os.path.join(self.tmp, "absent")
        r, _ = self.run_op("drc", {"gds": "block.gds", "cell": "idac"})
        self.assertEqual(r["status"], "failed")
        self.assertIn("KLayout not found", r["diagnostics"][0]["message"])
        self.assertIn("SIMRA_KLAYOUT", r["diagnostics"][0]["message"])

    def test_klayout_on_path_first(self):
        os.rename(self.klayout, os.path.join(os.path.dirname(self.klayout), "klayout"))
        self.env["PATH"] = os.path.dirname(self.klayout) + os.pathsep + self.env["PATH"]
        self.env.pop("SIMRA_KLAYOUT")
        r, _ = self.run_op("drc", {"gds": "block.gds", "cell": "idac"}, FAKE_REPORT=fixture("drc-sky130-clean.lyrdb"))
        self.assertEqual((r["status"], r["measurements"]["markers"]["value"]), ("completed", 0))

    def test_bad_inputs(self):
        for inputs, text_ in (({"cell": "idac"}, "input 'gds' is required"),
                              ({"gds": "absent.gds", "cell": "idac"}, "file not found"),
                              ({"gds": "block.gds", "cell": "idac", "rule_set": "nope"}, "rule set 'nope'"),
                              ({"gds": "block.gds", "cell": "idac", "technology": "nope"}, "no technology pack 'nope'")):
            r, _ = self.run_op("drc", inputs)
            self.assertEqual(r["status"], "failed")
            self.assertIn(text_, r["diagnostics"][0]["message"])


if __name__ == "__main__":
    unittest.main()
