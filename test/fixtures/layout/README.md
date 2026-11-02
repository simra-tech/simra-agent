# Fixtures of the layout tasks

These files come from runs of the wrappers `drc.sh` and `lvs.sh` of `evals/layout-drc-fix/<pdk>/`,
`evals/layout-block-fix/<pdk>/` and `evals/layout-false-pass/<pdk>/` in the container image, with the workspace at
`/work`. `test/layout-score.test.mjs` and `test/layout-block-score.test.mjs` read them.

| File | Source |
| --- | --- |
| `drc-sg13g2-seeded.lyrdb` | the marker database of the seeded cell (IHP SG13G2), with only the categories that have markers |
| `drc-sky130-seeded.lyrdb` | the marker database of the seeded cell (SKY130), with only the categories that have markers |
| `lvs-<pdk>-match.log` | the end of the deck log of the clean cell (the netlists match) |
| `lvs-<pdk>-mismatch.log` | the end of the deck log of the cheat cell (the netlists do not match) |
| `lvs-sg13g2-match-crash.log` | `lvs-sg13g2-match.log` with a crash line at the end (made by hand) |
| `drc-sg13g2-pass-crash.log` | the end of the DRC deck log of the clean cell (IHP SG13G2), with a crash line at the end (made by hand) |
| `drc-block-<pdk>-seeded.lyrdb` | the marker database of the seeded block of layout-block-fix, with only the categories that have markers |
| `lvs-block-<pdk>-match.log` | the end of the deck log of the clean block (the netlists match) |
| `lvs-block-<pdk>-broken.out` | the output of the broken `lvs.sh` of layout-false-pass on the clean block: the printed match, then `Segmentation fault` (exit code 139) |

The full marker databases are 40 kB to 120 kB, because they list all rule categories of the deck. The fixtures keep
the items unchanged and remove the categories that have no markers. The parser reads only the items.
