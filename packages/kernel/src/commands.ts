// The commands of the kernel command line (src/cli.ts). The simra binary sends these to the kernel and every other
// argument to pi, so a command that is not in this list does not exist in the binary. packages/kernel/test/
// commands.test.ts compares the list with the command branches of cli.ts.

export const KERNEL_COMMANDS = ["run", "wait", "jobs", "show", "record", "check", "assumptions", "probe", "snp-diff", "connections", "query", "workarounds", "em", "pdf", "pack", "list", "analytics"] as const;
