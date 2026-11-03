// The environment of the simra binary. main.ts imports this module before pi's modules, because pi's config module
// reads these variables when it loads.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// pi reads package.json (name, version, piConfig), the themes and the docs from this folder. The real path, so that a
// link to the binary (for example ~/.local/bin/simra) finds them.
process.env.PI_PACKAGE_DIR = dirname(realpathSync(process.execPath));
// Settings, logins and sessions. pi takes the name of this variable from piConfig.name.
process.env.SIMRA_CODING_AGENT_DIR ||= join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "simra");
// Updates come from simra update, not from pi.dev. No install telemetry to pi.dev.
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
