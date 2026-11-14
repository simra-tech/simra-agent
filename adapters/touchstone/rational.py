"""Rational models of S-parameter data: Touchstone input and output, vector fitting, passivity test and enforcement,
and a SPICE subcircuit of the model. numpy only. Python 3.6 or later.

Method.
  1. Vector fitting with common poles for all S_ij (Gustavsen and Semlyen 1999; relaxed form, Gustavsen 2006):
     S(s) = D + sum_k R_k / (s - p_k). No s-proportional term. Frequencies are scaled by the largest data frequency.
     Unstable poles are reflected into the left half plane.
  2. Passivity test of the model: the purely imaginary eigenvalues of the Hamiltonian matrix of the state-space model
     are the frequencies where a singular value of S crosses 1 (Boyd et al. 1989; Grivet-Talocia 2004). The model is
     passive when no singular value of D reaches 1 and no singular value of S exceeds 1 between the crossings.
  3. Passivity enforcement by residue perturbation: at sample points inside each band of violation, the excess of each
     singular value above 1 - delta is the wanted change of S; a weighted least-squares fit of the residues gives this
     change and keeps the response at the data points. Repeated until the Hamiltonian test passes.
  4. Subcircuit: one Norton port network per port (Z0 and a current source 2 b / sqrt(Z0)), and one state network per
     pole and port (a capacitor C = 1/|p|, so that every conductance is of order 1). Only R, C, G, F and V elements, so
     ngspice and Xyce read the same text.
"""

import math
import re

import numpy as np

UNITS = {"HZ": 1.0, "KHZ": 1e3, "MHZ": 1e6, "GHZ": 1e9}


# ---------------------------------------------------------------------------------------------------------- Touchstone
def _numbers(text):
    return [float(t) for t in text.split()]


def parse_touchstone(text, name):
    """dict(version, nports, z0 (array), f (array, Hz), s (K, n, n) complex, noise) from Touchstone 1.x or 2.0 text.
    Raises ValueError with a reason for a file that is not valid or not supported."""
    lines = [re.sub(r"!.*$", "", l).strip() for l in text.splitlines()]
    v2 = any(re.match(r"^\[version\]\s*2", l, re.I) for l in lines)
    unit, param, fmt, r = 1e9, "S", "MA", 50.0
    have_options = False
    nports, order21, matrix, reference, expected = 0, True, "FULL", None, None
    if not v2:
        m = re.search(r"\.s(\d+)p$", name, re.I)
        if not m:
            raise ValueError("a version 1 file needs the port count in its name (.sNp): " + name)
        nports = int(m.group(1))
    section = "header" if v2 else "data"
    collecting = False
    data = []
    for line in lines:
        if not line:
            continue
        if line.startswith("#"):
            if not have_options:
                have_options = True
                words = line[1:].upper().split()
                i = 0
                while i < len(words):
                    w = words[i]
                    if w in UNITS:
                        unit = UNITS[w]
                    elif w in ("S", "Y", "Z", "G", "H"):
                        param = w
                    elif w in ("RI", "MA", "DB"):
                        fmt = w
                    elif w == "R":
                        i += 1
                        r = float(words[i])
                    else:
                        raise ValueError("option line: unknown word " + w)
                    i += 1
            continue
        kw = re.match(r"^\[([^\]]+)\]\s*(.*)$", line)
        if kw:
            collecting = False
            key, value = kw.group(1).strip().upper(), kw.group(2).strip()
            if key == "NUMBER OF PORTS":
                nports = int(value)
            elif key == "TWO-PORT DATA ORDER":
                order21 = value.upper() == "21_12"
            elif key == "NUMBER OF FREQUENCIES":
                expected = int(value)
            elif key == "MATRIX FORMAT":
                matrix = value.upper()
            elif key == "REFERENCE":
                reference = _numbers(value)
                collecting = True
            elif key == "MIXED-MODE ORDER":
                raise ValueError("mixed-mode data is not supported")
            elif key == "NETWORK DATA":
                section = "data"
            elif key in ("NOISE DATA", "END"):
                section = "after"
            continue
        if collecting and reference is not None and len(reference) < nports:
            reference.extend(_numbers(line))
            continue
        if section == "data":
            data.extend(_numbers(line))
    if param != "S":
        raise ValueError("parameter %s: only S-parameters are supported" % param)
    if nports < 1:
        raise ValueError("the port count is not known")
    n = nports
    z0 = np.array(reference if reference else [r] * n, dtype=float)
    if len(z0) != n or np.any(z0 <= 0):
        raise ValueError("the reference impedances are not %d positive numbers" % n)
    pairs = n * n if matrix == "FULL" else n * (n + 1) // 2
    per = 1 + 2 * pairs
    f, s, noise = [], [], False
    at = 0
    while at + per <= len(data):
        freq = data[at] * unit
        if f and freq <= f[-1]:
            if not v2 and n == 2:
                noise = True
                break
            raise ValueError("the frequencies do not increase at %g Hz" % freq)
        point = np.zeros((n, n), dtype=complex)
        k = at + 1
        for i in range(n):
            for j in range(n):
                if (matrix == "LOWER" and j > i) or (matrix == "UPPER" and j < i):
                    continue
                a, b = data[k], data[k + 1]
                k += 2
                if fmt == "RI":
                    val = complex(a, b)
                else:
                    mag = a if fmt == "MA" else 10 ** (a / 20.0)
                    val = mag * complex(math.cos(math.radians(b)), math.sin(math.radians(b)))
                rr, cc = (j, i) if (n == 2 and order21 and i != j) else (i, j)
                point[rr, cc] = val
                if matrix != "FULL":
                    point[cc, rr] = val
        f.append(freq)
        s.append(point)
        at += per
    if not noise and at != len(data):
        raise ValueError("the network data has %d numbers after the last full point" % (len(data) - at))
    if not f:
        raise ValueError("the file has no data points")
    if expected is not None and expected != len(f):
        raise ValueError("[Number of Frequencies] is %d, the file has %d points" % (expected, len(f)))
    return {"version": 2 if v2 else 1, "nports": n, "z0": z0, "f": np.array(f), "s": np.array(s), "noise": noise}


