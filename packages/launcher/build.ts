// Build the simra binary and its release folder for this machine:
//
//   node packages/launcher/build.ts [--out <dir>]
//
// The folder (default dist/simra-<os>-<cpu>) has the layout of pi's binary release: the binary simra, a package.json
// (name, version, piConfig), pi's theme, assets, export-html, docs, Photon WebAssembly and clipboard helpers, and
// Simra's adapters/ and technologies/. The version is the version of the root package.json.
// It needs Bun: $BUN, else bun on the PATH.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent");
const platform = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(platform)) throw new Error(`simra has no build for ${platform}`);
const outIndex = process.argv.indexOf("--out");
const out = resolve(outIndex === -1 ? join(root, "dist", `simra-${platform}`) : process.argv[outIndex + 1]);
const bun = process.env.BUN || "bun";
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
console.log(`bun ${execFileSync(bun, ["--version"], { encoding: "utf8" }).trim()}: simra ${version} for ${platform} in ${out}`);
// The workers are entries too, so that Bun embeds them (see src/). The binary does not read bunfig.toml or .env files of
// the current folder (as pi's binary). Bytecode makes the start 4 to 10 times faster and the binary about 20 % larger.
const launcher = join(root, "packages/launcher");
execFileSync(
	bun,
	[
		"build",
		"--compile",
		"--bytecode",
		"--format=esm",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		join(launcher, "main.ts"),
		join(launcher, "src/utils/image-resize-worker.ts"),
		join(launcher, "src/extensions/codemode/worker.ts"),
		"--outfile",
		join(out, "simra"),
	],
	{ stdio: "inherit" },
);

const piConfig = { name: "simra", configDir: ".simra" };
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "simra", version, license: "Apache-2.0", piConfig }, null, 2)}\n`);
const copy = (from: string, to: string, filter?: (src: string) => boolean) => cpSync(from, join(out, to), { recursive: true, filter });
copy(join(pi, "dist/modes/interactive/theme"), "theme", (src) => !/\.(js|ts|map)$/.test(src));
copy(join(pi, "dist/modes/interactive/assets"), "assets");
copy(join(pi, "dist/core/export-html"), "export-html");
copy(join(pi, "docs"), "docs");
copyFileSync(join(root, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(out, "photon_rs_bg.wasm"));
const os = process.platform;
copy(join(root, "node_modules/@earendil-works/pi-tui/native", os, "prebuilds", platform), join("native", os, "prebuilds", platform));
// The adapters without their tests.
copy(join(root, "adapters"), "adapters", (src) => !/\/(test_[^/]*\.py|fixtures|__pycache__)$/.test(src));
copy(join(root, "technologies"), "technologies");
for (const file of ["LICENSE", "NOTICE"]) copyFileSync(join(root, file), join(out, file));
console.log(`built ${join(out, "simra")}`);
