#!/usr/bin/env python3
"""Make fixtures/line.gds: a TopMetal2 line (300 um x 18 um, GDS 134/0) over a Metal1 ground (300 um x 120 um, GDS 8/0),
cell "line". The openEMS container test uses it with one port at each end, from Metal1 to TopMetal2."""
import datetime
import os
import sys

import gdstk

lib = gdstk.Library(unit=1e-6, precision=1e-9)
cell = lib.new_cell("line")
cell.add(gdstk.rectangle((0, -9), (300, 9), layer=134, datatype=0))
cell.add(gdstk.rectangle((0, -60), (300, 60), layer=8, datatype=0))
lib.write_gds(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "line.gds"), timestamp=datetime.datetime(2026, 1, 1))