def read_touchstone(path):
    with open(path) as fh:
        return parse_touchstone(fh.read(), path)


def write_touchstone(path, f, s, z0, comment):
    """Write S (K, n, n) in RI format. Version 1 when every port has the same reference impedance, else version 2."""
    n = s.shape[1]
    lines = ["! " + c for c in comment]
    same = np.allclose(z0, z0[0])
    if not same:
        lines += ["[Version] 2.0", "# Hz S RI R 50", "[Number of Ports] %d" % n]
        if n == 2:
            lines.append("[Two-Port Data Order] 21_12")
        lines += ["[Number of Frequencies] %d" % len(f), "[Reference] " + " ".join("%.12g" % z for z in z0), "[Network Data]"]
    else:
        lines.append("# Hz S RI R %.12g" % z0[0])
    for k in range(len(f)):
        vals = []
        for i in range(n):
            for j in range(n):
                ii, jj = (j, i) if (n == 2 and i != j) else (i, j)   # 2-port order S11 S21 S12 S22
                vals.append("%.12e %.12e" % (s[k, ii, jj].real, s[k, ii, jj].imag))
        lines.append("%.12e " % f[k] + " ".join(vals))
    if not same:
        lines.append("[End]")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")


# ----------------------------------------------------------------------------------------------------- vector fitting
def _order(poles):
    return int(sum(1 if p.imag == 0 else 2 for p in poles))


def basis(s, poles):
    """Real basis for the poles (one entry per real pole and per complex pair, Im p > 0): 1/(s-p) for a real pole;
    1/(s-p) + 1/(s-p*) and j/(s-p) - j/(s-p*) for a pair. With coefficients (c1, c2), a pair has the residue c1 + j c2."""
    cols = []
    for p in poles:
        a = 1.0 / (s - p)
        if p.imag == 0:
            cols.append(a)
        else:
            b = 1.0 / (s - np.conj(p))
            cols.append(a + b)
            cols.append(1j * a - 1j * b)
    return np.array(cols).T


