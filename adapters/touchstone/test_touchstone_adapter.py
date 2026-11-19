"""Unit tests for the touchstone adapter. They need numpy, not a simulator: a small AC nodal solver in this file
simulates the written subcircuit. The data are synthetic lumped networks with closed-form S-parameters."""

import json
import math
import os
import shutil
import tempfile
import unittest

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

if np is not None:
    import rational
    import touchstone_adapter as adapter


def s_from_y(y, z0):
    """S from Y (K, n, n) with real reference impedances: S = (I - G Y G)(I + G Y G)^-1, G = diag(sqrt(z0))."""
    g = np.diag(np.sqrt(z0))
    eye = np.eye(len(z0))
    return np.array([(eye - g @ yk @ g) @ np.linalg.inv(eye + g @ yk @ g) for yk in y])


def lowpass_2port(f):
    """Pi network: shunt C 0.4 pF, series R 0.5 ohm + L 1 nH, shunt C 0.4 pF (Y-parameters in closed form)."""
    w = 2 * np.pi * f
    ys = 1.0 / (0.5 + 1j * w * 1e-9)
    yc = 1j * w * 0.4e-12 + 1e-4
    y = np.zeros((len(f), 2, 2), dtype=complex)
    y[:, 0, 0] = y[:, 1, 1] = ys + yc
    y[:, 0, 1] = y[:, 1, 0] = -ys
    return s_from_y(y, np.array([50.0, 50.0]))


def star_3port(f, z0=(50.0, 50.0, 50.0)):
    """Three branches R_k + L_k to a centre node with a shunt C (0.2 pF) and a shunt R (2 kohm) to ground."""
    w = 2 * np.pi * f
    r, l = [2.0, 5.0, 10.0], [0.5e-9, 1e-9, 2e-9]
    yb = np.array([1.0 / (r[k] + 1j * w * l[k]) for k in range(3)]).T
    yc = 1j * w * 0.2e-12 + 1 / 2000.0 + yb.sum(axis=1)
    y = np.zeros((len(f), 3, 3), dtype=complex)
    for i in range(3):
        for j in range(3):
            y[:, i, j] = (yb[:, i] if i == j else 0) - yb[:, i] * yb[:, j] / yc
    return s_from_y(y, np.array(z0))


def ac_solve(lib_text, name, n, z0, f, driven):
    """Node voltages n1..nN of the subcircuit with a 2 V AC source behind Z0 at port `driven` and Z0 at every port.
    Elements: R, C, V (0 V sensors), G (VCCS), F (CCCS)."""
    lines = [l.split() for l in lib_text.splitlines() if l and not l.startswith("*") and not l.startswith(".")]
    nodes = {"0": -1}

    def node(x):
        if x not in nodes:
            nodes[x] = len(nodes) - 1
        return nodes[x]

    port = {"p%d" % (k + 1): "n%d" % (k + 1) for k in range(n)}
    port.update({"p%d_ref" % (k + 1): "0" for k in range(n)})
    elems = [[e[0]] + [port.get(t, t) for t in e[1:]] for e in lines]
    for e in elems:
        for t in e[1:3]:
            node(t)
        if e[0][0] == "g":
            node(e[3]), node(e[4])
    for k in range(n):
        node("n%d" % (k + 1))
    vs = [e for e in elems if e[0][0] == "v"]
    vidx = {e[0]: k for k, e in enumerate(vs)}
    nn = len(nodes) - 1
    out = np.zeros((len(f), n), dtype=complex)
    for q, fk in enumerate(f):
        w = 2 * math.pi * fk
        a = np.zeros((nn + len(vs), nn + len(vs)), dtype=complex)
        b = np.zeros(nn + len(vs), dtype=complex)

        def stamp(i, j, val):
            if i >= 0 and j >= 0:
                a[i, j] += val

        def admit(p, m, y):
            stamp(p, p, y), stamp(m, m, y), stamp(p, m, -y), stamp(m, p, -y)
        for k in range(n):
            pk = nodes["n%d" % (k + 1)]
            admit(pk, -1, 1.0 / z0[k])
            if k == driven:
                b[pk] += 2.0 / z0[k]
        for e in elems:
            p, m = nodes[e[1]], nodes[e[2]]
            kind = e[0][0]
            if kind == "r":
                admit(p, m, 1.0 / float(e[3]))
            elif kind == "c":
                admit(p, m, 1j * w * float(e[3]))
            elif kind == "g":
                cp, cm, g = nodes[e[3]], nodes[e[4]], float(e[5])
                for row, sgn in ((p, 1), (m, -1)):
                    stamp(row, cp, sgn * g), stamp(row, cm, -sgn * g)
            elif kind == "f":
                col = nn + vidx[e[3]]
                stamp(p, col, float(e[4])), stamp(m, col, -float(e[4]))
            elif kind == "v":
                col = nn + vidx[e[0]]
                stamp(p, col, 1), stamp(m, col, -1), stamp(col, p, 1), stamp(col, m, -1)
        x = np.linalg.solve(a, b)
        out[q] = [x[nodes["n%d" % (k + 1)]] for k in range(n)]
    return out


