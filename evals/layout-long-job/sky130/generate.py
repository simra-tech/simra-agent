# Write the GDS (or the reference netlist) of the flat block of the layout-long-job task on SkyWater SKY130 (sky130A). The block is
# the block of layout-block-fix (../../layout-block-fix/sky130/generate.py, the same circuit, pins and sizes), flat:
# ../../layout-block-fix/block.py builds the hierarchy, flattens it into the top cell, and then draws the seeds of
# the repeated cells on a few copies only (FLAT_SITES). The seeds of the top cell are the ones of layout-block-fix.
# Run in the environment image:
#   python3 generate.py --variant <clean|seeded|cheat> --out block.gds   (prints the SHA-256 of the GDS)
#   python3 generate.py --spice --out block.spice   (the flat reference netlist)
#   python3 generate.py --info   (prints the facts of the block: devices, size, seeds)

import importlib.util
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "../../layout-block-fix"))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


blockgen = _load("blockfix_sky130", os.path.join(here, "../../layout-block-fix/sky130/generate.py"))

import block  # noqa: E402


class FlatSKY130Block(blockgen.SKY130Block):
    FLAT = True
    # Branch k of the array has 81 x 2^k units (the base shapes times 9 x 9; devices = 255 * 9 * 9 + 832 = 21487),
    # not the 36 x 2^k of layout-block-fix (6 x 6): a larger flat block makes the slow deck take 3 minutes or more.
    SCALE = (9, 9)
    # The seeds of the repeated cells and the count of seeded copies: a few of the 21487 units, one of the two
    # arrays of the input pair.
    FLAT_SITES = {"unit_via1": 4, "unit_m1_spur": 4, "pair_rail_neck": 1}


if __name__ == "__main__":
    block.main(FlatSKY130Block(), sys.argv[1:])
