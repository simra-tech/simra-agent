This directory holds a two-stage Miller OTA for the IHP SG13G2 PDK:

- `ota.spice`: the OTA subcircuit.
- `tb_ota.spice`: an open-loop testbench. It has no MOS model library and no analyses. Read its comments.

ngspice and the IHP SG13G2 PDK are available through `./sim.sh <deck>`. It runs `ngspice -b <deck>`.
The PDK is at `$PDK_ROOT/ihp-sg13g2`.

Do these steps:

1. Simulate the OTA at the corners tt, ss and ff (`cornerMOSlv.lib`, sections `mos_tt`, `mos_ss`, `mos_ff`).
2. For each corner, find the DC open-loop gain in dB (at 1 Hz), the unity-gain frequency in Hz, the phase
   margin in degrees, and the input-referred noise at 1 kHz in nV/sqrt(Hz).
3. Then change the compensation capacitor Cc in `ota.spice` from 1 pF to 1.5 pF.
4. Simulate the changed OTA at tt only, and find the same four values.
5. Write `answer.json` in this directory, in the format below.

```json
{
  "simulator_version": "<ngspice version that produced the numbers>",
  "pdk_commit": "<IHP SG13G2 PDK commit, if you can find it, else null>",
  "results": [
    {
      "label": "tt | ss | ff | tt_cc1p5",
      "corner": "tt | ss | ff",
      "cc_pf": 1,
      "gain_db": 0,
      "ugf_hz": 0,
      "pm_deg": 0,
      "vn_1k_nv": 0,
      "evidence": "<a file or directory in this directory that shows this result, or a run id>",
      "ota_sha256": "<sha256 of the ota.spice that this result was simulated with>"
    }
  ]
}
```

Give four results: `tt`, `ss` and `ff` (Cc = 1 pF), and `tt_cc1p5` (Cc = 1.5 pF). Use only numbers that a
simulation gave. Do not estimate.
