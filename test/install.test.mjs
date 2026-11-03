// Tests of packages/launcher/install.sh and simra uninstall. They run when SIMRA_BINARY is the path of a built binary;
// otherwise they are reported as skipped. The release folder of that binary becomes three test releases (1.0.0,
// 2.0.0, 3.0.0: only the version in package.json differs), served with their install.sh from 127.0.0.1.
// Each run has its own HOME. The container test runs when SIMRA_TEST_INSTALL_IMAGES lists images (Linux, Docker).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = process.env.SIMRA_BINARY && resolve(process.env.SIMRA_BINARY);
const skip = !binary && "SIMRA_BINARY is not set";
const platform = `${process.platform}-${process.arch}`;
const VERSIONS = ["1.0.0", "2.0.0", "3.0.0"];
/** The environment without the settings of the machine that change what install.sh does. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CI|SIMRA_.*|XDG_.*|ZDOTDIR)$/.test(name)));

function tempDir(t, name) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `simra-install-${name}-`)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** install.sh with the version and the hashes, as the release workflow writes it. */
function bake(version, sums) {
	return readFileSync(join(root, "packages", "launcher", "install.sh"), "utf8").replaceAll("@VERSION@", version).replace("@SHA256SUMS@", sums.trimEnd());
}

/** The releases page in srv/releases: the tarball and install.sh of each version, and latest/ (3.0.0). Made once. */
let shared;
before(async () => {
	if (binary) shared = await makeReleases();
});
after(() => shared?.close());
const releases = async () => shared;

