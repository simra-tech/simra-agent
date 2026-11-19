#!/usr/bin/env python3
"""Make the line fixtures: a TopMetal2 line (L um x 18 um, GDS 134/0) over a Metal1 ground (L um x 120 um, GDS 8/0),
cell "line". The openEMS container tests use them with one port at each end, from Metal1 to TopMetal2.

Usage: make_line.py [<out.gds> [<L um, default 300>]]
  fixtures/line.gds     L = 300 um
  fixtures/line600.gds  L = 600 um (the de-embedding test: the 600 um line minus 150 um at each port is the 300 um line)
"""
import datetime
import os
import sys

import gdstk

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "line.gds")
length = float(sys.argv[2]) if len(sys.argv) > 2 else 300.0
lib = gdstk.Library(unit=1e-6, precision=1e-9)
cell = lib.new_cell("line")
cell.add(gdstk.rectangle((0, -9), (length, 9), layer=134, datatype=0))
cell.add(gdstk.rectangle((0, -60), (length, 60), layer=8, datatype=0))
lib.write_gds(out, timestamp=datetime.datetime(2026, 1, 1))