def state_space(poles):
    """(A, b) of the real state equations of the basis: x' = A x + b u."""
    n = _order(poles)
    a = np.zeros((n, n))
    b = np.zeros(n)
    k = 0
    for p in poles:
        if p.imag == 0:
            a[k, k], b[k] = p.real, 1.0
            k += 1
        else:
            a[k:k + 2, k:k + 2] = [[p.real, p.imag], [-p.imag, p.real]]
            b[k] = 2.0
            k += 2
    return a, b


def _split(eig):
    """Poles from eigenvalues of a real matrix: stable (reflected), real ones and one per complex pair (Im > 0)."""
    eig = np.where(eig.real > 0, -eig.real + 1j * eig.imag, eig)
    tol = 1e-9 * max(1.0, float(np.max(np.abs(eig))))
    real = [complex(e.real, 0.0) for e in eig if abs(e.imag) <= tol]
    cplx = [complex(e) for e in eig if e.imag > tol]
    poles = sorted(real, key=lambda p: abs(p)) + sorted(cplx, key=lambda p: abs(p))
    return np.array([p if p.real != 0 else complex(-1e-6, p.imag) for p in poles])


def _stack(a):
    return np.vstack([a.real, a.imag])


def _lstsq(a, b):
    norms = np.linalg.norm(a, axis=0)
    norms[norms == 0] = 1.0
    x = np.linalg.lstsq(a / norms, b, rcond=None)[0]
    return (x.T / norms).T


def _relocate(s, fdata, poles):
    """One pole relocation step (relaxed vector fitting). fdata: (K, M) responses. Returns the new poles."""
    k, m = fdata.shape
    phi = basis(s, poles)
    n = phi.shape[1]
    phi1 = np.hstack([phi, np.ones((k, 1))])
    rows, rhs = [], []
    for col in range(m):
        a = np.hstack([phi1, -fdata[:, col:col + 1] * phi1])
        r = np.linalg.qr(_stack(a), mode="r")
        rows.append(r[n + 1:2 * (n + 1), n + 1:])
        rhs.append(np.zeros(n + 1))
    scale = np.linalg.norm(fdata) / k
    rows.append(scale * np.real(np.sum(phi1, axis=0))[None, :])
    rhs.append(np.array([scale * k]))
    x = _lstsq(np.vstack(rows), np.concatenate(rhs))
    c, d = x[:n], x[n]
    if abs(d) < 1e-8:
        # Relaxation failed: fix the constant of sigma to 1 (non-relaxed form).
        rows, rhs = [], []
        for col in range(m):
            a = np.hstack([phi1, -fdata[:, col:col + 1] * phi])
            q, r = np.linalg.qr(_stack(a))
            b = q.T @ _stack(fdata[:, col])
            rows.append(r[n + 1:, n + 1:])
            rhs.append(b[n + 1:])
        c = _lstsq(np.vstack(rows), np.concatenate(rhs))
        d = 1.0
    a_mat, b_vec = state_space(poles)
    return _split(np.linalg.eigvals(a_mat - np.outer(b_vec, c) / d))


def _residues(s, fdata, poles, constant=True):
    phi = basis(s, poles)
    a = np.hstack([phi, np.ones((len(s), 1))]) if constant else phi
    x = _lstsq(_stack(a), _stack(fdata))
    n = phi.shape[1]
    return x[:n].T, (x[n] if constant else np.zeros(fdata.shape[1]))


def _initial_poles(order, wmin, wmax):
    pairs = order // 2
    beta = np.linspace(max(wmin, wmax / 100.0), wmax, pairs) if pairs else []
    poles = [complex(-0.01 * b, b) for b in beta]
    if order % 2:
        poles = [complex(-0.5 * wmax, 0.0)] + poles
    return np.array(poles)


