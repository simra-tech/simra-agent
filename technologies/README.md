# Technology packs

A technology pack holds the facts about a PDK that an adapter needs. The harness core and the adapters do not
contain PDK facts. Each directory has one `technology.json` (schema `simra.technology/0`):

| Field | Contents |
| --- | --- |
| `name` | the name of the pack; the same as the directory |
| `pdks` | the values of `$PDK` that the pack applies to |
| `ngspice.operating_point.device_letter` | the letter of the MOS devices in the ngspice `show` command (`m` for BSIM, `n` for OSDI models) |
| `ngspice.operating_point.params` | the ngspice parameter name of `vgs`, `vth`, `vds`, `vdsat`, `id`, `gm` and `gds` |
| `ngspice.size_unit_m` | the length in metres of a size without a suffix (`1e-06` when the library sets `.option scale=1.0u`) |
| `ngspice.size_unit_source` | the PDK file that gives `size_unit_m` |
| `ngspice.passives.<pdk>` | the area of the ideal R and C of a design (operation `check_design` of the ngspice adapter), for one value of `$PDK` |
| `...<pdk>.r.device` | the high-resistance poly resistor of the PDK that the ideal resistor stands for |
| `...<pdk>.r.sheet_ohm`, `.width_min_m` | its sheet resistance (Ω/sq) and its minimum width (m); a resistor R has the area R × w_min² / R_sheet |
| `...<pdk>.c.device` | the densest capacitor of the PDK (MIM, when the PDK has it) that the ideal capacitor stands for |
| `...<pdk>.c.density_f_per_m2` | its capacitance density (F/m²); a capacitor C has the area C / density |
| `...<pdk>.r.source`, `.c.source` | the PDK files (relative to `$PDK_ROOT`) and the facts in them that give the values |
| `ngspice.devices` | the MOS devices that a design can instantiate, by subcircuit name (operation `check_design` of the ngspice adapter) |
| `ngspice.devices.<name>.kind` | `nmos` or `pmos` |
| `ngspice.devices.<name>.terminals` | the terminal names, in the order of the `X` line |
| `ngspice.devices.<name>.params` | the instance parameters that a design can give; all other parameters are errors |
| `...params.<p>.role` | `width`, `length`, `fingers` or `multiplier`; the gate area uses these roles |
| `...params.<p>.required` | `true` when each instance must give the parameter |
| `...params.<p>.size` | `true` for a length: the value is multiplied by `size_unit_m` and compared with `min` in metres |
| `...params.<p>.per_finger` | `true` when `min` applies to the size divided by the number of fingers |
| `...params.<p>.integer` | `true` for a count; the value is an integer at or above `min` |
| `...params.<p>.min` | the minimum, in metres for a size; left out when the PDK gives no minimum |
| `...params.<p>.source` | the PDK file (relative to `$PDK_ROOT`) and the fact in it that gives the value |
| `ngspice.devices.<name>.width_total` | `true` when the width parameter is the total width of all fingers; when `false`, the gate area is multiplied by the number of fingers |
| `ngspice.devices.<name>.source` | the PDK file that defines the device subcircuit |

| Pack | PDKs | MOS model |
| --- | --- | --- |
| `ihp-sg13` | `ihp-sg13g2`, `ihp-sg13cmos5l` | PSP 103 (OSDI) |
| `sky130` | `sky130A`, `sky130B` | BSIM4 |

The `sky130` pack has `ngspice.passives` only for `sky130A`. The image has no `sky130B` files to cite.

The kernel gives the directory to the adapter in `SIMRA_TECHNOLOGY_DIR`. A container environment mounts it
read-only at the same path.

To add a PDK:

1. Run an operating point with ngspice, then `show <letter> : all`.
2. Find the names of the seven parameters in the output.
3. In the model library of the image, find the MOS device subcircuits. For each device, write its terminals
   and its instance parameters (width, length, fingers, multiplier).
4. Find whether the library sets `.option scale`. Write `size_unit_m`.
5. Find the minimum width and length of each device: the model limits (for example `wmin`, `lmin` of the
   bins) and the design rules. Write the value with its `source`. When the PDK gives no minimum, leave out
   `min`.
6. Run a short ngspice operating point to find whether the width is the total width of all fingers, and
   whether the multiplier changes the current. Write `width_total`.
7. Find the high-resistance poly resistor and the densest capacitor (MIM, if the PDK has it) for each PDK of
   the pack. Write their sheet resistance, minimum width and capacitance density in `ngspice.passives`, with the
   sources. Without these facts, the area of a design with R or C is not known.
8. Write `<name>/technology.json`.
9. Add a fixture of the `show` output to the ngspice adapter tests, and a `check_design` test of a design of
   the new PDK to `adapters/ngspice/test_design_check.py`.
