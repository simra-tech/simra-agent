# Write a variant of the layout-stale-state task on SKY130 (see ../stale.py): the block of layout-block-fix
# (../../layout-block-fix/sky130/generate.py, the same circuit, pins, sizes and seeds), before and after the commit
# of the colleague. Run in the environment image:
#   python3 generate.py --variant <v1-seeded|v2-seeded|v2-clean|v1-clean> --out <gds>   (prints the SHA-256)
#   python3 generate.py --info   (prints the facts of the change and of the new seed as JSON)

import importlib.util
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, ".."))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


blockgen = _load("blockfix_sky130", os.path.join(here, "../../layout-block-fix/sky130/generate.py"))

import stale  # noqa: E402


class StaleSKY130Block(blockgen.SKY130Block):
    # The new seed top_via2_pairs (Via2 200 nm; spacing rule via2.2 0.2 um): the bad and the legal space between the two
    # Via2 of a pair, the Metal3 enclosure of the pair, and the pitch of the pairs on the vss link.
    BAD_V2_S = 120
    GOOD_V2_S = 300
    PAIR_ENC = 150
    PAIR_PITCH = 2000
    # The change of the colleague: the ibias stub is WIDEN wider (2 um to 3 um). The kept check compares Metal2 in
    # the change box enlarged by CHECK_MARGIN.
    WIDEN = 1000
    CHECK_MARGIN = 500


if __name__ == "__main__":
    stale.main(StaleSKY130Block(), sys.argv[1:])
