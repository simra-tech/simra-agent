# Device-class probe fixtures

`ihp-sg13g2.json` is the table of `simra probe --pdk ihp-sg13g2` (operation `probe_devices` of the ngspice and xyce
adapters, with the `device_probe` section of `technologies/ihp-sg13/technology.json`), made by
`test/device-probe-container.test.mjs` with `SIMRA_UPDATE_FIXTURE=1` in the environment image (ngspice 46,
Xyce 7.10, IHP SG13G2 PDK commit 84374023ee8b). The test removes the experiment ids and writes `$PDK_ROOT` for the
PDK path. The probe currents are simulated values.
