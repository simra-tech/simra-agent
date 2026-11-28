# Example: a small accumulator (digital, IHP SG13G2)

`src/acc.v` is a 16 x 16 bit multiplier with a 32-bit accumulator: about 1500 standard cells and 64 flip-flops.
`config.json` is a LibreLane configuration for the IHP SG13G2 PDK with a 7.1 ns clock.

Run the flow to global routing:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag grt --to OpenROAD.STAMidPNR-3 config.json
```

On 2 CPUs this takes about one minute (LibreLane 3.1.0.dev2).

## Required corners

`requirements.json` declares the three corners that the block must pass (`gates.corners`) and two requirements, the
worst setup slack and the worst hold slack, at each corner.

1. Run the flow to the timing step before the layout:
   ```
   librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag syn --to OpenROAD.STAPrePNR config.json
   ```
2. Run `npx simra check`. The check reads the run (`librelane` adapter, operation `read`); it starts no tool.

Result of 2026-11-28 (LibreLane 3.1.0.dev6, image `hpretl/iic-osic-tools:2026.11`, timing without wires): the block
passes at the typical corner (setup 2.026 ns, hold 0.046 ns). The setup slack fails at the slow corner (-0.756 ns), and
the hold slack fails at the fast corner (-0.049 ns). So the check is `FAIL`, with a gate row for each corner.

A flow that analyses the typical corner only (`"STA_CORNERS": ["nom_typ_1p20V_25C"]` in the configuration) has no
number for the two other corners. The check is then `INCOMPLETE`: the gate rows of the slow and the fast corner are
`NOT_RUN`. The pass at the typical corner does not cover them.

The digital flow tasks in `evals/flow-*` use this design.