def run(inputs, files):
    """Run fit_to_spice in a temporary design root with the given files ({name: text}). Returns (response, root)."""
    root = tempfile.mkdtemp(prefix="simra-ts-")
    work = os.path.join(root, "work")
    os.mkdir(work)
    for name, text in files.items():
        with open(os.path.join(root, name), "w") as fh:
            fh.write(text)
    request = {"contract": adapter.CONTRACT, "root": root, "work_dir": work, "inputs": inputs,
               "operation": "fit_to_spice", "response_path": os.path.join(root, "response.json")}
    return adapter.fit_to_spice(request), root


def touchstone_text(f, s, z0, name="x"):
    path = os.path.join(tempfile.mkdtemp(), name)
    rational.write_touchstone(path, f, s, np.asarray(z0, dtype=float), ["synthetic"])
    with open(path) as fh:
        text = fh.read()
    shutil.rmtree(os.path.dirname(path))
    return text


@unittest.skipIf(np is None, "numpy is not installed")
class TouchstoneTest(unittest.TestCase):
    def test_write_and_read_back_two_and_three_ports(self):
        f = np.linspace(1e8, 2e10, 50)
        for s, z0, ext in ((lowpass_2port(f), [50, 50], "s2p"), (star_3port(f, (50, 75, 25)), [50, 75, 25], "s3p")):
            d = rational.parse_touchstone(touchstone_text(f, s, z0, "a." + ext), "a." + ext)
            self.assertEqual(d["nports"], len(z0))
            self.assertTrue(np.allclose(d["z0"], z0))
            self.assertLess(np.max(np.abs(d["s"] - s)), 1e-11)
        self.assertEqual(d["version"], 2, "different reference impedances need version 2")

    def test_hamiltonian_crossings_match_the_sampled_singular_values(self):
        f = np.linspace(1e8, 2e10, 200)
        model = rational.fit(f, 1.05 * lowpass_2port(f), 8)
        bands = rational.violation_bands(model)
        self.assertTrue(bands, "a scaled lossless-like network is not passive")
        grid = np.linspace(0, 5e10, 20001)
        over = grid[rational.sigma_max(model, grid) > 1]
        lo, hi = bands[0]
        self.assertTrue(np.any((over >= lo) & (over <= hi)))
        covered = np.zeros(len(over), dtype=bool)
        for lo, hi in bands:
            covered |= (over >= lo * (1 - 1e-6)) & (over <= hi * (1 + 1e-6))
        self.assertTrue(np.all(covered), "every sampled violation is inside a band of the Hamiltonian test")

    def test_fit_two_port_and_subcircuit_reproduces_the_data(self):
        f = np.linspace(1e8, 2e10, 200)
        s = lowpass_2port(f)
        resp, root = run({"touchstone": "lp.s2p", "uses": {"f0_hz": 5e9, "harmonics": 4, "dc": False}, "verify": []},
                         {"lp.s2p": touchstone_text(f, s, [50, 50], "lp.s2p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        self.assertLess(m["fit_max_abs_ds"]["value"], 1e-3)
        self.assertGreaterEqual(m["passivity_margin"]["value"], 0)
        self.assertEqual(m["s21_max_abs_ds"]["status"], "measured")
        self.assertEqual(m["verify_xyce_max_abs_ds"]["status"], "missing")
        roles = {o.get("role") for o in resp["outputs"]}
        self.assertTrue({"subckt", "touchstone", "report"} <= roles)
        lib = [o for o in resp["outputs"] if o.get("role") == "subckt"][0]["path"]
        with open(os.path.join(root, lib)) as fh:
            text = fh.read()
        self.assertIn(".subckt lp p1 p1_ref p2 p2_ref", text)
        # noiseless realisation: no resistor (a resistor of the realisation adds non-physical noise)
        self.assertFalse([ln for ln in text.splitlines() if ln[:1].lower() == "r"])
        fs = f[::20]
        for j in range(2):
            v = ac_solve(text, "lp", 2, [50.0, 50.0], fs, j)
            sim = v.copy()
            sim[:, j] -= 1.0
            self.assertLess(np.max(np.abs(sim - s[::20, :, j])), 2e-3)

    def test_fit_three_port_with_different_reference_impedances(self):
        f = np.linspace(0, 2e10, 201)
        z0 = [50.0, 75.0, 25.0]
        s = star_3port(f, z0)
        resp, root = run({"touchstone": "star.s3p", "uses": {"band_hz": [1e9, 2e10]}, "verify": []},
                         {"star.s3p": touchstone_text(f, s, z0, "star.s3p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        self.assertLess(resp["measurements"]["fit_max_abs_ds"]["value"], 1e-3)
        lib = [o for o in resp["outputs"] if o.get("role") == "subckt"][0]["path"]
        with open(os.path.join(root, lib)) as fh:
            text = fh.read()
        fs = f[1::25]
        for j in range(3):
            v = ac_solve(text, "star", 3, z0, fs, j)
            sim = np.array([v[:, k] * math.sqrt(z0[j] / z0[k]) for k in range(3)]).T
            sim[:, j] -= 1.0
            self.assertLess(np.max(np.abs(sim - s[1::25, :, j])), 2e-3)

    def test_refusal_when_the_harmonics_are_outside_the_band(self):
        f = np.linspace(1e8, 2e10, 100)
        resp, root = run({"touchstone": "lp.s2p", "uses": {"f0_hz": 6e9, "harmonics": 5, "dc": False}},
                         {"lp.s2p": touchstone_text(f, lowpass_2port(f), [50, 50], "lp.s2p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "failed")
        msg = resp["diagnostics"][0]["message"]
        self.assertIn("refused", msg)
        self.assertIn("harmonic 4 2.4e+10 Hz", msg)
        self.assertEqual(resp["measurements"]["fit_max_abs_ds"]["status"], "failed")
        self.assertFalse(os.listdir(os.path.join(root, "work")), "a refused model is not written")

    def test_dc_policy(self):
        f = np.linspace(1e8, 2e10, 100)
        files = {"lp.s2p": touchstone_text(f, lowpass_2port(f), [50, 50], "lp.s2p")}
        resp, root = run({"touchstone": "lp.s2p", "uses": {"band_hz": [1e9, 2e9]}}, files)
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "failed")
        self.assertIn("no point at 0 Hz", resp["diagnostics"][0]["message"])
        resp, root = run({"touchstone": "lp.s2p", "uses": {"band_hz": [1e9, 2e9]}, "dc_policy": "model", "verify": []}, files)
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        self.assertTrue(any("DC value of the model" in d["message"] for d in resp["diagnostics"]))
        resp, root = run({"touchstone": "lp.s2p"}, files)
        self.addCleanup(shutil.rmtree, root)
        self.assertIn("input 'uses' is required", resp["diagnostics"][0]["message"])

    def test_enforcement_makes_a_non_passive_fit_passive(self):
        f = np.linspace(1e8, 2e10, 200)
        s = 1.03 * lowpass_2port(f)
        resp, root = run({"touchstone": "hot.s2p", "uses": {"band_hz": [1e8, 2e10], "dc": False}, "verify": [],
                          "limits": {"max_abs_ds": 0.1}},
                         {"hot.s2p": touchstone_text(f, s, [50, 50], "hot.s2p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        self.assertGreaterEqual(m["passivity_margin"]["value"], 0)
        self.assertGreater(m["enforcement_max_abs_ds"]["value"], 0.005)
        with open(os.path.join(root, "work", "fit.json")) as fh:
            rep = json.load(fh)
        self.assertFalse(rep["passivity"]["passive_before"])
        self.assertTrue(rep["passivity"]["enforced"])
        self.assertEqual(rep["passivity"]["hamiltonian_crossings"], [])

    def test_limit_refusal(self):
        f = np.linspace(1e8, 2e10, 100)
        resp, root = run({"touchstone": "lp.s2p", "uses": {"band_hz": [1e9, 2e9], "dc": False}, "order": 2,
                          "limits": {"max_abs_ds": 1e-6}},
                         {"lp.s2p": touchstone_text(f, lowpass_2port(f), [50, 50], "lp.s2p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "failed")
        self.assertIn("above the limit", resp["diagnostics"][0]["message"])
        self.assertEqual(resp["measurements"]["fit_max_abs_ds"]["status"], "measured")


def lossy_pi(f, l=200e-12, c=20e-15, r0=1.0, f0=60e9, skin=True):
    """A pi network: C and 0.2 mS to the reference at each port and a series L with the loss r0 * sqrt(f / f0) (skin effect), or
    with a constant loss r0 (a lumped network, which a rational model fits exactly)."""
    y = np.empty((len(f), 2, 2), dtype=complex)
    for k, fk in enumerate(f):
        w = 2 * math.pi * fk
        ys = 1 / (r0 * (math.sqrt(fk / f0) if skin else 1.0) + 0.05 + 1j * w * l)
        yc = 2e-4 + 1j * w * c
        y[k] = [[ys + yc, -ys], [-ys, ys + yc]]
    return s_from_y(y, [50.0, 50.0])


@unittest.skipIf(np is None, "numpy is not installed")
class BandOfUseChecks(unittest.TestCase):
    F = np.linspace(1e9, 2e11, 200)

    def fit(self, extra, skin=True):
        inputs = {"touchstone": "pi.s2p", "uses": {"band_hz": [5e10, 7e10], "dc": False}, "verify": []}
        inputs.update(extra)
        resp, root = run(inputs, {"pi.s2p": touchstone_text(self.F, lossy_pi(self.F, skin=skin), [50, 50], "pi.s2p")})
        self.addCleanup(shutil.rmtree, root)
        return resp

    def test_port_impedance_is_the_analytic_value(self):
        f = np.array([6e10])
        z = rational.port_impedance(lossy_pi(f), np.array([50.0, 50.0]), [1, 2])[0]
        w = 2 * math.pi * 6e10
        zs = 1.0 + 0.05 + 1j * w * 200e-12
        yc = 2e-4 + 1j * w * 20e-15
        expect = zs * (2 / yc) / (zs + 2 / yc)
        self.assertAlmostEqual(abs(z / expect - 1), 0, places=9)
        # Port 2 shorted: port 1 sees C in parallel with the series branch.
        z1 = rational.port_impedance(lossy_pi(f), np.array([50.0, 50.0]), [1], short=[2])[0]
        self.assertAlmostEqual(abs(z1 / (1 / (1 / zs + yc)) - 1), 0, places=9)

    def test_a_good_fit_passes_the_q_check(self):
        resp = self.fit({"checks": [{"name": "tank_q", "kind": "q", "ports": [1, 2], "band_hz": [5.8e10, 6.2e10], "tol_rel": 0.05},
                                    {"name": "tank_r", "kind": "re_z", "ports": [1, 2], "band_hz": [5.8e10, 6.2e10], "tol_rel": 0.05}]}, skin=False)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        self.assertLessEqual(m["check_tank_q_max_rel_error"]["value"], 0.05)
        self.assertLessEqual(m["check_tank_r_max_rel_error"]["value"], 0.05)
        self.assertTrue(any(line.startswith("check tank_q (Q") and line.endswith("pass") for line in resp["report"]))

    def test_a_fit_inside_the_ds_limit_with_a_wrong_q_is_refused(self):
        # A skin-effect loss with the default limit (max |dS| 0.01): the S-parameters are close, the loss is not.
        loose = {}
        plain = self.fit(dict(loose))
        self.assertEqual(plain["status"], "completed", plain["diagnostics"])
        resp = self.fit(dict(loose, checks=[{"name": "tank_q", "kind": "q", "ports": [1, 2], "band_hz": [5.8e10, 6.2e10], "tol_rel": 0.05}]))
        self.assertEqual(resp["status"], "failed")
        self.assertIn("check 'tank_q'", resp["diagnostics"][0]["message"])
        self.assertIn("does not bound", resp["diagnostics"][0]["message"])
        self.assertGreater(resp["measurements"]["check_tank_q_max_rel_error"]["value"], 0.05)
        self.assertFalse(any(o.get("role") == "subckt" for o in resp["outputs"]))

    def test_check_inputs(self):
        for bad in ([{"name": "a", "kind": "x", "ports": [1], "band_hz": [1e10, 2e10], "tol_rel": 0.1}],
                    [{"name": "a", "kind": "q", "ports": [3], "band_hz": [1e10, 2e10], "tol_rel": 0.1}],
                    [{"name": "a", "kind": "q", "ports": [1], "short": [1], "band_hz": [1e10, 2e10], "tol_rel": 0.1}],
                    [{"name": "a", "kind": "q", "ports": [1], "band_hz": [1e10, 2e10]}]):
            self.assertEqual(self.fit({"checks": bad})["status"], "failed")
        none = self.fit({"checks": [{"name": "a", "kind": "q", "ports": [1, 2], "band_hz": [3e11, 4e11], "tol_rel": 0.1}]})
        self.assertIn("no point", none["diagnostics"][0]["message"])


REFS = os.environ.get("SIMRA_TEST_REFERENCES")
TANK = os.path.join(REFS, "vco-sg13g2", "em", "vco_tank.s5p") if REFS else None


@unittest.skipIf(np is None or not TANK or not os.path.isfile(TANK), "SIMRA_TEST_REFERENCES has no vco-sg13g2/em/vco_tank.s5p")
class TankFitAcceptance(unittest.TestCase):
    """The EM tank of the VCO reference: the fit to 260 GHz meets max |dS| 0.012 and has a wrong Q at 61 GHz; the fit to
    130 GHz has the Q of the data."""
    CHECK = [{"name": "tank_q", "kind": "q", "ports": [1, 2], "short": [5], "band_hz": [5.8e10, 6.4e10], "tol_rel": 0.05}]

    def fit(self, band, limit):
        with open(TANK) as fh:
            text = fh.read()
        resp, root = run({"touchstone": "vco_tank.s5p", "name": "vco_tank", "uses": {"band_hz": [1e9, band], "dc": True}, "fit_band_hz": [0, band],
                          "limits": {"max_abs_ds": limit}, "checks": self.CHECK, "verify": []}, {"vco_tank.s5p": text})
        self.addCleanup(shutil.rmtree, root)
        return resp

    def test_the_260_ghz_fit_is_refused_by_the_q_check(self):
        resp = self.fit(2.6e11, 0.012)
        self.assertEqual(resp["status"], "failed")
        self.assertIn("check 'tank_q'", resp["diagnostics"][0]["message"])

    def test_the_130_ghz_fit_passes(self):
        resp = self.fit(1.3e11, 0.01)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        self.assertLessEqual(resp["measurements"]["check_tank_q_max_rel_error"]["value"], 0.05)


if __name__ == "__main__":
    unittest.main()


def attenuator_text(f, db=6.0):
    """A matched 50 ohm attenuator: S11 = S22 = 0, S21 = S12 = 10^(-db/20)."""
    a = 10 ** (-db / 20)
    s = np.zeros((len(f), 2, 2), dtype=complex)
    s[:, 0, 1] = s[:, 1, 0] = a
    return touchstone_text(f, s, [50, 50], "att.s2p")


@unittest.skipIf(np is None, "numpy is not installed")
class PortNoiseAndBandOfUse(unittest.TestCase):
    def test_wide_noise_band_is_refused(self):
        f = np.linspace(1e9, 2e11, 200)
        resp, root = run({"touchstone": "att.s2p", "uses": {"band_hz": [1e9, 2e11], "noise_band_hz": [9e10, 1.1e11]},
                          "dc_policy": "model", "verify": []}, {"att.s2p": attenuator_text(f)})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "failed")
        self.assertIn("wider than 5 % of f0", resp["diagnostics"][0]["message"])

    def test_error_in_the_band_of_use_and_the_header(self):
        f = np.linspace(1e8, 2e10, 200)
        resp, root = run({"touchstone": "lp.s2p", "uses": {"band_hz": [1e9, 2e9], "dc": False}, "verify": []},
                         {"lp.s2p": touchstone_text(f, lowpass_2port(f), [50, 50], "lp.s2p")})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        self.assertEqual(m["use_max_abs_ds"]["status"], "measured")
        self.assertLessEqual(m["use_max_abs_ds"]["value"], m["fit_max_abs_ds"]["value"] + 1e-12)
        self.assertEqual(m["use_max_abs_db"]["status"], "measured")
        lib = [o for o in resp["outputs"] if o.get("role") == "subckt"][0]["path"]
        with open(os.path.join(root, lib)) as fh:
            text = fh.read()
        self.assertIn("simra-fit: name=lp uses_band_hz=1e+09,2e+09 dc=0 noise_band_hz=none", text)

    @unittest.skipUnless(shutil.which("ngspice"), "ngspice is not installed")
    def test_port_noise_of_an_attenuator(self):
        """A 6 dB matched attenuator between noiseless 50 ohm terminations at T0 has NF = 6.0 dB."""
        f = np.linspace(1e9, 2e11, 200)
        resp, root = run({"touchstone": "att.s2p", "uses": {"band_hz": [1e9, 2e11], "noise_band_hz": [1e11, 1.02e11]},
                          "dc_policy": "model", "name": "att", "verify": ["ngspice"]}, {"att.s2p": attenuator_text(f)})
        self.addCleanup(shutil.rmtree, root)
        self.assertEqual(resp["status"], "completed", resp["diagnostics"])
        m = resp["measurements"]
        self.assertLess(m["noise_verify_max_rel_error"]["value"], 0.02)
        deck = os.path.join(root, "nf.cir")
        with open(deck, "w") as fh:
            fh.write('* NF of the fitted attenuator\n.include "work/att.lib"\n.temp 16.85\nvs vs 0 dc 0 ac 1\nrs vs p1 50 noisy=0\nxa p1 0 p2 0 att\n'
                     'rl p2 0 50 noisy=0\n.control\nnoise v(p2) vs lin 3 100g 102g\nsetplot noise1\n'
                     'let nf = 10*log10(1 + inoise_spectrum^2/(4*1.380649e-23*290*50))\nprint nf\n.endc\n.end\n')
        import subprocess
        out = subprocess.run(["ngspice", "-b", deck], cwd=root, capture_output=True, text=True, timeout=120).stdout
        nf = [float(ln.split()[-1]) for ln in out.splitlines() if ln.strip()[:1].isdigit() and len(ln.split()) == 3]
        self.assertEqual(len(nf), 3, out)
        for v in nf:
            self.assertAlmostEqual(v, 6.0, delta=0.01)
