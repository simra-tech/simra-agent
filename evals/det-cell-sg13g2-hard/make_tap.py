#!/usr/bin/env python3
"""Make a reference tap layout for the det-cell-sg13g2-hard task, cell "tap", IHP SG13G2 GDS layers.

The tap: a TopMetal2 line (134/0, 200 um x 13 um, x = 0 to 200 um, centred on y = 0) over a Metal1 ground (8/0,
200 um x 120 um). At x = 100 um a TopMetal2 spur (w_spur x l_spur um) leaves the line edge towards -y and ends on a
TopVia2 (133/0) to a TopMetal1 pad (126/0). The pad covers a MIM (36/0, side mim_um) on a Metal5 plate (67/0); the
Metal5 plate runs to the port 3 point at (100, -40) um. The ports of the task: 1 at (0, 0) and 2 at (200, 0) from
Metal1 to TopMetal2; 3 at (100, -40) from Metal1 to Metal5.

Usage: make_tap.py <out.gds> [mim_um, default 1.3] [l_spur um, default 12] [w_spur um, default 4]
"""
import datetime
import sys

import gdstk

out = sys.argv[1]
mim = float(sys.argv[2]) if len(sys.argv) > 2 else 1.3
l_spur = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
w_spur = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0
lib = gdstk.Library(unit=1e-6, precision=1e-9)
c = lib.new_cell("tap")
c.add(gdstk.rectangle((0, -6.5), (200, 6.5), layer=134))
c.add(gdstk.rectangle((0, -60), (200, 60), layer=8))
y_end = -6.5 - l_spur
c.add(gdstk.rectangle((100 - w_spur / 2, y_end), (100 + w_spur / 2, -6.5), layer=134))
# TopVia2 (0.9 um square, 4 of them) and the TopMetal1 pad under the spur end
pad = max(w_spur, mim + 1.0)
yp0, yp1 = y_end, y_end + 3.0
c.add(gdstk.rectangle((100 - 0.45, yp0 + 1.0), (100 + 0.45, yp0 + 1.9), layer=133))
c.add(gdstk.rectangle((100 - pad / 2, y_end - mim - 1.0), (100 + pad / 2, yp1), layer=126))
# MIM under the pad, on the Metal5 plate; the plate runs to port 3 at (100, -40)
ym1 = y_end - 0.5
c.add(gdstk.rectangle((100 - mim / 2, ym1 - mim), (100 + mim / 2, ym1), layer=36))
c.add(gdstk.rectangle((100 - mim / 2 - 0.6, -40.0), (100 + mim / 2 + 0.6, ym1 + 0.6), layer=67))
lib.write_gds(out, timestamp=datetime.datetime(2026, 1, 1))