class Model(object):
    """S(s) = D + sum over poles, in scaled frequency s / w (w = 2 pi times the largest data frequency)."""

    def __init__(self, nports, poles, c, d, w):
        self.n, self.poles, self.c, self.d, self.w = nports, poles, c, d, w

    @property
    def order(self):
        return _order(self.poles)

    def response(self, f):
        s = 2j * np.pi * np.asarray(f, dtype=float) / self.w
        out = basis(s, self.poles) @ self.c.T + self.d
        return out.reshape(len(s), self.n, self.n)

    def physical(self):
        """(poles in rad/s, residues (M, N) for the basis in rad/s, D)."""
        return self.poles * self.w, self.c * self.w, self.d


def fit(f, s, order, iterations=20):
    """Vector fit of S (K, n, n) at f (Hz) with `order` common poles. Returns a Model."""
    n = s.shape[1]
    w = 2 * np.pi * float(np.max(f))
    sn = 2j * np.pi * f / w
    fdata = s.reshape(len(f), n * n)
    poles = _initial_poles(order, 2 * np.pi * float(np.min(f[f > 0])) / w if np.any(f > 0) else 0.01, 1.0)
    for _ in range(iterations):
        new = _relocate(sn, fdata, poles)
        if _order(new) != order:
            break
        full = lambda ps: np.sort_complex(np.concatenate([ps, np.conj(ps[ps.imag != 0])]))
        done = np.max(np.abs(full(new) - full(poles))) < 1e-10
        poles = new
        if done:
            break
    c, d = _residues(sn, fdata, poles)
    return Model(n, poles, c, d, w)


def errors(s_ref, s_x):
    d = np.abs(s_x - s_ref)
    return {"max": float(d.max()), "rms": float(np.sqrt(np.mean(d ** 2))),
            "entry_max": d.max(axis=0).tolist(), "entry_rms": np.sqrt(np.mean(d ** 2, axis=0)).tolist()}


# -------------------------------------------------------------------------------------------------------- passivity
def _realization(model):
    """Real state-space (A, B, C, D) of the scaled model: one state block per input port."""
    n = model.n
    a1, b1 = state_space(model.poles)
    m = a1.shape[0]
    a = np.kron(np.eye(n), a1)
    b = np.kron(np.eye(n), b1.reshape(m, 1))
    c = np.zeros((n, n * m))
    for i in range(n):
        for j in range(n):
            c[i, j * m:(j + 1) * m] = model.c[i * n + j]
    return a, b, c, model.d.reshape(n, n)


def crossings(model):
    """Scaled frequencies where a singular value of S equals 1 (purely imaginary Hamiltonian eigenvalues), or None
    when a singular value of D is 1 or more (the Hamiltonian does not exist)."""
    a, b, c, d = _realization(model)
    n = model.n
    if np.max(np.linalg.svd(d, compute_uv=False)) >= 1.0:
        return None
    r = d.T @ d - np.eye(n)
    q = d @ d.T - np.eye(n)
    ri, qi = np.linalg.inv(r), np.linalg.inv(q)
    h = np.block([[a - b @ ri @ d.T @ c, -b @ ri @ b.T],
                  [c.T @ qi @ c, -a.T + c.T @ d @ ri @ b.T]])
    ev = np.linalg.eigvals(h)
    # Purely imaginary within a relative tolerance; eigenvalues come in pairs (lambda, -conj(lambda)).
    return sorted(float(e.imag) for e in ev if abs(e.real) <= 1e-6 * abs(e) and e.imag > 0)


def sigma_max(model, f):
    return np.linalg.svd(model.response(f), compute_uv=False).max(axis=1)


def violation_bands(model):
    """[(f_lo, f_hi)] in Hz where the largest singular value exceeds 1, from the Hamiltonian crossings, or None when
    D is not passive."""
    cr = crossings(model)
    if cr is None:
        return None
    fx = [x * model.w / (2 * np.pi) for x in cr]
    edges = [0.0] + fx + [max(fx[-1] * 2 if fx else 0.0, 1e3 * model.w / (2 * np.pi))]
    bands = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        if hi <= lo:
            continue
        mid = np.linspace(lo, hi, 7)[1:-1]
        if np.max(sigma_max(model, mid)) > 1.0:
            bands.append((lo, hi))
    return bands