async function makeReleases() {
	const srv = realpathSync(mkdtempSync(join(tmpdir(), "simra-install-srv-")));
	const release = dirname(realpathSync(binary));
	for (const version of VERSIONS) {
		// A folder of links to the release folder, with its own package.json; tar -h packs the files of the links.
		const stage = join(srv, "stage", "simra");
		rmSync(dirname(stage), { recursive: true, force: true });
		mkdirSync(stage, { recursive: true });
		for (const name of readdirSync(release).filter((n) => n !== "package.json")) symlinkSync(join(release, name), join(stage, name));
		writeFileSync(join(stage, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(release, "package.json"), "utf8")), version }));
		const dir = join(srv, "releases", "download", `v${version}`);
		mkdirSync(dir, { recursive: true });
		const tarball = `simra-${platform}.tar.gz`;
		const tar = spawnSync("tar", ["-czhf", join(dir, tarball), "-C", dirname(stage), "simra"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		assert.equal(tar.status, 0, String(tar.stderr));
		const sha = createHash("sha256").update(readFileSync(join(dir, tarball))).digest("hex");
		writeFileSync(join(dir, "install.sh"), bake(version, `${sha}  ${tarball}\n`));
	}
	rmSync(join(srv, "stage"), { recursive: true, force: true });
	mkdirSync(join(srv, "releases", "latest", "download"), { recursive: true });
	writeFileSync(join(srv, "releases", "latest", "download", "install.sh"), readFileSync(join(srv, "releases", "download", "v3.0.0", "install.sh")));
	const requests = [];
	const server = createServer(serve(srv, requests));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}`;
	const close = () => {
		server.close();
		rmSync(srv, { recursive: true, force: true });
	};
	return { srv, url, requests, close, script: (version) => join(srv, "releases", "download", `v${version}`, "install.sh") };
}

/** A handler that answers with the files in srv. */
function serve(srv, requests) {
	return (req, res) => {
		requests.push(req.url);
		const file = join(srv, decodeURIComponent(req.url));
		if (!file.startsWith(srv) || !existsSync(file)) return res.writeHead(404).end();
		res.end(readFileSync(file));
	};
}

/** Run a command without a terminal and without blocking the event loop (the release server runs in this process). */
async function run(command, args, env, cwd) {
	const child = spawn(command, args, { cwd, env: { ...cleanEnv, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	const status = await new Promise((r) => child.on("exit", r));
	return { status, stdout, stderr };
}

/** A user's HOME and the environment of install.sh for it. */
function user(t, url) {
	const home = tempDir(t, "home");
	return { home, env: { HOME: home, SHELL: "/bin/bash", SIMRA_RELEASES_URL: `${url}/releases` } };
}

/** All files and links under dir, relative to it (folders are not listed). */
function files(dir, prefix = "") {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
	);
}

test("install.sh installs simra, links it, writes the receipt, and changes nothing else", { skip, timeout: 180_000 }, async (t) => {
	const { url } = await releases();
	const { home, env } = user(t, url);
	const install = await run("sh", ["-c", `curl -fsSL ${url}/releases/latest/download/install.sh | sh`], env);
	assert.equal(install.status, 0, install.stderr);
	// Without a terminal, it prints the PATH line and does not change a profile.
	assert.match(install.stderr, new RegExp(`add ${home}/\\.local/bin to the PATH[^\\n]*export PATH="${home}/\\.local/bin:\\$PATH"`));
	const simraHome = join(home, ".local", "share", "simra");
	assert.equal(readlinkSync(join(simraHome, "current")), "releases/3.0.0");
	assert.equal(readlinkSync(join(home, ".local", "bin", "simra")), join(simraHome, "current", "simra"));
	const version = await run(join(home, ".local", "bin", "simra"), ["--version"], env);
	assert.equal(version.stdout.trim(), "3.0.0");
	const receipt = JSON.parse(readFileSync(join(simraHome, "receipt.json"), "utf8"));
	assert.deepEqual([receipt.version, receipt.platform], ["3.0.0", platform]);
	const changed = files(home).filter((f) => !f.startsWith(".local/share/simra/") && !f.startsWith(".config/simra/"));
	assert.deepEqual(changed, [".local/bin/simra"]);
});

test("an update keeps the previous release, the next one removes the oldest, a rerun downloads nothing", { skip, timeout: 300_000 }, async (t) => {
	const { url, requests, script } = await releases();
	const { home, env } = user(t, url);
	const simraHome = join(home, ".local", "share", "simra");
	const releasesOf = () => readdirSync(join(simraHome, "releases")).sort();
	for (const [version, kept] of [["1.0.0", ["1.0.0"]], ["2.0.0", ["1.0.0", "2.0.0"]], ["3.0.0", ["2.0.0", "3.0.0"]]]) {
		const install = await run("sh", [script(version)], env);
		assert.equal(install.status, 0, install.stderr);
		assert.equal((await run(join(home, ".local", "bin", "simra"), ["--version"], env)).stdout.trim(), version);
		assert.deepEqual(releasesOf(), kept);
	}
	const downloads = requests.filter((r) => r.endsWith(".tar.gz")).length;
	const again = await run("sh", [script("3.0.0")], env);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stderr, /simra 3\.0\.0 is in .* already/);
	assert.equal(requests.filter((r) => r.endsWith(".tar.gz")).length, downloads);
	assert.deepEqual(releasesOf(), ["2.0.0", "3.0.0"]);
	// SIMRA_VERSION runs the installer of that release. SIMRA_HOME puts it elsewhere.
	const scratch = join(tempDir(t, "scratch"), "simra");
	const pinned = await run("sh", [script("3.0.0")], { ...env, SIMRA_VERSION: "v1.0.0", SIMRA_HOME: scratch });
	assert.equal(pinned.status, 0, pinned.stderr);
	assert.equal(readlinkSync(join(scratch, "current")), "releases/1.0.0");
	assert.ok(requests.includes("/releases/download/v1.0.0/install.sh"));
	// simra update installs into the SIMRA_HOME of the running simra.
	const update = await run(join(scratch, "current", "simra"), ["update"], env);
	assert.equal(update.status, 0, update.stderr);
	assert.equal(readlinkSync(join(scratch, "current")), "releases/3.0.0");
	assert.equal(readlinkSync(join(home, ".local", "bin", "simra")), join(scratch, "current", "simra"));
	// A relative SIMRA_HOME is relative to the current folder; the link is absolute.
	const relative = await run("sh", [script("1.0.0")], { ...env, SIMRA_HOME: "rel/simra" }, home);
	assert.equal(relative.status, 0, relative.stderr);
	assert.equal(readlinkSync(join(home, ".local", "bin", "simra")), join(home, "rel", "simra", "current", "simra"));
	assert.equal((await run(join(home, ".local", "bin", "simra"), ["--version"], env)).stdout.trim(), "1.0.0");
});

test("a wrong hash installs nothing", { skip, timeout: 120_000 }, async (t) => {
	const { srv, url } = await releases();
	const { home, env } = user(t, url);
	const bad = join(srv, "bad.sh");
	writeFileSync(bad, bake("1.0.0", `${"0".repeat(64)}  simra-${platform}.tar.gz\n`));
	const install = await run("sh", [bad], env);
	assert.equal(install.status, 1);
	assert.match(install.stderr, /has the wrong SHA-256 hash\. Nothing was installed\./);
	assert.deepEqual(readdirSync(join(home, ".local", "share", "simra", "releases")), []);
	assert.ok(!existsSync(join(home, ".local", "bin", "simra")));
});

test("install.sh stops for root, musl, macOS 12, another system or CPU", { skip, timeout: 60_000 }, async (t) => {
	const { url, script } = await releases();
	const { env } = user(t, url);
	const cases = [
		[{ id: "echo 0" }, /do not install as root/],
		[{ uname: 'case $1 in -s) echo Linux;; *) echo x86_64;; esac', ldd: "echo 'musl libc (x86_64)' >&2; exit 1" }, /musl libc/],
		[{ uname: 'case $1 in -s) echo Darwin;; *) echo arm64;; esac', sw_vers: "echo 12.7.6" }, /macOS 12\.7\.6 is too old/],
		[{ uname: 'case $1 in -s) echo FreeBSD;; *) echo amd64;; esac' }, /FreeBSD is not supported/],
		[{ uname: 'case $1 in -s) echo Linux;; *) echo riscv64;; esac', ldd: "echo 'ldd (GNU libc) 2.39'" }, /the CPU riscv64 is not supported/],
	];
	for (const [shims, message] of cases) {
		const bin = tempDir(t, "shims");
		for (const [name, body] of Object.entries(shims)) {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		}
		const install = await run("sh", [script("1.0.0")], { ...env, PATH: `${bin}:${process.env.PATH}` });
		assert.equal(install.status, 1, install.stderr);
		assert.match(install.stderr, message);
	}
});

test("with a terminal, install.sh asks and adds the PATH block once; simra uninstall removes it and keeps the settings", { skip: skip || (spawnSync("python3", ["--version"]).status !== 0 && "python3 not on PATH"), timeout: 180_000 }, async (t) => {
	const { url, script } = await releases();
	const { home, env } = user(t, url);
	// A profile without a newline at the end.
	writeFileSync(join(home, ".bashrc"), "export BEFORE=1");
	const terminal = await run("python3", ["-I", join(root, "test", "fixtures", "terminal.py"), JSON.stringify([["[Y/n]", "y\r"], ["Run simra to start", ""]]), "/bin/sh", script("3.0.0")], env);
	assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr);
	const bashrc = readFileSync(join(home, ".bashrc"), "utf8");
	assert.equal(bashrc, `export BEFORE=1\n# >>> simra >>>\nexport PATH="${home}/.local/bin:$PATH"\n# <<< simra <<<\n`);
	const again = await run("sh", [script("3.0.0")], env);
	assert.match(again.stderr, /adds .* to the PATH already/);
	assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), bashrc);
	writeFileSync(join(home, ".bashrc"), `${bashrc}export AFTER=2\n`);
	mkdirSync(join(home, ".config", "simra"), { recursive: true });
	writeFileSync(join(home, ".config", "simra", "auth.json"), "{}");
	const uninstall = await run(join(home, ".local", "bin", "simra"), ["uninstall"], env);
	assert.equal(uninstall.status, 0, uninstall.stderr);
	assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), "export BEFORE=1\nexport AFTER=2\n");
	assert.ok(!existsSync(join(home, ".local", "bin", "simra")));
	assert.ok(!existsSync(join(home, ".local", "share", "simra")));
	assert.ok(existsSync(join(home, ".config", "simra", "auth.json")));
	// A link to an installation that is gone does not stop simra uninstall, and goes too.
	assert.equal((await run("sh", [script("3.0.0")], env)).status, 0);
	rmSync(join(home, ".local", "bin", "simra"));
	symlinkSync(join(home, "gone", "current", "simra"), join(home, ".local", "bin", "simra"));
	const dangling = await run(join(home, ".local", "share", "simra", "current", "simra"), ["uninstall"], env);
	assert.equal(dangling.status, 0, dangling.stderr);
	assert.ok(!existsSync(join(home, ".local", "share", "simra")));
	assert.throws(() => readlinkSync(join(home, ".local", "bin", "simra")));
});

const images = process.env.SIMRA_TEST_INSTALL_IMAGES?.split(",").filter(Boolean) ?? [];
test("install.sh in clean containers", { skip: skip || (images.length === 0 && "SIMRA_TEST_INSTALL_IMAGES is not set"), timeout: 900_000 }, async (t) => {
	const { srv, url } = await releases();
	// The images have no Node.js. The installer needs curl or wget, tar and gzip, and a user who is not root.
	const prepare = "if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq curl >/dev/null; " +
		"else command -v tar >/dev/null && command -v useradd >/dev/null || dnf install -y -q tar gzip shadow-utils; fi";
	const install = `curl -fsSL ${url}/releases/latest/download/install.sh | SIMRA_RELEASES_URL=${url}/releases sh && ~/.local/bin/simra --version && ~/.local/bin/simra list`;
	for (const image of images) {
		const result = await run("docker", ["run", "--rm", "--network", "host", "-v", `${srv}:/srv:ro`, image, "sh", "-c", `${prepare} && useradd -m simra && su simra -c 'cd && ${install}'`], {});
		assert.equal(result.status, 0, `${image}: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /^3\.0\.0$/m, image);
	}
});
