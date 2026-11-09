// Build the simra binary and its release folder (pi's binary release layout) for this machine. Needs Bun ($BUN or PATH).
//   node packages/launcher/build.ts [--out <dir>]

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
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
// The workers are entries too, so that Bun embeds them (see src/). The other flags: as pi's binary, faster start
// (bytecode), and the system's certificate authorities (a company CA).
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
		"--compile-exec-argv=--use-system-ca",
		"--define", `SIMRA_POSTHOG_PROJECT_TOKEN=${JSON.stringify(process.env.POSTHOG_PROJECT_TOKEN || "")}`,
		"--define", `SIMRA_POSTHOG_HOST=${JSON.stringify(process.env.POSTHOG_HOST || "")}`,
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
for (const file of ["template.html", "template.css", "template.js", "vendor"]) copy(join(pi, "dist/core/export-html", file), join("export-html", file));
// pi's docs link to its examples. pi's CHANGELOG.md stays out: pi would show its entries as news of a simra release.
copy(join(pi, "docs"), "docs");
copy(join(pi, "examples"), "examples");
copyFileSync(join(root, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(out, "photon_rs_bg.wasm"));
const os = process.platform;
copy(join(root, "node_modules/@earendil-works/pi-tui/native", os, "prebuilds", platform), join("native", os, "prebuilds", platform));
// The adapters without their tests.
copy(join(root, "adapters"), "adapters", (src) => !/\/(test_[^/]*\.py|fixtures|__pycache__)$/.test(src));
copy(join(root, "technologies"), "technologies");
for (const file of ["LICENSE", "NOTICE"]) copyFileSync(join(root, file), join(out, file));
console.log(`built ${join(out, "simra")}`);
