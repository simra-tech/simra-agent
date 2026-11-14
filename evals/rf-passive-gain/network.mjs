// The closed-form circuits of the rf-passive-gain task. They give the Touchstone file of the task (generate.mjs) and
// the independent cross-check of the reference (reference.mjs). No simulator is used here.
//
// Matching network (2-port, z0 = 50 ohm): shunt C1 at port 1, series R + L, shunt C2 at port 2.
// Amplifier (amp.cir): input port with rin 50 ohm and cgs; a transconductance gm from the input to the drain node d
// with rds and cds; a feedback capacitance cgd from the input to d. The network connects d to the output port.

export const NETWORK = { c1: 0.1e-12, r: 2, l: 1.38e-9, c2: 0.02e-12 };
export const AMP = { rin: 50, cgs: 0.05e-12, cgd: 0.01e-12, gm: 0.12, rds: 200, cds: 0.04e-12 };
export const Z0 = 50;
export const F0 = 10e9;
/** The data grid of match.s2p: 0 to 30 GHz in steps of 0.25 GHz (121 points, with a DC point). */
export const FREQS = Array.from({ length: 121 }, (_, k) => k * 0.25e9);

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => {
	const d = b[0] * b[0] + b[1] * b[1];
	return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const neg = (a) => [-a[0], -a[1]];
const sc = (k, a) => [k * a[0], k * a[1]];

/** Y-parameters of the network at f (Hz): [[y11, y12], [y21, y22]] as complex [re, im]. */
export function networkY(f, n = NETWORK) {
	const w = 2 * Math.PI * f;
	const ys = div([1, 0], [n.r, w * n.l]);
	return [[add([0, w * n.c1], ys), neg(ys)], [neg(ys), add([0, w * n.c2], ys)]];
}

/** S-parameters of the network at f: [[s11, s12], [s21, s22]]. */
export function networkS(f, n = NETWORK) {
	const [[a, b], [c, d]] = networkY(f, n).map((row) => row.map((y) => sc(Z0, y)));
	const one = [1, 0];
	const delta = sub(mul(add(one, a), add(one, d)), mul(b, c));
	return [
		[div(add(mul(sub(one, a), add(one, d)), mul(b, c)), delta), div(sc(-2, b), delta)],
		[div(sc(-2, c), delta), div(add(mul(add(one, a), sub(one, d)), mul(b, c)), delta)],
	];
}

function solve(a, b) {
	const n = a.length;
	const m = a.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.hypot(...m[r][c]) > Math.hypot(...m[p][c])) p = r;
		[m[c], m[p]] = [m[p], m[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = div(m[r][c], m[c][c]);
			m[r] = m[r].map((x, j) => sub(x, mul(k, m[c][j])));
		}
	}
	return m.map((row, i) => div(row[n], row[i]));
}

/**
 * S21 of the amplifier at f, by nodal analysis. Port 1 is a 2 V source behind 50 ohm at node in; port 2 is 50 ohm
 * at node out. Then S21 = V(out). network: true (the network between d and out), false (d is the output: the trap
 * "without the network"), or the Y-parameters of another network as a function of f.
 */
export function ampS21(f, network = true, amp = AMP) {
	const w = 2 * Math.PI * f;
	const jw = (c) => [0, w * c];
	const gin = add(add([1 / Z0 + 1 / amp.rin, 0], jw(amp.cgs)), jw(amp.cgd));
	const gd = add(add([1 / amp.rds, 0], jw(amp.cds)), jw(amp.cgd));
	if (network === false) {
		const a = [[gin, neg(jw(amp.cgd))], [sub([amp.gm, 0], jw(amp.cgd)), add(gd, [1 / Z0, 0])]];
		return solve(a, [[2 / Z0, 0], [0, 0]])[1];
	}
	const y = typeof network === "function" ? network(f) : networkY(f);
	const a = [
		[gin, neg(jw(amp.cgd)), [0, 0]],
		[sub([amp.gm, 0], jw(amp.cgd)), add(gd, y[0][0]), y[0][1]],
		[[0, 0], y[1][0], add(y[1][1], [1 / Z0, 0])],
	];
	return solve(a, [[2 / Z0, 0], [0, 0], [0, 0]])[2];
}

export const db = (s) => 20 * Math.log10(Math.hypot(s[0], s[1]));

/** The text of match.s2p: version 1, Hz, RI, 50 ohm; 2-port order S11 S21 S12 S22. */
export function touchstoneText() {
	const lines = [
		"! matching network, 2-port",
		"# Hz S RI R 50",
	];
	for (const f of FREQS) {
		const s = networkS(f);
		const pairs = [s[0][0], s[1][0], s[0][1], s[1][1]].map(([re, im]) => `${re.toExponential(12)} ${im.toExponential(12)}`);
		lines.push(`${f.toExponential(6)} ${pairs.join(" ")}`);
	}
	return `${lines.join("\n")}\n`;
}