def check_grid(model, fmax):
    """Frequencies (Hz) for the sampled passivity check: dense to 10 fmax, logarithmic to 1e4 fmax, and the pole
    frequencies."""
    poles_hz = np.abs(model.poles.imag) * model.w / (2 * np.pi)
    grid = np.concatenate([np.linspace(0, 10 * fmax, 4001), np.logspace(np.log10(10 * fmax), np.log10(1e4 * fmax), 400),
                           poles_hz, poles_hz * (1 + 1e-3), poles_hz * (1 - 1e-3)])
    return np.unique(grid[grid >= 0])


def enforce(model, f_data, delta=1e-3, d_delta=5e-5, max_iter=60, data_weight=0.1):
    """Enforce passivity by residue perturbation. Returns (model, iterations, passed, d_clipped).
    D (S at infinite frequency) is clipped to 1 - 2 d_delta first: a shunt capacitor makes S(inf) = -1, a passive
    limit that the Hamiltonian test cannot use. The residues then take up the change at the data points."""
    n = model.n
    d_clipped = False
    dmat = model.d.reshape(n, n)
    u, sv, vh = np.linalg.svd(dmat)
    if np.max(sv) >= 1.0 - d_delta:
        dmat = (u * np.minimum(sv, 1.0 - 2 * d_delta)) @ vh
        d_clipped = True
        # The residues take up the change of D at the data points (the poles stay).
        s_data = 2j * np.pi * f_data / model.w
        resp = model.response(f_data).reshape(len(f_data), n * n)
        c = _lstsq(_stack(basis(s_data, model.poles)), _stack(resp - dmat.reshape(-1))).T
        model = Model(n, model.poles, c, dmat.reshape(-1), model.w)
    s_data = 2j * np.pi * f_data / model.w
    phi_d = basis(s_data, model.poles)
    fmin = float(np.min(f_data[f_data > 0])) if np.any(f_data > 0) else 1.0
    for it in range(max_iter):
        bands = violation_bands(model)
        if bands is not None and not bands:
            return model, it, True, d_clipped
        if bands is None:
            return model, it, False, d_clipped
        fv = []
        for lo, hi in bands:
            pts = np.concatenate([np.linspace(lo, hi, 41), np.geomspace(max(lo, fmin / 10), hi, 41),
                                  f_data[(f_data > lo) & (f_data < hi)]])
            fv.append(pts[(pts > lo) & (pts < hi)])
        fv = np.unique(np.concatenate(fv))
        sm = model.response(fv)
        wanted = np.zeros_like(sm)
        for k in range(len(fv)):
            uu, ss, vv = np.linalg.svd(sm[k])
            excess = np.maximum(ss - (1.0 - delta), 0.0)
            wanted[k] = (uu * excess) @ vv
        keep = wanted.reshape(len(fv), n * n)
        phi_v = basis(2j * np.pi * fv / model.w, model.poles)
        a = np.vstack([phi_v, data_weight * phi_d])
        b = np.vstack([keep, np.zeros((len(f_data), n * n))])
        dc = _lstsq(_stack(a), _stack(b)).T
        model = Model(n, model.poles, model.c - dc, model.d, model.w)
    bands = violation_bands(model)
    return model, max_iter, bands is not None and not bands, d_clipped


