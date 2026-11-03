# Fixtures of the klayout adapter tests

These files come from runs of the PDK decks in the container image, on the blocks of `evals/layout-block-fix/<pdk>/`,
with the workspace at `/work`. `test_klayout_adapter.py` reads them.

| File | Source |
| --- | --- |
| `drc-sg13g2-seeded.lyrdb` | the marker database of the seeded block (IHP SG13G2, rule set `full`), with only the categories that have markers |
| `drc-sg13g2-truncated.lyrdb` | the first half of `drc-sg13g2-seeded.lyrdb` (made by hand) |
| `drc-sky130-seeded.lyrdb` | the marker database of the seeded block (SKY130, rule set `main`), with only the categories that have markers |
| `drc-sky130-clean.lyrdb` | the marker database of the clean block (SKY130), with three of its categories and no items |
| `lvs-sg13g2-match.log` | the end of the LVS deck log of the clean block (the netlists match) |
| `lvs-sg13g2-mismatch.log` | the end of the LVS deck log of the cheat block (the netlists do not match) |
| `lvs-sky130-mismatch.log` | the end of the LVS deck log of the cheat block (SKY130) |
| `lvs-sg13g2-broken.log` | the deck log of the broken `lvs.sh` of `evals/layout-false-pass/sg13g2/` on the clean block: it has the match text |
| `lvsdb-sg13g2-match.json` | the output of `lvsdb_probe.py` on the LVS database of the clean block |
| `lvsdb-sg13g2-mismatch.json` | the output of `lvsdb_probe.py` on the LVS database of the cheat block, with the first 30 devices and nets |
| `lvsdb-sky130-mismatch.json` | the output of `lvsdb_probe.py` on the LVS database of the cheat block (SKY130) |
| `lvsdb-sg13g2-truncated.json` | the output of `lvsdb_probe.py` on the truncated LVS database that the broken `lvs.sh` leaves |
| `query.lyp` | a small layer properties file (made by hand) in the two name forms of the PDK files: `Metal1.drawing` and `Via1 - 19/0`, with solid colours for Metal1 (blue) and Via1 (magenta) so that the tests of `render` can check pixels; the tests of `query`, `diff` and `render` build their layouts in a temporary directory |

The tests of `drc` and `lvs` do not need KLayout. A fake KLayout binary copies a probe output, and a fake deck copies
a marker database and a log. The tests of `query` and `diff` need the KLayout Python module `klayout.db`; the tests of `render` also need `klayout.lay`.
