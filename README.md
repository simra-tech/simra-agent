# Simra Agent

Simra Agent is an agent harness for chip design. It is built on [pi](https://github.com/earendil-works/pi).

pi runs the agent loop. Simra Agent adds what a chip designer needs and a coding agent does not have:

- long jobs (simulation, extraction, place and route) that continue after the session stops
- evidence: which experiment used which inputs, gave which result, and what that result can claim
- design state and decisions, kept as plain files in the design repository
- domain tools (simulator, layout tool, PDK) through tested adapters

The first targets are analog and mixed-signal design with an open PDK and open-source EDA tools.

## Status

**Stage 1. One capability: recorded simulation runs.**

- The tool `run_experiment` (pi extension) and the command `simra run` (plain CLI) run one simulation through
  an adapter.
- A run can be detached: `run_experiment` with `detached: true` (pi) or `simra run --detach` (CLI) starts the run in
  a supervisor process and returns at once. The tool `wait_experiments` (pi) and the command `simra wait` (CLI)
  wait for one or more runs in one call. The summary of a run gives the runtimes of the earlier runs of the same
  kind.
- Each run writes a record to `simra/experiments/<id>/` in the design root: the request, the environment
  (container image ID, CPU pinning), the git state of the design, the hash of every input file (including the
  PDK model files), the tool version, the measurements, the logs and the hashed outputs.
- The tool `check_requirements` (pi extension) and the command `simra check` (plain CLI) check the design
  against `requirements.json`. They run the experiments that the requirements need and write a verdict to
  `simra/checks/<id>/verdict.json`. Each row of the verdict names the experiment that gave its value.
- The tool `design_record` (pi extension) and the command `simra record` (plain CLI) show, for each file of record
  (for example a layout or a netlist), which checks ran on the current file and which are stale.
- The ngspice adapter has four operations: `simulate`, `operating_point`, `lint` and `check_design`.
- The klayout adapter has five operations: `drc`, `lvs`, `query`, `diff` and `render`. `drc` and `lvs` run the stock
  KLayout decks of the PDK and give typed verdicts. A check that did not complete gives "not run", not a pass. `query`
  answers questions about a layout (layers, cells, shapes, instances, texts, distances) in one recorded run. `diff`
  compares two layouts (a file or a git ref), and optionally the DRC markers of two runs, in one recorded run. `render`
  draws a region or a DRC marker as a picture that the agent sees in the result.
- The touchstone adapter has one operation: `fit_to_spice`. It fits a Touchstone file with a passive rational model and
  writes a SPICE subcircuit that ngspice and Xyce both read. It re-simulates the subcircuit in each simulator and
  gives the error against the data (see [adapters/touchstone](adapters/touchstone/README.md)).
- The xyce adapter has four operations: `parse`, `simulate`, `hb` and `hb_limits`. `parse` reports model gaps of a deck
  and its libraries. `hb` gives the power per harmonic, supply currents, gain and P1dB from harmonic balance (see
  [adapters/xyce](adapters/xyce/README.md)). `hb_limits` checks the operating limits of each HBT under the drive (see
  [Operating-limit gate](#operating-limit-gate)).
- An output file in Touchstone format (role `touchstone`) gets a summary from the kernel: ports, band, DC point,
  passivity and reciprocity. The requirement kinds `s_db` and `mu` read such a file (see
  [Frequency-domain requirements](#frequency-domain-requirements)).
- The tool `run_jobs` (pi) and the command `simra jobs` (CLI) run N experiments on a CPU pool and wait for all of
  them, with a wall-time watchdog per job (see [Run N jobs and wait](#run-n-jobs-and-wait)).
- The command `simra probe` runs one small deck per device class of a technology pack in ngspice and in Xyce, and
  prints the table "class x simulator: simulates / parses / fails / not run" (see [Device-class probe](#device-class-probe)).
- The openems adapter has two operations: `simulate` and `merge`. The command `simra em` gives the S-parameters of a
  layout cell as a Touchstone file: one openEMS job per port, then the merge (see [EM S-parameters](#em-s-parameters)).
- The tool `em_sparameters` (pi) runs `simra em` and lists S at given frequencies. `simra snp-diff` compares two
  Touchstone files per entry in dB, degrees and |dS|.
- The workaround registry (`workarounds/<simulator>/<pdk>.json`) lists the known gaps of ngspice, Xyce and openEMS and the
  stated workaround of each. The agent sees the entries of an adapter with its first result in a session; `simra
  workarounds` and the tool `workarounds` list them (see [Workaround registry](#workaround-registry)).
- A connection table (`simra.connections/0`) holds the pins, supplies, bias needs and control encodings of the blocks of a
  chip. `gates.connections` checks a block interface record against it (see [Connection table](#connection-table)).
- The ngspice operation `assemble_dc` finds the DC point of a large deck (a whole chip of blocks) from the operating
  points of its blocks: a clamp homotopy with seeds, then a free operating point (see [Assemble a DC point](#assemble-a-dc-point)).
- The ngspice operation `oscillator` gives f0, the amplitude, the start-up time and the phase noise (white and flicker) of an oscillator by the impulse
  sensitivity function (see [Oscillator](#oscillator)).
- The ngspice operation `device_budget` gives the RF budget of one device at a bias and frequency: fT, fmax, MAG / MSG,
  the stability factor, NFmin, Rn and the noise-optimum source impedance (see [Device budget](#device-budget)).
- The pi tool `read_output` reads a simulator log (measurement lines, errors, warnings, lines that match a pattern) or a
  table (wrdata, print output, SPICE raw file) by column and range, without a script (see [Read an output](#read-an-output)).
- The pi extension keeps the context of a session short: earlier reasoning is not sent again, and the agent keeps a
  state note with the tool `state_note` (see [Context of a session](#context-of-a-session)).
- Requirements can reduce a sweep table with the bracket rule (kind `sweep`), gate an RF block on mu over a band at
  each corner for each active stage (`gates.stability`), and cite assumption ids (`assumptions`); `simra assumptions`
  lists the rows of an assumption.
- The commands `simra pack init` and `simra pack check` add a PDK to a site: an adapter proposes a technology pack
  from the kit, the user confirms it, and the adapter checks it (see "Add a PDK").
- One example design exists: a two-stage OTA for the open IHP SG13G2 PDK.

## Tools for RF and mixed-signal blocks

What the harness has now, and what a task needs that it does not have yet.

| Kind of block | Tools that exist | Tool that is missing |
| --- | --- | --- |
| LNA, gain stage | `sp` and noise benches (ngspice), stability gate, `device_budget`, operating-limit gate | compression of a hot corner when the Xyce DC point fails |
| Power amplifier | Xyce `hb`, `hb_limits` (cycle means and peak voltages) | the conduction part of the instantaneous base current |
| Oscillator | `oscillator` (f0, amplitude, start-up, ISF phase noise with named sources) | a source list made from the design (resistor and EM-port thermal noise) |
| Frequency multiplier, buffer | Xyce `hb` (driven) | none known |
| Frequency divider | ngspice transient | a division-ratio and input-sensitivity measurement |
| Mixer | Xyce `hb` with two tones (conversion gain, compression) | noise figure of a periodically driven circuit |
| EM passive (line, splitter, hybrid) | `em_sparameters` (openEMS), `fit_to_spice`, fit-band gate | none known |
| Antenna | `em_sparameters` (S11) | far-field gain and pattern |
| Baseband amplifier, filter, regulator | ngspice ac, noise, transient, `monte_carlo` | loop gain at an internal node (a loop-probe operation) |
| Bias reference with trim | ngspice, `monte_carlo` | a trim search per Monte Carlo seed |
| Digital control | none | a digital flow adapter (synthesis, place and route) |
| Whole chip | `assemble_dc` | a whole-chip transient or harmonic-balance check |

## Install

On Linux with glibc (x64 or arm64) or on macOS 13 or later, run as your user (not as root):

```sh
curl -fsSL https://github.com/simra-tech/simra-agent/releases/latest/download/install.sh | sh
```

The installer needs curl or wget, tar, and sha256sum, shasum or openssl. It needs no Node.js and no npm.

1. It downloads the `simra` release for the machine and checks its SHA-256 hash against the hash in the installer.
2. It unpacks the release to `~/.local/share/simra/releases/<version>` and links `~/.local/bin/simra` to it.
3. If `~/.local/bin` is not on the `PATH`, it asks before it adds a marked block to your shell profile (zsh, bash or
   fish). Without a terminal, or with `CI` or `SIMRA_NO_MODIFY_PATH=1`, it prints the line instead.

It changes nothing else. Then run `simra` in a design folder.

- `simra update` installs the latest release. It keeps the previous release.
- `SIMRA_VERSION=<version>` installs that release. `SIMRA_HOME=<dir>` installs to `<dir>`, for example a scratch disk.
- `simra uninstall` removes the releases, the link and the profile block. Settings and logins stay in
  `~/.config/simra`.

The machine also needs the EDA tools that the adapters run (for example ngspice, KLayout and Python 3).

## Development

Requirements: Node.js 22.19 or later, and npm.

1. Clone the repository.
2. Run `npm ci`.
3. Run `npm test`.

The tests need no model, no API key and no network access after `npm ci`. The adapter tests need Python 3.6
or later. The integration test with ngspice runs only if `ngspice` is on the PATH; otherwise it is reported as
skipped. The tests of the klayout operations `query`, `diff` and `render` run only if the KLayout Python module is installed
(`pip install klayout`); otherwise they are reported as skipped. To also test a container image, set
`SIMRA_TEST_IMAGE` to an image with ngspice and Python, and `SIMRA_TEST_ENGINE` to `podman` (the default) or `docker`.

## The simra binary

The `simra` binary has the kernel CLI and pi with the Simra extension in one file, compiled with
[Bun](https://bun.com).

- `simra run`, `check`, `list`, `show`, `wait`, `record` and `pdf` are the commands of the kernel CLI.
- `simra update --extensions` and `simra update --models` update pi packages and model catalogs.
- All other arguments go to pi. `simra` without arguments starts the agent in the terminal.

Settings, logins and sessions are in `~/.config/simra` (`$XDG_CONFIG_HOME/simra`; set `SIMRA_CODING_AGENT_DIR` for
another folder). The settings of a project are in `.simra/` in the project.

The first start in a terminal, without a model login, shows a short welcome. Choose a model (DeepSeek V4.1 Flash:
low cost, reads images; or GPT-6.1 Sol: stronger) and paste its API key. To use another provider or a subscription,
type `/login` in simra. When a provider key is set in the environment (for example `DEEPSEEK_API_KEY`), there is no
welcome.

Once a day, `simra` checks for a newer release and shows `simra <version> is available: run simra update`. It does
not update itself. Set `SIMRA_NO_UPDATE_CHECK=1` to stop the check.

Behind a company proxy, set `HTTPS_PROXY`. `simra` and the installer trust the certificate authorities of the system.

### Build the binary

1. Run `npm ci`.
2. Run `sh packages/launcher/get-bun.sh <dir>`. It downloads the pinned Bun to `<dir>/bun` and checks its hash.
3. Run `BUN=<dir>/bun node packages/launcher/build.ts`. It writes the release folder `dist/simra-<os>-<cpu>/`. The
   binary reads its other files from this folder.
4. Run `SIMRA_BINARY=dist/simra-<os>-<cpu>/simra npm test`. Without `SIMRA_BINARY`, the binary tests are skipped.

## Environment image

`container/Containerfile` adds Node.js 22, pi (from the lockfile) and OpenCode to a pinned
[IIC-OSIC-TOOLS](https://github.com/iic-jku/iic-osic-tools) release, which has the open-source EDA tools and
PDKs. The agent and the tools can then run in one container on any machine with Docker or podman.

1. Pull the base image that `container/Containerfile` names.
2. Run `container/build.sh`. It builds the committed tree (HEAD) and prints the image tag.
3. Run `container/check.sh <tag>`. It prints the tool versions and runs `npm test` in the container.

Set `SIMRA_ENGINE=podman` to use podman instead of Docker.

## Run a simulation

From a plain command line:

1. Write a spec file, for example `run.json`:
   `{"adapter": "ngspice", "operation": "simulate", "purpose": "check the RC filter", "inputs": {"deck": "rc.spice"}}`
2. Run `npx simra run run.json` in the design root. It prints a summary: the records, the input files, the outputs
   (path and size), the measurements, and the errors and warnings.
3. Run `npx simra list` and `npx simra show <id>` to read the records. `simra show` prints the summary; add
   `--json` to print the records.

In pi:

1. Run `npx pi -e ./packages/pi-extension` in the design root.
2. Ask for a simulation. The agent calls `run_experiment` and cites the experiment id.

## Run a long job

A run that takes minutes (for example a DRC or LVS deck of a large layout) can run detached. The run continues in
a supervisor process, also after the tool call or the command ends. Two independent runs (for example DRC and LVS)
can run at the same time.

From a plain command line:

1. Run `npx simra run --detach run.json`. The command prints the experiment id and the status `running`, and
   returns at once.
2. Run `npx simra wait <id> [<id>...]`. The command waits until each run ends, and prints the summary of each run.
   Add `--timeout-s <n>` to stop the wait after `n` seconds (default 3600). A run that did not end is shown as
   `still running`; the run continues. The command exits with 0 only when every run completed.

In pi:

1. The agent calls `run_experiment` with `detached: true`. The tool gives the id and the status `running`.
2. The agent calls `wait_experiments` with the ids. The call blocks until the runs end (or `timeout_s`, default
   3600 s) and gives the same summary as a blocking `run_experiment`, one block per id. The model does not use
   tokens while the call waits.

The prompt rules tell the agent to use these tools for long or independent runs, and not to poll with `sleep`,
`tail` or log reads.

The runner writes `status.json` in the experiment directory: the status (`running`, then the result status), the
start time, and the pid and host of the process that runs the experiment. When the process is gone and there is
no `result.json`, the next wait writes `result.json` with the status `error`. The supervisor stops the adapter
at the timeout of the run (`timeout_s`, default 3600 s). On `SIGTERM`, it stops the adapter and records the run
as `cancelled`.

### Run N jobs and wait

For many independent runs (corners, sweep points, seeds), one call starts them all and waits for all of them:
`run_jobs` (pi) or `simra jobs <jobs.json>` (CLI). `jobs.json` is a list of run specifications, the same as for
`simra run`, or `{"jobs": [...]}`.

1. Give a CPU pool with `cpus` (pi) or `--cpus` (CLI), for example `122-125`. The pool is split into slots of equal
   size, one job per slot at a time; `parallel` sets the number of slots. Each job runs pinned to the CPUs of its slot.
   Without a pool, `parallel` jobs (default 4) run at the same time with the CPUs of their environment.
2. Give each job a watchdog with `timeout_s` (default 3600 s). A job without a result in that time is stopped, its
   container is removed (by the label `simra.experiment=<id>`), and its status is `timeout`.
3. Read the result: one line per job with its status, experiment id, CPUs, runtime, exit code and log paths, then the
   counts. The CLI exits with 0 only when every job completed.

The wait reads the experiment records (`result.json`, and `status.json` with the process id). It never matches
process names, so it cannot wait on its own command line. `wait_timeout_s` (pi) or `--timeout-s` (CLI) ends the wait
early: a started job continues (wait for it with `wait_experiments`), and a job that did not start is `not_started`
and never runs.

When an experiment starts, the summary gets one line with the runtimes of the earlier runs, for example
`estimate: earlier runs of klayout drc on this design took 391.8 to 427.7 s (2 runs)`. The line uses the
completed runs in `simra/experiments` of the design root with the same adapter, the same operation and the same
input `rule_set`, that ended before the new run started. It gives only the shortest runtime, the longest runtime
and the number of runs. When there is no such run, there is no line.

The `simulate` operation of the ngspice adapter takes two optional inputs for the condition of a run:

- `params`: an object `{name: value}`. Each entry becomes a `.param name=value` line after the deck. A number is
  written as a number. A string is written as is, for example `"2p"` or `"{vdd/2}"`.
- `temp_c`: a number. It becomes a `.temp` line after the deck.

ngspice uses the last `.param` line of a name and the last `.temp` line, so these lines replace the values in the
deck. The adapter does not use `.option temp=`, because it does not replace a `.temp` line of the deck.

The design root is the nearest directory upward with `simra.config.json`. It defines the execution
environments. Put machine-specific settings (image ID, CPU list) in `simra.local.json`, which git ignores.
See [examples/ota-sg13g2](examples/ota-sg13g2/README.md).

## Device-class probe

A simulator can lack a model of a PDK, or read it with a parameter that it ignores. Find this before a campaign, not
during it. `npx simra probe --pdk <name>` runs one small DC deck per device class of the technology pack in ngspice and
in Xyce (two jobs of [Run N jobs and wait](#run-n-jobs-and-wait); add `--environment` and `--cpus`). It prints one
line per class with one column per simulator:

- `simulates`: the operating point converged, and the DC current of the probe source is a number;
- `parses`: the simulator read the netlist, but the analysis gave no value;
- `fails`: the simulator did not read the netlist (a model gap), with the first error and its file and line;
- `not run`: the class did not end in its time.

Then it lists the reasons, the classes where the simulators disagree by more than 1 % on the probe current, and the
fidelity warnings (for example a model parameter that Xyce ignores). `--json` prints the table. The decks come from
the section `device_probe` of the pack (see [technologies/README.md](technologies/README.md)).

The table of IHP SG13G2 (ngspice 46, Xyce 7.10, simulated in the environment image) is a test fixture,
[test/fixtures/device-probe/ihp-sg13g2.json](test/fixtures/device-probe/ihp-sg13g2.json):

| Classes | ngspice | Xyce |
| --- | --- | --- |
| MOS LV and HV, NMOS and PMOS (PSP 103) | simulates | fails: Xyce rejects the PSP 103 card (`Unrecognized parameter D`) |
| HV varactor | simulates | fails: the Xyce library does not define `sg13_hv_svaricap` |
| poly resistors rsil, rppd, rhigh (r3_cmc) | simulates | fails: Xyce rejects the r3_cmc card (`Unrecognized parameter 1`) |
| HBT npn13G2, npn13G2l, npn13G2v, pnpMPA | simulates | simulates; the currents agree within 0.2 %; Xyce ignores the safe-operating parameters |
| MIM capacitors cap_cmim, cap_rfcmim | simulates | simulates |
| diodes dantenna, dpantenna, schottky_nbl1, diodevdd_2kv | simulates | simulates; the antenna diode currents differ by 27 % to 38 % |

## EM S-parameters

`npx simra em <inputs.json>` gives the S-parameters of a layout cell with openEMS. The inputs are those of the
operation `simulate` of the [openems adapter](adapters/openems/README.md): the GDS, the cell, the openEMS stackup
XML of the PDK, the lumped ports and the band. Add `--environment`, `--cpus` and `--timeout-s` (the wall time of each
port job).

1. The command starts one `simulate` job per port, with only that port excited, as
   [Run N jobs and wait](#run-n-jobs-and-wait). Each job runs headless and detached on its slot of the CPU pool.
2. When every port job is complete, a `merge` job writes `<cell>.s<N>p` (role `touchstone`). The kernel adds its
   summary, and the requirement kinds `s_db` and `mu` can read it.
3. A port job that failed, timed out, or did not reach the end criterion of openEMS stops the merge. The command then
   names the job and the reason, and gives no Touchstone file.

In pi, the tool `em_sparameters` does the same and lists every S_ij in dB and degrees at the frequencies of
`report_at_hz`. Input `deembed` moves port reference planes (see the [openems adapter](adapters/openems/README.md)).
`npx simra snp-diff <a.sNp> <b.sNp> [--band <lo,hi>]` compares two Touchstone files: per S_ij the largest difference in
dB, in degrees and of |S|, at the frequencies that both files have. Entries below -40 dB in both files get no dB or
degree difference (only |dS|).

The end criterion is the check of an FDTD run: the field energy must fall by `end_criteria_db` (default -40 dB). A
run that stops at `max_timesteps` with the energy at a plateau can give S-parameters that look correct. The adapter
records `end_criteria_reached_p<k>` and `energy_end_db_p<k>` and reports such a run as failed.

The default boundaries are PML on the sides and the top and PEC at the bottom. With first-order MUR boundaries, a
microstrip on the IHP SG13G2 stackup stays at an energy plateau of -13 dB to -18 dB and never reaches the end
criterion.

A longer line can also stay above the end criterion with PML (simulated, openEMS 0.37, one-port runs of 60000 time
steps, `margin_um` 200): a 600 um line reaches -41.0 dB, a 700 um line stays at -26 dB and an 800 um line at -20 dB.
The 800 um line reaches -40.0 dB with `margin_um` 400, and -41.2 dB with PML also at the bottom. The mesh at the ports
is the same for all lengths. A wave in the substrate that the side PML at 200 um does not absorb is the probable
cause; the workaround registry entry `openems-sg13g2-long-line-decay` gives the workaround (a larger margin).

The container test is one real run: a TopMetal2 line (300 um x 18 um) over a Metal1 ground on the IHP SG13G2 stackup,
1 GHz to 60 GHz, two port jobs on 4 CPUs (see [test/openems-container.test.mjs](test/openems-container.test.mjs)).
Result (openEMS 0.37, simulated): each port run reaches -40.5 dB after 16450 time steps on 68952 cells, in 16.5 s. At
60 GHz |S11| is -32.7 dB and |S21| is -0.164 dB; S21 equals S12 within 0.05 dB over the band. A second container
test checks the de-embedding: the 600 um line with 150 um removed at each port equals the 300 um line.

Validation against a stored multi-layer model (simulated, openEMS 0.37, both runs). The structure is a three-port
on-chip junction: a TopMetal2 line over a slotted Metal1/Metal2 ground with 70 Via1 cuts, homogenised metal-fill
slabs, a 400 um x 400 um die, 1 GHz to 400 GHz, end criterion -50 dB. The reference is the result of an independent
openEMS script with the same stackup and the same slab values. `simra em` used the inputs `faces`, port widths,
`merge_um` (Via1), `cut` (Metal1 and Metal2 datatype 24), `slabs` and `die`; 757350 cells, three port jobs on 4 CPUs,
each at -50 dB after 66930 to 77794 time steps, 1080 s in total. `simra snp-diff`, 400 common points:

| entries | 1 GHz to 200 GHz | 1 GHz to 400 GHz |
| --- | --- | --- |
| transmission (S21, S31, S32 and the reverse) | max 0.40 dB, 1.6 deg | max 0.41 dB, 3.2 deg |
| reflection (S11, S22, S33; about -10 dB) | max 0.69 dB, 8.5 deg | max 0.73 dB, 8.5 deg |
| largest difference of the complex value, any entry | 0.050 | 0.050 |

Without `cut`, the slits of the ground are solid metal, and the reflections differ by 1.1 dB to 1.2 dB at every
frequency from 1 GHz (transmission 0.47 dB). With `cut`, the metal areas are equal to those of the reference model.
The remaining reflection difference is 0.2 dB at 1 GHz and rises with frequency to 0.7 dB. Three known model
differences were tested one at a time (simulated, openEMS 0.37, 1 GHz to 400 GHz, maximum reflection difference to
the reference):

| change | S11 | S22 | S33 | result |
| --- | --- | --- | --- | --- |
| none (the run above) | 0.73 dB | 0.64 dB | 0.68 dB | |
| reciprocity: mean of S_ij and S_ji, as the reference | 0.73 dB | 0.64 dB | 0.68 dB | excluded: it changes no S_ii; max \|S_ij - S_ji\| is 0.005 |
| Via1 conductivity factor 0.1003 (`via_fill`), as the reference (0.108 before) | 0.76 dB | 0.66 dB | 0.71 dB | excluded: 0.03 dB or less change |
| `min_cell_um` 1.5 (631680 cells), near the reference mesh | 0.73 dB | 0.43 dB | 0.66 dB | explains a part of S22 only |

The cause of the S11 and S33 difference is not established. The refined region of the reference at the line was not
tried.

## Workaround registry

A simulator can fail a device class of a PDK or an analysis, sometimes with no message. The registry holds each known
gap with the stated workaround, as data: `workarounds/<simulator>/<pdk>.json`, and `workarounds/<simulator>/any.json`
for gaps that do not depend on the PDK. Each entry has an id, where it applies (device classes of the device-class
probe, analyses, operations), the gap, the symptom, the workaround, the evidence and a status:

- `worked_around`: the workaround was used and checked;
- `proposed`: the workaround is not yet used;
- `open`: there is no workaround (use another simulator).

The agent sees the entries of an adapter and its PDK (the `pdk` input or the `PDK` variable of the environment) with
the first result of that adapter in a session (`run_experiment`, `run_jobs`, `em_sparameters`). The tool `workarounds`
and `npx simra workarounds [--simulator <name>] [--pdk <name>]` list them. A test checks that each class that a
simulator fails in the stored device-class probe has an entry.

| Simulator | PDK | Entries |
| --- | --- | --- |
| Xyce 7.10 | IHP SG13G2 | PSP 103 MOS (open), r3_cmc poly resistors, HV varactor subcircuit, HBT transit time with dtemp |
| Xyce 7.10 | any | no autonomous HB or HB noise, .step with HB, YLIN outside HB, .temp ignored |
| ngspice 46 | IHP SG13G2 | KLU on a large mixed deck, Monte Carlo DC with reltol 1e-4, HBT self-heating, antenna diode step |
| ngspice 46 | any | pulse with PW = 0, trnoise with a round step, trnoise current source, threads in a container, .pss |
| openEMS 0.37 | any | MUR energy plateau, thin dielectric time step, headless runs |

## Connection table

Integration finds mismatches late when each block keeps its own idea of its pins, bias and controls. The connection
table (schema `simra.connections/0`) is the interface of the chip, written before the block work:

- `supplies`: name, voltage and tolerance, and `range_v` ([low, high]) for a supply with a stated range (a
  programmable regulator); a block simulated at any voltage in the range passes;
- `blocks.<block>.pins.<pin>`: the net and the kind (`supply`, `ground`, `bias`, `bias_out`, `control`, `signal`). A bias
  need has its current or voltage, tolerance (or `range`, [low, high], which replaces it), temperature behaviour (`constant`, `ptat`, `ctat`) and its provider
  (`<block>.<pin>`, a `bias_out` pin on the same net). A control pin names a control;
- `controls.<name>`: bits, encoding (`binary`, `thermometer`, `one_hot`, `gray`), active level, reset value and logic
  level.

Each block keeps a block interface record (schema `simra.block_interface/0`): its netlist and subcircuit, and the supply
voltages, bias values and control encodings that its own simulations used. The gate in `requirements.json`:

```json
"gates": { "connections": { "table": "../spec/connections.json", "block": "div", "interface": "interface.json" } }
```

gives one verdict row per item (requirement `gate connections <block>`):

1. the pins of the `.subckt` line against the pins of the table (missing and extra pins);
2. each supply pin: the simulated voltage against the supply of its net;
3. each bias need: the simulated value inside the tolerance of the table, and the temperature behaviour;
4. each control: bits, encoding, active level and reset value;
5. a bias need or a control of the block that is not in the table;
6. the problems of the table for this block: a need without a provider, a provider with another value or temperature
   behaviour, a control without a definition, a bias output that no other pin uses.

A block without a record gets a row that is not run, so the check is never a pass. A record that does not state a
value (a supply voltage, a temperature behaviour) gives a row that is not run, not a fail.
`npx simra connections --table <file>` checks the whole table; add `--block <name> --interface <file>` for one block.

Result on a real chip (17 instances, 919 pins, 88 control fields; fixture
[chip17.json](packages/kernel/test/fixtures/connections/chip17.json)). The table was converted from the chip's
interface specification (bias values, control widths) and its top netlist (pins, nets, register map); the records
from the testbench sources of each block, its control files and its subcircuit lines. The gate gave 6 distinct
mismatches:

| Mismatch | Instance and pin | Reading |
| --- | --- | --- |
| bias output without a consumer | `xbias.vref_f` | an open item of the chip's own list |
| control width 4 bits in the specification, 5 in the block | `xbias.pa_t0` to `pa_t4` | stale specification row |
| high-pass and gain codes: 3-bit binary in the specification, 7 and 6 one-hot lines in the block | `xif.hp0` to `hp6`, `xif.pg0` to `pg5` | stale specification row |
| mixer reference 1.0 mA +-5 % in the specification, 1.1 mA in the block | `xmixi.m1_m`, `xmixq.m1_m` | stale specification row |
| LO bias 2.25 V in the specification, 1.95 V in the block | `xmixi.vblo`, `xmixq.vblo` | stale specification row |
| PA supply simulated at 0.75 V, the net is 0.90 V | `xpa.vccpa` | a range supply (0.70 V to 1.10 V): with `range_v` in the table, this row passes |

The first five go to the chip as stale rows of its connection file.

The chip's own list of open mismatches has six items. The gate finds the unused output and the stale specification
rows. It does not find, by design, the items that are not pins, values or encodings: an ideal source inside a cell, a
missing DC path in an EM fit, ESD and ideal resistors, one ground for all blocks, ideal port resistors, and a count
of reference channels.

## Add a PDK

A technology pack holds the facts of one PDK for the adapters (see [technologies/README.md](technologies/README.md)).
A pack for a PDK that is not in this repository is site data: it fits the kit version of the site. An adapter that
has the operations `pack_propose` and `pack_check` (see [CONTRIBUTING.md](CONTRIBUTING.md)) makes the pack from the
kit. To add a PDK:

1. Run `npx simra pack init --pdk <name> --pdk-root <kit directory>` in the design root. Add `--adapter <name>` when
   more than one adapter has `pack_propose`. Add `--inputs '<json>'` for more inputs of the adapter, for example
   `'{"vdd_v": 0.8}'`.
2. Read the report. Each fact has its source and a confidence (`sure`, `guess` or `todo`). Answer the open
   questions. The run is a normal experiment record; `npx simra show <id>` prints it again.
3. Run the command again with `--write`. In a terminal, the command also asks before it writes. It writes the pack to
   `<dir>/<pdk>/technology.json`. `<dir>` is `--dir`, else the first entry of `technology_dirs`, else
   `${XDG_DATA_HOME:-~/.local/share}/simra/technologies`. It never overwrites a pack file.
4. When the command says so, add the directory to `technology_dirs` of `simra.config.json` or `simra.local.json`.
5. Edit the pack file for the answers of step 2.
6. Run `npx simra pack check --pdk <name>`. It prints `pass`, `fail` (with the failure class) or `not run` (with the
   reason) for each check of the adapter.

Two packs with the same PDK name or pack name in the technology directories are an error. `simra pack check`
names both files.

## Files of record

A verdict is about the file that it ran on. When the file changes after the run, the verdict is stale. The kernel
reads the hashes of the input files in the records back, and compares them with the files in the design root.

A file of record is an input file of an experiment in the design root, with a role other than `deck`,
`technology` and `model`. For the klayout adapter, these are the layout (`layout`) and the reference netlist
(`netlist`).

1. The summary of an experiment (`run_experiment`, `wait_experiments`, `simra run`, `simra wait`, `simra show`)
   gives one line after the input files for each file of record that changed after the run, for example
   `STALE: layout block.gds changed after this run (now sha256:3f2a9c01b7d4)`.
2. The design record gives one block per file of record: the path, the current sha256, the last git commit of the
   file (when git tracks it), then one line per experiment that used the file. Current experiments come first,
   the most recent first. A stale experiment has the note `(stale: ran on sha256:<hash>)`. A file without a
   current experiment has the line `no check on the current file`.
3. Run `npx simra record` to print the design record, or `npx simra record block.gds` for one file. In pi, the agent
   calls `design_record` (optional `paths`).

Example:

```
layout block.gds sha256:3f2a9c01b7d4
  git 8d1e5a7c2b90 block: widen the vdd bus
  20261103-101530-4be2c1 klayout drc [full] completed markers=0 rules_violated=0
  20261103-100212-a0f3d9 klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0 (stale: ran on sha256:91c04e6a2f18)
netlist block.spice sha256:c7b2e0d4a611
  git 1f0a3b6c9d22 block: first version
  20261103-100212-a0f3d9 klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0
```

The record shows at most 6 experiments per file, and one line with the count of the others. Each line gives the
first 3 measurements of the run, without the runtime. The record runs no tool. It reads `simra/experiments` and
hashes the files of record.

In pi, the prompt rules tell the agent to confirm with `design_record` that a check is current before it reports
the check, and to rerun a stale check. When a file of record changed under the agent (another commit, another
process), the agent reads the new version and applies its change to it. It does not overwrite the file with its own
earlier copy.

## System prompt

In pi, the extension replaces the first paragraph of pi's system prompt. pi's paragraph describes a coding
assistant. The extension's paragraph (`SIMRA_PREAMBLE` in `packages/pi-extension/index.ts`) describes a chip
design assistant that reports only simulated numbers. The extension keeps pi's list of tools and the rules of the
tools. It adds one rule for PDFs (see [PDF reader](#pdf-reader)). It removes pi's section about the pi documentation.

A system prompt that you give to pi (`--system-prompt` or `.pi/SYSTEM.md`) stays as it is.

## Netlist check

Some simulator options add elements to the circuit. For example, `.option rshunt=5e5` connects 500 kΩ from
each node to ground, and the gain decreases. The ngspice adapter gives a warning, with the file and the line,
for `rshunt`, `cshunt` and a `gmin` above 1e-12:

- in the response of each `simulate` run;
- from the operation `lint` (input `files`), which runs no simulation.

In pi, the extension adds these warnings to the result of a `read`, `write`, `edit` or `bash` call that names a
netlist. It adds each warning one time per session.

## PDF reader

In pi, the agent reads a PDF with `read`. Before the call, the extension extracts the text of the PDF into a cache
one time. Then `read` gives the text with a `[page N]` marker before each page. `offset` and `limit` work as for a
text file.

The cache is `$SIMRA_CACHE_DIR`, else `$XDG_CACHE_HOME/simra`, else `~/.cache/simra`. Each PDF has a folder
`pdf/<sha256>/` with these files:

- `document.md`: a short header, then the pages. The header gives the source, the page count, the outline (with the
  page and the line of each entry) and the warnings. Page N starts with the line `[page N]`. N is the page number in
  the file, not the printed page label.
- `meta.json`: the hash, the page count, the outline, the warnings and the line of each page marker.
- `page-N.png`: an image of page N, at about 150 dpi (at most 2000 pixels on the long side). It exists after the
  first read of the page as an image.

The cache is per user, and you can delete it. The reader does not write into the design repository or the PDK tree.

To see a figure, the agent reads the PDF path with `#page=N` at the end, for example `rules.pdf#page=12`. The
extension renders the page to `page-N.png` with PDFium (WebAssembly), if the cache does not have it, and points the
call at the image. Then `read` shows the image. If the model has no image input, the extension stops the read and
tells the agent to use the text of the page.

The extension finds the file of a `read` call as pi's `read` finds it, also with `@`, `~`, `file://` URLs and the
macOS file-name fallbacks of pi.

The system prompt has a rule for PDFs: look at the page before you copy a circuit, table or plot from a figure, and
check a netlist copied from a figure with a simulation.

A page without text, for example a scanned page, gets the warning "No text layer". The reader does no OCR. An
encrypted or broken PDF gives an error, and the reader writes nothing to the cache.

From a plain command line:

1. Run `npx simra pdf <file>` to print the header and all pages.
2. Add `--pages 12-14` to print the header and only these pages.
3. Add `--render 12` instead to render page 12 and print the path of its image.

## Context of a session

By default (`SIMRA_CONTEXT=lean`) the pi extension changes the messages before each model call:

1. The reasoning (thinking) blocks of every assistant turn except the last are removed. The tool calls and the tool
   results stay.
2. The agent writes a short state note with the tool `state_note` (at most 3000 characters, file
   `simra/state_note.md`): the aim, the design state, the results so far and the next step. Only the newest note is
   sent in full; the arguments of earlier `state_note` calls are replaced by a one-line reference.

`SIMRA_CONTEXT=full` keeps every message as pi sends it (the earlier mode). `evals/run-arm.mjs --context lean|full`
sets the variable in the sandbox and writes the mode to `score.json`.

## Read an output

The pi tool `read_output` reads one output file of an experiment (`file`: a path in the design root, or
`<experiment id>/<file>` for `simra/experiments/<id>/work/<file>`):

1. `kind: "log"`: the measurement lines (`name = value`), the error lines (each message once) and the
   warning lines, with their counts; `pattern` (a regular expression) adds the lines that match.
2. `kind: "table"`: a SPICE raw file (ASCII or binary; complex values as `<name>.re` and `<name>.im`), an ngspice
   `print` output or a `wrdata` file. `columns` (names or `/regex/`), `by` (the column of the range, default the first),
   `from`, `to` and `max_rows` (default 40, spread evenly over the range) select the rows. The result also gives the
   minimum and the maximum of each column in the range, with the value of the first column at each.

The kernel functions `readLog`, `queryTable`, `formatLog` and `formatTable` do the work. The first three reads of a log
or table with `bash` in a session, and then every tenth, get a note that names `read_output`.

## Device budget

The ngspice operation `device_budget` gives the RF budget of one HBT (or another three-terminal device) at a bias and
frequency, from ngspice two-port and noise runs:

1. Inputs: `device` (the subcircuit, for example `npn13G2`), `instance_params` (for example `{"Nx": 4}`), `pins`
   (default `c b e bn`), `libs`, `temp_c`, `vce`, and `ic_a` or `vbe`; `freq_hz` (one or more frequencies); `z0`
   (default 50); `noise` (default true).
2. Bias: a DC sweep of V<sub>BE</sub> finds the V<sub>BE</sub> for `ic_a`. An operating point gives I<sub>C</sub> and
   I<sub>B</sub>.
3. Two-port: an `sp` run at each frequency gives S, the stability factor K, μ, MSG, MAG (K > 1 only), Mason's U and
   h21. fT is f·|h21| and fmax is f·√U (a warning when |h21| < 3 at the frequency).
4. Noise: one `noise` run per source impedance (seven impedances around 50 Ω) and a least-squares fit of
   F = Fmin + Rn/Gs·|Ys − Yopt|² give NFmin, Rn, Zopt and the relative residual of the fit.
5. Output `work/budget.json` and the measurements per frequency. NFmin is optimistic: the VBIC model of the PDK has no
   correlated base–collector shot noise.

Check on IHP SG13G2 npn13G2 Nx 4, V<sub>CE</sub> 1.2 V, hbt_typ, 27 °C (simulated, ngspice 46), against a published
device study of a 122 GHz radar design:

| Quantity | device_budget | Study |
| --- | --- | --- |
| U, MSG, K at 122 GHz (J<sub>C</sub> 38, 9.58 mA) | 11.29 dB, 11.74 dB, 0.945 | 11.3 dB, 11.7 dB, 0.95 |
| U, MSG, K at 61 GHz | 17.45 dB, 14.84 dB, 0.49 | 17.5 dB, 15 dB, 0.49 |
| NFmin and Zopt at 122 GHz (J<sub>C</sub> 38) | 4.11 dB, 50.0 + 31.7j Ω | 4.03 dB, 50 + 31j Ω |
| NFmin at 122 GHz / 61 GHz (J<sub>C</sub> 4.3, 1.08 mA) | 2.80 dB / 1.61 dB | 2.75 dB / 1.6 dB |
| fT / fmax (J<sub>C</sub> 38) | 351 GHz / 455 GHz | not given |

## Session time

Set `SIMRA_SESSION_DEADLINE` to an ISO 8601 time, for example `2026-10-30T15:00:00Z`, to give pi a time limit.
After 50 % and after 80 % of the time, the extension adds a note to the next tool result. The note gives the
time that is left and tells the agent to write its output files with the best result so far. The eval runner
`evals/run-arm.mjs` sets this variable from `--timeout-min`.

## Operating point

The operation `operating_point` of the ngspice adapter shows the DC operating point of each MOS device of a
testbench, and whether the device is in saturation. Use it to find why a design fails.

1. Give the inputs `deck` and `libs`, as for `simulate`. Set the DC values of the sources for the condition to
   check, for example one input common-mode voltage.
2. The adapter removes the `.control` blocks, the analyses and the `.meas` lines of the deck, and runs `op`.
3. The response has the measurements `<device>.vgs`, `.vth`, `.vds`, `.vdsat`, `.id`, `.gm`, `.gds`, `.vov`
   (|vgs| − |vth|) and `.sat_margin` (|vds| − |vdsat|) for each MOS device. It has a warning for each device
   in triode or in subthreshold.

The parameter names of the MOS models are different in each PDK. They are in the technology packs in
[technologies/](technologies/README.md). The adapter selects the pack for `$PDK`, or the pack in the input
`technology`. Packs exist for IHP SG13G2, IHP SG13CMOS5L and SKY130.

## Assemble a DC point

A deck with many blocks (a whole chip) can fail to find a DC point, or find a wrong one, also when each block alone
converges. The operation `assemble_dc` of the ngspice adapter builds the DC point from the points of the parts.

1. Give `deck` and `libs` as for `simulate`, and `seeds`: the node voltages of earlier runs. A seed file is
   `{"v(node)": volts}` (for example the op of a block testbench) or the `dc_point.json` of an earlier assembly.
   `from_prefix` and `to_prefix` change the testbench names to the deck names, for example `x1.` to `xcore.xif.`.
   Later seeds win.
2. Each seeded node gets a clamp current g (V - V_seed). A `.dc` sweep takes g from 1 S to 10^-`decades` S
   (default 12), with `steps` points (default 50). Each point starts from the point before.
3. Optional `phases`: lists of node-name prefixes, released in this order. Nodes in no phase are released last.
   When the sweep stops, the error names the phase. Add a seed for its nodes, split the phase, or add steps.
4. Then a free operating point runs without clamps, with `.nodeset` from the end of the sweep. Its node voltages are
   in `work/dc_point.json` (role `dc_point`). The measurement `free_op_max_dv_v` is the largest change from the end of
   the sweep.
5. The free op has a time limit, `free_op_timeout_s` (default 2 x the time of the sweep, at least 300 s). When it
   fails or passes the limit, the run fails. With `accept_clamp_end: true`, the run is completed with a warning, and
   `dc_point.json` and the currents come from the end of the sweep, with the residual clamp of 10^-`decades` S on each
   seeded node. `work/clamp_end.json` (role `clamp_end`) always has the end of the sweep; use it as the seed of a next
   run when the free op moves nodes without a DC path (for example thermal nodes with self-heating off).

The solver is Sparse 1.3, the ngspice default; `solver: "klu"` selects KLU. `options` adds one line of ngspice options,
for example `reltol=1e-3 itl1=1000`. The test
[test/ngspice-assemble.test.mjs](test/ngspice-assemble.test.mjs) uses a latch with two stable states: the seed
selects the state, and the free operating point corrects a wrong seed of a divider.

Result on a real chip (the same chip as the connection table: 17 block instances, 6561 seeded nodes, three corners).
The reference is the stored result of the chip's own clamp-homotopy scripts, which use the same method without a free
operating point: step A with self-heating off, seeded from the block points, then step B with self-heating on, seeded
from the end of step A; 100 steps, 12 decades, one phase, Sparse 1.3 (simulated, ngspice 46, one CPU per run, three
runs at a time on a shared server):

| corner, step | clamp sweep | free op | total | reference | nodes > 1 mV different | supply currents |
| --- | --- | --- | --- | --- | --- | --- |
| tt, A | 194 s | 135 s | 337 s | 164 s | 37 (free op, see below); clamp end: 0 (max 0.6 uV) | equal to 0.001 mA |
| fast -40 C, A | 193 s | 115 s | 315 s | 149 s | 39 (free op); clamp end: 0 (max 0.7 uV) | equal to 0.001 mA |
| slow 125 C, A | 614 s | stopped at 600 s | 1223 s | 443 s | clamp end: 0 (max 4.6 uV) | equal to 0.001 mA, total 134.89 mA |
| tt, B | 494 s | 160 s | 659 s | 274 s | 0 (max 63 uV) | total 140.48 mA, equal |
| fast -40 C, B | 277 s | 119 s | 401 s | 302 s | 0 (max 0.24 mV) | total 148.42 mA, equal |
| slow 125 C, B | 701 s | stopped at 900 s | 1609 s | 590 s | clamp end: 0 (max 2.6 uV) | total 134.89 mA, equal |

In step A the free op moves the 37 thermal nodes of the HBTs (no DC path with self-heating off) from the residual
clamp to 0 V, by up to 30 mV; at fast -40 C two more nodes (a test-current input to an open switch) move by 1.04 mV.
These nodes have no defined DC value, so the end of the clamp sweep is the point to compare and to use as the next
seed. At slow 125 C the free op does not converge in 600 s (step A) or 900 s (step B); the clamp end is the
result there, as in the reference. Two faults of the tool on this chip were fixed: the free op at slow 125 C did not end in 45 min (now
`free_op_timeout_s` and `accept_clamp_end`), and step B at fast -40 C seeded from the free op of step A (thermal nodes
at exactly 0 V) went to gmin stepping after a NaN in the thermal limiter of the HBT model, where the seed from the
clamp end (`clamp_end.json`) converges. The clamp sweep takes 0.9 to 1.8 times the reference time with the same deck
and method; the run load of the server differed, so this ratio is not a property of the tool.

## Oscillator

The operation `oscillator` of the ngspice adapter gives the steady-state frequency, the amplitude and the phase noise
(white and flicker) of an oscillator from transients, by the impulse sensitivity function (ISF).

1. Give `deck` and `libs` as for `simulate`. The deck must start to oscillate by itself (for example with a short
   current kick). Give `output` (`{p, n}`: the output is v(p) - v(n)), `tstep_s` (a fixed step), `settle_s` and
   `ref_stop_s`. The reference run gives `f0_hz`, `amplitude_v` and `period_spread_rel` (a warning above 1e-3: the
   oscillator is not in steady state at `settle_s`).
2. Optional `isf`: the noise sources. A current source is `{name, nodes: "n+ n-", psd_a2_hz, mult}`, or
   `{name, nodes, shot: "<current vector>", mult}` for shot noise 2 q |i(t)| of a vector of the reference run.
   `psd_a2_hz` can also be a list with one PSD per phase (a cyclostationary PSD from another run); `t0_s` then fixes
   the phase origin. A shot vector must be a conduction current: in a transient, the terminal currents of a bipolar
   model, and `[ib]` of the ngspice VBIC model, include the charge currents. Use `shot: {device, current}` instead:
   `isf.devices` defines a DC conduction table of the device (the device alone in `lines`, a 2-D `sweep` of two node
   voltages, two `axes` vectors such as the internal vbe and vbc, the same two vectors `at` in the oscillator deck, and
   the `currents`). The operation interpolates the table at the transient axis values of each phase. A series voltage
   source is `{name, vsource, psd_v2_hz, mult}`; `vsource` is a voltage source of value 0 in the deck. `mult` counts
   identical sources by symmetry.
   `flicker: {device, current, kf, af, bf}` on a source adds flicker noise S = kf |i|^af / df^bf by the DC term of the
   ISF: L(df) = mult x 1/2 x (f0/df)^2 x mean(ISF x |i|^(af/2))^2 x kf / df^bf.
3. For each source and each of `phases` phases, two runs inject +q and -q with a short triangle pulse. The shift of
   the output zero crossings in `window_periods` (default 35 to 45 periods after the injection) gives the ISF. Then
   L(df) = mult x 1/2 x (f0/df)^2 x mean(ISF^2 x S) for each source, and the total is the sum.
4. Sources and devices inside the design subcircuit. A bench that instantiates the design (for example
   `xdut ... vco`) cannot name the nodes inside it. A source or a device can then name an instance of the
   subcircuit: `instance: {subckt, name, pins: [i, j]}` injects a current between the nodes of pins i and j of that
   instance; `instance: {subckt, name, pin: i}` puts a series voltage source of value 0 in the lead of pin i; a device
   with `instance: {subckt, name}` takes its table lines from the instance line (the first two pins become the two
   swept nodes, the other pins ground, the instance parameters unchanged; its table vectors are `@q.x<device
   name>.<model device>[...]`). The operation inlines the include file that defines the subcircuit. The injection is
   in every instance of the subcircuit, so the bench must have one. The `at` vectors use the hierarchical names of
   the bench, for example `@q.xdut.xq1.qnpn13g2[vbe]`.
5. `output_multiplier` gives L after an ideal frequency multiplier (+20 log10 of it). The measurements are
   `l_<offset>_hz_dbc`, for example `l_1e+06_hz_dbc`, and `l_white_<offset>_hz_dbc` when a source has flicker.
   `work/oscillator.json` has the ISF, the PSD, the conduction currents and L of each source.

AM-to-PM conversion after the oscillator is not included. The test
[test/ngspice-oscillator.test.mjs](test/ngspice-oscillator.test.mjs) uses an LC oscillator with a limiting negative
conductance: f0, the amplitude and L(1 MHz) of the tank resistor noise agree with the closed form for a sine output
(simulated, ngspice 41 on the host: −128.92 dBc/Hz against −128.85 dBc/Hz).

Result on a real VCO (simulated, ngspice 46, IHP SG13G2 typical, 27 C): the 61.8 GHz cross-coupled HBT oscillator of
architecture A of the radar study (fixture [vco_a.spice](packages/kernel/test/fixtures/oscillator/vco_a.spice)), 32
phases, six sources (tank, collector and base shot noise, rb, re, rc), the same pulse, charge and window as the stored
result of the study's own ISF script. 384 runs, 681 s on 2 CPUs.

| quantity | operation | stored | difference |
| --- | --- | --- | --- |
| f0 | 61.828 GHz | 61.830 GHz | 0.002 % |
| ISF of each source, largest point difference over the rms | 0.3 % to 7.4 % (rc) | | |
| L(1 MHz) of each source | | | 0.02 dB or less |
| L(1 MHz) at 122 GHz, white noise | −88.63 dBc/Hz | −88.63 dBc/Hz (−88.60 with base flicker noise) | 0.01 dB |

The first run used `shot` with the VBIC vectors `[ic]` and `[ib]`: the ISF was the same, but the base shot noise was
24 dB too high and the collector shot noise 1.7 dB too high, because in a transient these vectors include the charge
currents. The result above uses the conduction currents of the stored run as `psd_a2_hz` lists with `t0_s` 1 ns. The
container test runs the same deck with 8 phases and the tank source only: −96.43 dBc/Hz at 2 f0 against −96.41.

With `isf.devices` (the same table sweep as the study: collector −1.0 V to 2.6 V, base −0.6 V to 1.1 V, 123101
points) and the base flicker of the study (kf 1.2e-8, af 1.8, bf 1), the operation needs no PSD list (simulated,
ngspice 46, 1330 s on 4 CPUs):

| quantity, at 122 GHz | operation | stored | difference |
| --- | --- | --- | --- |
| conduction currents at the 32 phases, largest difference over the peak | collector 0.15 %, base 0.4 % | | |
| L(1 MHz), white | −88.63 dBc/Hz | −88.635 dBc/Hz | 0.005 dB |
| L(1 MHz), with flicker | −88.59 dBc/Hz | −88.60 dBc/Hz | 0.005 dB |
| L(100 kHz), with flicker | −68.28 dBc/Hz | −68.28 dBc/Hz | 0.004 dB |
| base flicker term at 1 MHz (at f0) | −115.40 dBc/Hz | −115.39 dBc/Hz | 0.01 dB |

The study stores L at 1 MHz only, per source; the 100 kHz value above is derived from its white total (+20 dB per
decade) and its flicker term (+30 dB per decade).

## Check requirements

`requirements.json` in the design root (schema `simra.requirements/0`) has three parts:

- `conditions`: named conditions, for example process corners. The `inputs` of a condition replace the
  experiment inputs of the same name.
- `experiments`: one template per measurement setup (`adapter`, `operation`, `inputs`). In each string input,
  `{condition}` is replaced with the condition name.
- `requirements`: each has an `id`, an `experiment`, a `measurement`, an optional `unit`, an `op` (`<=`, `>=` or
  `between`), a `limit` and optional `conditions`. The limit is one number, `[low, high]` for `between`, or one
  limit per condition. A requirement without `conditions` runs its experiment once, with the template inputs
  only. Its verdict row has the condition `null`.

Other top-level fields are errors. An older file with a top-level `design` section is an error too. The message
tells how to write the design check as an experiment (see [Design contract](#design-contract)).

Example:

```json
{
  "schema": "simra.requirements/0",
  "conditions": { "nominal": {} },
  "experiments": {
    "ac": { "adapter": "ngspice", "operation": "simulate", "inputs": { "deck": "rc.spice", "measurements": { "f3db_hz": "Hz" } } }
  },
  "requirements": [
    { "id": "bandwidth", "experiment": "ac", "measurement": "f3db_hz", "unit": "Hz", "op": "between", "limit": [150, 170], "conditions": ["nominal"] }
  ]
}
```

1. Write `requirements.json` in the design root.
2. Run `npx simra check`. To check a part, add `--only <id,...>` or `--conditions <name,...>`.
3. Read the verdict. The command exits with 0 only when the status is `pass`.

The check runs 4 experiments at the same time. To change this number, add `--parallel <n>`. With
`--parallel 1`, the experiments run one at a time.

A condition can give the verification bench its values: for ngspice, put `params` and `temp_c` in the `inputs`
of the condition (see [Run a simulation](#run-a-simulation)). The bench then comes from the requirements, not
from a testbench that the agent writes.

The check runs each experiment once per condition, also when more than one requirement reads it. Each row is
`pass`, `fail`, `not_measured` (no value, or a different unit) or `not_run` (the experiment did not complete,
or the row was not selected). The status is `pass` only when every row passes. A check of a part is never
`pass`.

The verdict has the diagnostics (errors and warnings, with file and line) of each experiment. When a row of an
experiment does not pass, the summary shows the diagnostics of that experiment before the rows.

### Sweeps

A sweep bench checks a requirement over an input range, for example the input common-mode voltage. Its
`.control` block prints one line per sweep point:

```
ROW <sweep>=<value> <name>=<value> ...
```

For example, `echo ROW vcm=$vcm gain_db=$&gain_db pm_deg=$&pm` in a `foreach` loop. The first key is the sweep
variable. A value is a number, optionally with a SPICE scale suffix such as `1k`. A value that is empty or not
a number means that the point has no value.

1. The ngspice adapter writes the table to `work/sweep.json`.
2. For each column `<name>`, it reports `<name>.min` and `<name>.max`. Each has `at`, the sweep point where the
   value occurs, for example `{"vcm": 0.4}`.
3. `<name>.min` and `<name>.max` are `measured` only when every sweep point has a value. Otherwise they are
   `failed`, with a warning. A missing point is never a pass.
4. A requirement on `<name>` uses the worst point: `.min` for `>=`, `.max` for `<=`, and both for `between`.
   The verdict row gives `at`, and the summary shows it, for example `@ vcm=0.4`.

When the result has `<name>.min` or `<name>.max`, the check uses them, also when the bench prints a
`<name> = value` line (for example from `meas` in the loop).

### Design contract

The operation `check_design` of the ngspice adapter tells what the design file can contain. It runs no
simulation. It reads the netlist in the ngspice form, with the `ngspice.*` facts of the technology pack. Put it in
`requirements.json` as an experiment, and put requirements without `conditions` on its measurements. Example:

```json
"experiments": {
  "design": {
    "adapter": "ngspice", "operation": "check_design", "environment": "eda",
    "inputs": {
      "file": "ota.spice", "subckt": "ota", "pins": ["inp", "inn", "out", "vdd", "vss", "ibias"],
      "elements": ["mos", "r", "c"], "devices": ["sg13_lv_nmos", "sg13_lv_pmos"],
      "limits": { "c_f": 2e-12 }, "technology": "ihp-sg13"
    }
  }
},
"requirements": [
  { "id": "design_errors", "experiment": "design", "measurement": "design_errors", "op": "<=", "limit": 0 },
  { "id": "area_um2", "experiment": "design", "measurement": "area_um2", "unit": "um2", "op": "<=", "limit": 1000 }
]
```

The inputs:

- `file`, `subckt` and `pins` are necessary. `pins` gives the pins of the subcircuit in their order.
- `elements` gives the permitted element kinds: `mos`, `r` and `c`. The default is all three.
- `devices` gives the devices of the technology pack that the design can instantiate. Without `devices`, the
  design can instantiate every device of the pack. A name that the pack does not have makes the run fail, so its
  rows are `not_run`.
- `limits` gives maximum values for each element: `r_ohm` for each resistor and `c_f` for each capacitor. An
  element above its limit is an error at its line.
- `technology` is the name of a technology pack, or one of the PDK names of a pack (for example `sky130A`). The
  default is the pack for `$PDK`.

The measurements:

- `design_errors`: the number of errors. Put the requirement `design_errors <= 0` on it.
- `mos_count`: the number of MOS devices, with each subcircuit instance counted.
- `gate_area_um2`: the sum of W × L × m over all MOS devices.
- `passive_area_um2`: the area of the R and C. A resistor counts as R × w_min² / R_sheet and a capacitor as
  C / density, with the facts of the technology pack for `$PDK` (`ngspice.passives`).
- `area_um2`: `gate_area_um2` plus `passive_area_um2`, that is, the MOS gate area plus the area of the ideal R and
  C from the facts of the pack. It is an estimate from the netlist, not a layout area.

When the pack has no passive facts for the R or C of the design, `passive_area_um2` and `area_um2` are not
measured, and the adapter gives a warning. A requirement on them is then `not_measured`.

The rules of the design file:

1. The file contains only `.subckt` blocks, blank lines, comments and `.end`.
2. The named block has the pins of `pins`, in the same order, and no parameters.
3. An `X` line instantiates a MOS device of the technology pack (only the `devices`, if given) or another block
   of the file. The sizes are plain numbers with an optional scale suffix, for example `w=2u`. Each size is at
   or above the minimum of the pack. The sizes follow the scale of the technology pack (`ngspice.size_unit_m`):
   with `ihp-sg13`, `w=2u` is 2 µm; the `sky130` library sets `.option scale=1.0u`, so `w=2` is 2 µm.
4. An `R` or `C` line has 4 fields and a positive value.
5. All other lines are errors: sources, `M` lines, `.model`, `.include`, `.lib`, `.param`, `.option` and
   expressions in `{}`. A block that instantiates itself is also an error.

Each error is a diagnostic with file and line. When a row of the design experiment does not pass, the summary
shows the errors before the rows.

### Frequency-domain requirements

A requirement with a `kind` reads the Touchstone output of its experiment, not a measurement:

- `kind: "s_db"`: |Sij| in dB. It needs `entry` (`[i, j]`, ports from 1), `band_hz` (`[low, high]`) and the unit
  `dB` (or no unit).
- `kind: "mu"`: the stability factor mu of a 2-port (Edwards and Sinsky), with no unit. It needs `band_hz`.
- `touchstone` (optional): the path, or the end of the path, of the file. It is necessary when the experiment wrote
  more than one Touchstone file.

The value is the worst point in the band, and the row gives its frequency in `at` (for example `{"f_hz": 3e10}`). A
band that the data does not cover gives `not_measured`, never a value from outside the data. A kind requirement has
no `measurement`.

```json
{ "id": "gain", "experiment": "sp", "kind": "s_db", "entry": [2, 1], "band_hz": [10e9, 30e9], "op": ">=", "limit": 7, "unit": "dB" }
```

### Sweep reducers

A requirement of kind `sweep` reduces one column of the sweep table of its experiment to one value. The sweep table
is an output with the role `sweep` (`{"sweep", "columns", "rows"}`): the ngspice adapter writes it from `ROW` lines,
and the xyce adapter writes it for an `hb` sweep, with `null` at a point that did not converge.

- `column`: the column of the table.
- `reduce`: `{"kind": "min"}`, `{"kind": "max"}`, `{"kind": "crossing", "level": <y>, "direction": "rising" |
  "falling" | "either"}` (the sweep value of the first crossing), or `{"kind": "compression", "db": 1}` (the sweep
  value where the column falls `db` below its first value, for example the input P1dB from a gain column).
- `table` (optional): the path, or the end of the path, of the table.

The rule for every reducer: the value is invalid when a point inside its bracket has no value. The bracket of `min`
and `max` is every point. The bracket of `crossing` and `compression` goes from the first point to the first point
at or beyond the level: an interpolation across a failed point can hide the real crossing. A failed point after the
bracket does not change the value. An invalid value gives the row `not_measured` with the point in the reason. A
level that the data does not reach is `missing`, never an extrapolated value. The measurements of the adapters
follow the same rule (for example `p1db_in_<port>_dbm` of `hb`), and a failed measurement shows its reason in
the summary.

```json
{ "id": "ip1db", "experiment": "hb", "kind": "sweep", "column": "gain_out_db", "reduce": { "kind": "compression", "db": 1 }, "op": ">=", "limit": -5, "unit": "dBm" }
```

### Stability gate

An RF block lists its active stages in `gates.stability`. The check then adds one gate row per stage and
condition:

```json
"gates": { "stability": { "stages": ["lna1", "lo_buffer"], "conditions": ["tt", "ss", "ff"], "band_hz": [1e9, 300e9] } }
```

1. Give each stage a requirement of kind `mu` with `stage` set to its name, `op` `>=` and a limit of at least 1.
2. Make its `band_hz` contain the gate band (default 1 GHz to 300 GHz), and give it each condition of the gate.
3. Run the check. A gate row takes the worst of the mu rows that cover it. Without such a row, the gate row is
   `not_run` with the stage, band and condition in the reason, so the block cannot pass without the record.

### Monte Carlo rows

The ngspice operation `monte_carlo` runs one ngspice batch run per seed with the mismatch models of the PDK. It
replaces each lib section by its mismatch section (IHP: `<corner>_mismatch`) and adds the instance parameter of the
technology pack (IHP: `mm_ok=1`; without it the IHP models give no mismatch) to each PDK device of the deck and of the
files that it includes from the design root. The default options are `reltol=1e-3` and `itl1=1000` (registry entry
`ngspice-sg13g2-mc-reltol`). Each seed is `ok`, `no_dc` or `failed`; work/mc.json keeps every seed. A row of kind
`monte_carlo` reads that table:

```json
{ "id": "offset_3s", "experiment": "mc", "kind": "monte_carlo", "measurement": "offset_v",
  "statistic": "mean_abs_k_sigma", "k": 3, "op": "<=", "limit": 0.02, "conditions": ["tt", "slow_hot"] }
```

1. `statistic` is `mean`, `sigma` (n − 1), `min`, `max`, `abs_max` (the row names the seed), `mean_abs_k_sigma`
   (|mean| + k σ), `mean_plus_k_sigma` or `mean_minus_k_sigma`; `k` is 3 by default.
2. A seed without a value (for example no DC point) makes the row `not_measured` with the seeds in the reason. A
   seed is never dropped.
3. Fewer seeds than `min_seeds` (default 30), or the same value in every seed (mismatch not active), are also
   `not_measured`. The operation itself fails when no measurement varies.

On the detector cell of the R2 design (tt, 60 seeds, simulated) the operation gives an offset σ of 3.88 mV; the R2
record has σ 4.07 mV from 198 seeds.

### Operating-limit gate

`gates.limits` makes the check run the ngspice operation `device_limits` for each experiment of the gate and each
condition of its rows, with the same deck, libs, params and temperature:

```json
"gates": { "limits": { "extra_limits": [ { "id": "hbt_vce_min", "class": "hbt", "quantity": "vce", "op": ">=",
  "limit": 0.5, "assumption": "vce_min" } ], "tran": { "bench": { "step_s": 2e-13, "stop_s": 8e-8, "start_s": 1.5e-8 } } } }
```

1. The experiments are every ngspice `simulate` experiment that a requirement cites, unless `experiments` lists them.
   An experiment of the list that no selected row cites (for example a DC bench for the gate only) runs at every
   condition of the check. A row without a condition (for example an EM row) adds no condition to the gate.
2. The limits come from the technology pack (`ngspice.limits.<pdk>`), each with its PDK source. For IHP SG13G2:
   V<sub>CE</sub> ≤ 1.6 V (npn13G2, npn13G2l) and ≤ 2.2 V (npn13G2v), V<sub>CB</sub> ≤ 3.8 V, V<sub>EB</sub> ≤ 1.0 V,
   V<sub>BE</sub> ≤ 1.6 V, I<sub>C</sub> per emitter ≤ 3.5 mA / 3.0 mA / 0.5 mA, MOS |V<sub>DS</sub>| and
   |V<sub>GS</sub>| ≤ 1.6 V (LV) and 3.0 V (HV). The limit "no reverse DC base current" has no PDK source; it is
   marked assumed and its rows cite the assumption `limit_hbt_ib_reverse`.
3. `extra_limits` adds design limits; each gives a source or cites an assumption of the file.
4. `tran` gives a transient per experiment: the gate also checks the peak voltages over it (the peak V<sub>CE</sub>
   is a conservative bound from the extremes of V<sub>BE</sub> and V<sub>BC</sub>). Transient currents are not
   checked: the VBIC instance currents include the junction charge currents. With `"dc": "mean"` in the `tran` entry
   of an experiment, the "dc" values are time means over whole periods inside the transient window (from the first to
   the last rising crossing of the device's own V<sub>BE</sub> through its mean) instead of the operating point of the
   deck. Use it for an oscillator: its deck ramps the supply from 0 V, so its operating point has no bias, and its
   cycle means are its DC values. Over whole periods the mean of a junction charging current is zero, so the mean
   terminal currents are exact; over a window of 31.2 periods the mean base current of a 61 GHz core was off by up to
   10 µA (a false reverse base current).
   `peak_overrides` (`[{id, limit, assumption}]`) gives a limit of the pack another value at the peak only, for
   example a peak V<sub>CE</sub> above 1.6 V in an oscillator core; each override cites an assumption of the file,
   and its peak rows cite it.
5. An xyce `hb` experiment of the gate (by default every `hb` experiment that a requirement cites) runs the xyce
   operation `hb_limits` with all its inputs: the same harmonic balance, with the terminal voltages and the lead
   currents of each HBT. The limits apply to the cycle means (rows `gate limits <id>`: V<sub>CE</sub>, V<sub>BE</sub>,
   I<sub>C</sub> per emitter, the cycle-mean base current) and, with one tone, to the peak voltages over one period
   (rows `gate limits <id> peak`; the peak V<sub>CE</sub> is exact, from V<sub>C</sub> − V<sub>E</sub> at the same
   time). Each sweep point is checked. The instantaneous conduction currents are not checked: at 122 GHz the lead
   currents include the junction charging currents (registry `xyce-sg13g2-hb-terminal-currents`); their cycle means
   are exact.
6. One row per limit and per experiment and condition takes the worst device and names it. A run without its limits
   table gives a row that is `not_run`, so the check cannot pass.

### Netlist gate

`gates.netlist` checks the design file against device rules, with the same kernel function (`checkNetlist`) that
the evaluation scorers use. The check adds one row (`gate netlist`, the count of rule errors, limit 0):

```json
"gates": { "netlist": { "file": "lna.spice", "subckt": "lna", "pins": ["rfin", "rfout", "vcc18"],
  "devices": ["npn13G2", "cap_cmim", "rppd"], "given": { "tm2_w6": { "params": { "len": { "min": 1e-9, "max": 1e-3, "required": true } } } },
  "wiring": { "r_ohm": 50, "l_h": 5e-11, "c_f": 5e-14 }, "fitted": true, "em_passives_min": 1, "technology": "ihp-sg13" } }
```

1. An X line of a device of `devices` may set only the instance parameters of its class in the technology pack
   (`ngspice.instance_params.<pdk>.classes`, taken from the PDK model cards; IHP SG13G2: HBT `Nx`, `Ny`, `m`; MIM `w`,
   `l`, `m`; resistors `w`, `l`, `b`, `m`; MOS `w`, `l`, `ng`, `m` and the diffusion geometry). A parameter that
   changes the device physics (for example `selft`, `dtemp`, `mm_ok`, `trise`) is an error with its meaning, unless
   `allow_params` names it for that device. `allow_params` can also give the only permitted values, as a named,
   declared setting: `{"npn13g2": {"sw_nqs": [1]}}` (another value is an error). `require_params` makes a setting
   necessary on every instance of the device: `{"npn13g2": {"sw_nqs": 1}}`. Example: in ngspice the IHP SG13G2 HBT has
   the excess phase off by default (`sw_nqs=0`); the Xyce card has it on (registry `ngspice-sg13g2-hbt-sw-nqs`).
2. Values may be numbers, numbers with a SPICE suffix, or `{expressions}` of `.param` values of the file.
3. A block whose element lines equal a subcircuit of a completed `fit_to_spice` record (output unchanged) is a fitted
   model: its sources are allowed. `em_passives_min` counts the fitted models whose Touchstone input is an openEMS
   output.

### Fit-band gate

When the design root has `fit_to_spice` records, the check reads the band of use of each (`uses.band_hz`,
`uses.dc`, `uses.noise_band_hz`) and adds one row (`gate fit_band <subckt>`) per bench and fitted model that the bench
uses. The row fails when an `ac`, `sp` or `noise` sweep goes outside the band of use (the model is an extrapolation
there), when the fit is for AC only and the bench solves a DC point, or when a noise analysis uses a model without
port noise or outside its noise band. A transient is not checked; the reason names it.

### Limit sources

A requirement or an extra limit can carry `limit_source`: `{ "kind": "specification" | "pdk" | "reference_design" |
"task", "ref": "..." }`. The kind `reference_design` marks a limit that was set after a reference run: the reference
passes it by construction.

### Stability diagnosis

When a `mu` row fails, the ngspice operation `stability_diagnosis` (inputs: the S-parameter bench, the Touchstone file
that it wrote, and the inputs of the failed condition) gives the frequency of the worst μ, the bands with μ < 1, Zin and
Zout of the stage, the driving-point impedance of each node of the bench and of the device blocks near that frequency
(the RF ports as Z0 resistors, a 1 A AC current into one node at a time), the nodes with Re Z < 0 or a resonance there,
their elements, and the pairs of an ideal L and a capacitor that resonate within ±30 %. On the failed LNA of the step-6
pilot (μ −0.93 at 57 GHz) it gives Re Zin −34.4 Ω and a resonance at 61 GHz on the base node of the first HBT, whose
elements include a 150 µm base-bias line: the cause that the agent found by hand.

### Query the records

`npx simra query` and the pi tool `query_results` give a table of the recorded results without a script: the
measurements of the experiments (newest first; filters `--experiment`, `--condition`, `--measurement` (text or
`/regex/`), `--operation`, `--status`), or the rows of a check (`--source checks`, `--check <id>`, `--requirement`).

### Assumptions

A row can depend on a stated assumption, for example a system level that no block measures. Define it once and
cite its id:

```json
"assumptions": { "tx_leak": { "description": "TX leakage at the LNA input", "value": -34, "unit": "dBm", "source": "level plan" } }
```

A requirement, an experiment template or a condition cites it in `"assumptions": ["tx_leak"]`. Each verdict row
lists the assumptions of its requirement, its experiment and its condition (`{assumes tx_leak}` in the summary). To
see what a change of an assumption affects, run `npx simra assumptions [<id>]` or the pi tool `assumption_rows`. It
lists each requirement that depends on the assumption, and how (requirement, experiment or condition), and the rows of
the newest check with their status, when that check used the current requirements file.

## Read a layout

To read a layout, the agent calls `run_experiment` with the adapter `klayout`, the operation `query` and several
questions in one call: for example the layers, the cell tree, the shapes and instances at a DRC marker box, or the
distance between two shapes. The answers are short rows in µm, in the summary of the experiment, and the full
answer is in `work/query.json`. The run is recorded like a deck run, with the hash of the layout.

To see what an edit or a commit changed, the agent calls the operation `diff`: the new layout against a file or
against `git:<ref>`. The answer gives, per layer, the area added and removed and the largest polygons with their cell
path, then the changed cells. With the ids of two `drc` runs, it also gives the new, fixed and unchanged markers of
each rule. To see a region or a DRC marker, the agent calls the operation `render`: a box, or the id of a `drc` run
and a rule. The picture (PNG, in the colours of the PDK, the marker outlined in red) comes with the result of
`run_experiment` as an image, after the summary. The prompt rules tell the agent to ask for a picture when the marker
boxes and the shapes do not tell which edge to move, and to write Python only to change a layout. See
[adapters/klayout/README.md](adapters/klayout/README.md).

## Layout

| Path | Contents |
| --- | --- |
| `packages/kernel/` | runner, experiment records, environments, PDF reader, `simra` CLI (no pi dependency) |
| `packages/pi-extension/` | the pi extension (the only package that imports pi) |
| `adapters/ngspice/` | ngspice adapter (Python) and its tests; `design_check.py` has the operation `check_design` |
| `adapters/klayout/` | klayout adapter (Python) and its tests: DRC and LVS with the stock KLayout decks of the PDK, with typed verdicts, questions about a layout (`query`), the comparison of two layouts (`diff`) and pictures of a region or a marker (`render`) |
| `adapters/touchstone/` | touchstone adapter (Python, numpy) and its tests: a passive rational model of a Touchstone file as a SPICE subcircuit (`fit_to_spice`) |
| `adapters/xyce/` | xyce adapter (Python) and its tests: `parse` (model gaps), `simulate` and `hb` (harmonic balance) |
| `technologies/` | technology packs: the PDK facts that adapters need |
| `examples/ota-sg13g2/` | two-stage OTA for IHP SG13G2 |
| `evals/` | demo evaluations for the inner development loop (not decision benchmarks): the OTA at 3 corners, the OTA against a PVT spec, OTA synthesis from a pin specification (`ota-synthesis`), comparator synthesis from a pin specification (`comparator-synthesis`), their scorers and an arm runner. `synthesis-family.mjs` makes variants of the two synthesis tasks with tighter limits, from a hidden target design and a difficulty factor |
| `evals/rf-passive-gain/` | demo RF task (not a decision benchmark): the gain of an amplifier deck with a matching network that exists only as a Touchstone file; PDK-free |
| `evals/layout-drc-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a small analog cell, with the stock KLayout DRC and LVS decks, on IHP SG13G2 and SKY130 |
| `evals/layout-clean/` | demo layout task (not a decision benchmark): verify the same cell without violations, with no false alarm and no needless edit |
| `evals/layout-block-fix/` | demo layout task (not a decision benchmark): fix the seeded DRC violations of a hierarchical analog block (10012 devices, four levels of cells), on IHP SG13G2 (full DRC rule set, density included) and SKY130 |
| `evals/layout-false-pass/` | demo layout task (not a decision benchmark): verify the clean block with an LVS script that prints a match and then crashes; the agent must report the LVS check as not run |
| `evals/layout-long-job/` | demo layout task (not a decision benchmark): the block of layout-block-fix, flat and larger (21487 devices), so that one deck run takes minutes; the score reports how the agent ran the long decks (background runs, waits, log reads) |
| `evals/layout-stale-state/` | demo layout task (not a decision benchmark): the task of layout-block-fix, and during the run a colleague, not announced in the prompt, commits a new `block.gds` (two rules fixed, one new violation, one change to keep); the score checks that every reported number comes from the final `block.gds` and that the change is kept |
| `container/` | environment image: Containerfile, build and check scripts |
| `test/` | smoke and integration tests |

## Licence

Apache-2.0. See [LICENSE](LICENSE). See [NOTICE](NOTICE) for the credit to pi (MIT).
