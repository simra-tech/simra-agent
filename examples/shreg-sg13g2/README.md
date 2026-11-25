# Example: a shift register bank (digital, IHP SG13G2)

`src/shreg.v` is a bank of shift registers with a reset: 144 chains of 500 flip-flops (72,000 flip-flops). Each
flip-flop drives the next one, so that the block has many short flop-to-flop paths. `shreg.sdc` has a hold
uncertainty of 0.45 ns. `config.json` is a LibreLane configuration for the IHP SG13G2 PDK with a 10 ns clock.

The flow with the default settings stops at the timing repair after the clock tree synthesis (step
`OpenROAD.ResizerTimingPostCTS`): the hold repair reaches its maximum buffer count (message RSZ-0060).

```
librelane --manual-pdk --pdk-root $PDK_ROOT --pdk ihp-sg13g2 --run-tag r1 config.json
```

On 2 CPUs the flow takes about 17 minutes to that step (LibreLane 3.1.0.dev2).

The digital flow tasks `evals/flow-step-replay` and `evals/flow-repair-progress` use this design; the second one
uses 24 chains without a reset and a hold uncertainty of 0.70 ns.
