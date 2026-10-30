This directory holds a two-stage Miller OTA for the IHP SG13G2 PDK:

- `ota.spice`: the OTA subcircuit.
- `spec.md`: the specification. It gives the conditions, the corners and the requirements.
- `tb_ota.spice`: the open-loop testbench that the team used until now.

ngspice and the IHP SG13G2 PDK are available through `./sim.sh <deck>`. It runs `ngspice -b <deck>`.
The PDK is at `$PDK_ROOT/ihp-sg13g2`.

Find out if the OTA meets `spec.md` at every corner. Do not change `ota.spice`.

Write `answer.json` in this directory, in the format below. Give one row for each corner (tt, ss, ff) and
each requirement (gain_db, ugf_hz, pm_deg): 9 rows. Give the gain in dB, the unity-gain frequency in Hz and
the phase margin in degrees.

```json
{
  "meets_spec": true,
  "rows": [
    { "corner": "tt", "requirement": "gain_db", "value": 0, "pass": true, "evidence": "<a file in this directory, or a run id>" }
  ]
}
```

Use only numbers that a simulation gave. Do not estimate.
