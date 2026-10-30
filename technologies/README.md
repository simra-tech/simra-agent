# Technology packs

A technology pack holds the facts about a PDK that an adapter needs. The harness core and the adapters do not
contain PDK facts. Each directory has one `technology.json` (schema `simra.technology/0`):

| Field | Contents |
| --- | --- |
| `name` | the name of the pack; the same as the directory |
| `pdks` | the values of `$PDK` that the pack applies to |
| `ngspice.operating_point.device_letter` | the letter of the MOS devices in the ngspice `show` command (`m` for BSIM, `n` for OSDI models) |
| `ngspice.operating_point.params` | the ngspice parameter name of `vgs`, `vth`, `vds`, `vdsat`, `id`, `gm` and `gds` |

| Pack | PDKs | MOS model |
| --- | --- | --- |
| `ihp-sg13` | `ihp-sg13g2`, `ihp-sg13cmos5l` | PSP 103 (OSDI) |
| `sky130` | `sky130A`, `sky130B` | BSIM4 |

The kernel gives the directory to the adapter in `SIMRA_TECHNOLOGY_DIR`. A container environment mounts it
read-only at the same path.

To add a PDK:

1. Run an operating point with ngspice, then `show <letter> : all`.
2. Find the names of the seven parameters in the output.
3. Write `<name>/technology.json`.
4. Add a fixture of the `show` output to the adapter tests.
