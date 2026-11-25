# Example: a small accumulator (digital, IHP SG13G2)

`src/acc.v` is a 16 x 16 bit multiplier with a 32-bit accumulator: about 1500 standard cells and 64 flip-flops.
`config.json` is a LibreLane configuration for the IHP SG13G2 PDK with a 7.1 ns clock.

Run the flow to global routing:

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag grt --to OpenROAD.STAMidPNR-3 config.json
```

On 2 CPUs this takes about one minute (LibreLane 3.1.0.dev2).

The digital flow tasks in `evals/flow-*` use this design.
