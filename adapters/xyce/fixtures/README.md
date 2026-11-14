# Fixtures of the Xyce adapter tests

Excerpts of Xyce 7.10 output (`Xyce Release 7.10-opensource`). The PDK paths are shortened to `/pdk/...`.

| File | Source |
| --- | --- |
| `norun-psp.log` | `Xyce -norun` of a deck with the IHP SG13G2 Xyce libraries (`cornerMOSlv.lib mos_tt`, `cornerHBT.lib hbt_typ`), one `sg13_lv_nmos` and one `npn13G2` |
| `norun-bsim4.log` | `Xyce -norun` of a deck with the SKY130A ngspice library (`sky130.lib.spice tt`), one `sky130_fd_pr__nfet_01v8` |
| `norun-missing.log` | `Xyce -norun` of a deck with an unknown MOS level and two devices without a model card |
| `temp-ignored.log` | a deck with `.temp 50` and an illegal `.measure` name |
| `hb-cubic.csv` | `.print hb_fd format=csv` of `v(out) = 2 v(a) + 0.4 v(a)^3`, `v(a) = 0.25 cos(2 pi 1e9 t)`, and `i(vcc)` of 1.5 V into 1 kohm |
| `measure.mt0` | the `.measure` file of a transient run: one value, an `AT` outside the run, a `WHEN` that does not occur |
