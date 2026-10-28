# Two-stage OTA, IHP SG13G2

A two-stage Miller OTA for the open IHP SG13G2 PDK (low-voltage MOS devices, VDD = 1.2 V).

| File | Contents |
| --- | --- |
| `ota.spice` | the OTA subcircuit |
| `tb_ota.spice` | open-loop testbench, without a model library and without analyses |
| `simra.config.json` | the execution environment `eda`: ngspice and the PDK in a container |

Reference values for 3 corners are in [evals/ota-corners/expected.json](../../evals/ota-corners/expected.json).

## Set up the environment

The environment `eda` uses podman and the image `docker.io/hpretl/iic-osic-tools:2026.07` (ngspice 46, IHP
SG13G2). To use a different image, or to pin the image ID and the CPUs, write `simra.local.json` in this
directory. Git ignores this file.

```json
{ "environments": { "eda": { "image": "my-eda-image:latest", "image_id": "sha256:...", "cpus": "0-3" } } }
```

If you set `image_id`, the runner stops when the image has a different ID.

## Run one corner

1. Write a deck that includes `tb_ota.spice` and adds the analyses, for example `ac.spice`:

   ```
   .include "tb_ota.spice"
   .control
   ac dec 100 1 10G
   meas ac gain_db find vdb(out) at=1
   meas ac ugf_hz when vdb(out)=0
   .endc
   ```

2. Write `run.json`:

   ```json
   {
     "adapter": "ngspice",
     "operation": "simulate",
     "environment": "eda",
     "purpose": "open-loop gain at tt",
     "inputs": {
       "deck": "ac.spice",
       "libs": [{ "path": "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models/cornerMOSlv.lib", "section": "mos_tt" }],
       "measurements": { "gain_db": "dB", "ugf_hz": "Hz" }
     }
   }
   ```

3. Run `npx simra run run.json` in this directory.
4. Run `npx simra show <id>` to read the record again.

In pi, the agent calls the tool `run_experiment` with the same fields.