# --------------------------------------------------------------------------------------------------------- subcircuit
def subcircuit(model, z0, name, header):
    """SPICE text of the model: pins p1 p1_ref p2 p2_ref ... State nodes are inside the subcircuit, referenced to 0."""
    n = model.n
    poles, res, d = model.physical()
    lines = ["* " + h for h in header]
    lines.append(".subckt %s %s" % (name, " ".join("p%d p%d_ref" % (k + 1, k + 1) for k in range(n))))
    for i in range(n):
        gb = 2.0 / math.sqrt(z0[i])
        lines.append("* port %d: Z0 = %.12g ohm and the current 2 b / sqrt(Z0)" % (i + 1, z0[i]))
        lines.append("vsense%d p%d s%d 0" % (i + 1, i + 1, i + 1))
        lines.append("rport%d s%d p%d_ref %.12g" % (i + 1, i + 1, i + 1, z0[i]))
        for j in range(n):
            ga, fa = 0.5 / math.sqrt(z0[j]), 0.5 * math.sqrt(z0[j])
            dij = d[i * n + j]
            if dij != 0.0:
                lines.append("gd%d_%d p%d_ref s%d p%d p%d_ref %.12g" % (i + 1, j + 1, i + 1, i + 1, j + 1, j + 1, gb * dij * ga))
                lines.append("fd%d_%d p%d_ref s%d vsense%d %.12g" % (i + 1, j + 1, i + 1, i + 1, j + 1, gb * dij * fa))
            k = 0
            for q, p in enumerate(poles):
                if p.imag == 0:
                    lines.append("gr%d_%d_%d p%d_ref s%d x%d_%d 0 %.12g" % (q + 1, i + 1, j + 1, i + 1, i + 1, q + 1, j + 1, gb * res[i * n + j, k]))
                    k += 1
                else:
                    lines.append("gr%d_%d_%d p%d_ref s%d x%d_%d 0 %.12g" % (q + 1, i + 1, j + 1, i + 1, i + 1, q + 1, j + 1, gb * res[i * n + j, k]))
                    lines.append("gi%d_%d_%d p%d_ref s%d y%d_%d 0 %.12g" % (q + 1, i + 1, j + 1, i + 1, i + 1, q + 1, j + 1, gb * res[i * n + j, k + 1]))
                    k += 2
        # The states driven by a_i = V_i / (2 sqrt(Z0)) + I_i sqrt(Z0) / 2:  C x' = C A x + C b a_i, with C = 1/|p|.
        ga, fa = 0.5 / math.sqrt(z0[i]), 0.5 * math.sqrt(z0[i])
        for q, p in enumerate(poles):
            c = 1.0 / abs(p)
            x = "x%d_%d" % (q + 1, i + 1)
            b = 1.0 if p.imag == 0 else 2.0
            lines += ["cx%d_%d %s 0 %.12g" % (q + 1, i + 1, x, c),
                      "rx%d_%d %s 0 %.12g" % (q + 1, i + 1, x, 1.0 / (-p.real * c)),
                      "gx%d_%d 0 %s p%d p%d_ref %.12g" % (q + 1, i + 1, x, i + 1, i + 1, b * c * ga),
                      "fx%d_%d 0 %s vsense%d %.12g" % (q + 1, i + 1, x, i + 1, b * c * fa)]
            if p.imag != 0:
                y = "y%d_%d" % (q + 1, i + 1)
                lines += ["gxy%d_%d 0 %s %s 0 %.12g" % (q + 1, i + 1, x, y, p.imag * c),
                          "cy%d_%d %s 0 %.12g" % (q + 1, i + 1, y, c),
                          "ry%d_%d %s 0 %.12g" % (q + 1, i + 1, y, 1.0 / (-p.real * c)),
                          "gyx%d_%d 0 %s %s 0 %.12g" % (q + 1, i + 1, y, x, -p.imag * c)]
    lines.append(".ends %s" % name)
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------------------------------------- derived quantities
def series_lq(s, f, z0):
    """(L in H, Q) of a 1-port (Z) or of the series element of a 2-port (z11 - z12 - z21 + z22); (None, None) else."""
    n = s.shape[1]
    if n == 1:
        z = z0[0] * (1 + s[:, 0, 0]) / (1 - s[:, 0, 0])
    elif n == 2:
        g = np.diag(np.sqrt(z0))
        eye = np.eye(2)
        zz = np.array([g @ (eye + sk) @ np.linalg.inv(eye - sk) @ g for sk in s])
        z = zz[:, 0, 0] - zz[:, 0, 1] - zz[:, 1, 0] + zz[:, 1, 1]
    else:
        return None, None
    w = 2 * np.pi * f
    return z.imag / w, z.imag / z.real
