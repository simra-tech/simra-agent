# The kept check of the layout-stale-state task: compare one layer of a GDS with the same layer of the reference
# (v2-clean.gds) inside one box, and print the result as JSON: the area of the XOR, and the area of the layer in the
# box in each file (um2). The change of the colleague is kept when the XOR is empty. The shapes come from the top
# cell and all its children (flat).
#
# Usage: python3 kept.py --gds <gds> --ref <gds> --cell <top cell> --layer <layer>/<datatype> --box x1,y1,x2,y2 (um)

import argparse
import json

import klayout.db as db


def region(path, cell, layer, box_um):
    ly = db.Layout()
    ly.read(path)
    top = ly.cell(cell)
    if top is None:
        raise SystemExit(f"{path}: no cell {cell}")
    li = ly.find_layer(*layer)
    box = db.Box(*[int(round(c / ly.dbu)) for c in box_um])
    if li is None:
        return db.Region(), box, ly.dbu
    r = db.Region(top.begin_shapes_rec_touching(li, box))
    r.merge()
    return r & db.Region(box), box, ly.dbu


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gds", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--cell", required=True)
    ap.add_argument("--layer", required=True)
    ap.add_argument("--box", required=True)
    a = ap.parse_args()
    layer = tuple(int(x) for x in a.layer.split("/"))
    box_um = [float(x) for x in a.box.split(",")]
    got, _, dbu = region(a.gds, a.cell, layer, box_um)
    ref, _, rdbu = region(a.ref, a.cell, layer, box_um)
    if dbu != rdbu:
        raise SystemExit(f"database units differ: {dbu} and {rdbu}")
    xor = got ^ ref
    um2 = lambda r: round(r.area() * dbu * dbu, 6)  # noqa: E731
    print(json.dumps({"xor_area_um2": um2(xor), "area_um2": um2(got), "ref_area_um2": um2(ref), "xor_polygons": xor.count()}))


if __name__ == "__main__":
    main()
