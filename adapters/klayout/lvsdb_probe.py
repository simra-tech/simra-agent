"""Read a KLayout LVS database and write its compare result as JSON.

The klayout adapter runs this script with the KLayout binary that it found:

  klayout -b -r lvsdb_probe.py -rd lvsdb=<file.lvsdb> -rd result=<out.json> -rd top_cell=<cell>

It can also run with a Python that has the klayout module:

  python3 lvsdb_probe.py <file.lvsdb> <out.json> <cell>

The JSON has:
  loaded        true when LayoutVsSchematic().read() read the file without an error
  error         the read error, when loaded is false
  compared      true when the database has a cross-reference (a compare result) with at least one circuit pair
  match         true when every circuit pair has the status Match or MatchWithWarning
  circuits      [{layout, reference, status, pins: [{layout, reference, status}]}] for the pairs that do not match
  devices       [{circuit, layout, reference, class, status}] for the device pairs that do not match
  nets          [{circuit, layout, reference, status}] for the net pairs that do not match
  top           {layout, layout_pins, reference, reference_pins}: the top circuit and the circuit that it is paired
                with (the pins in the order of each netlist)
"""

import json
import sys

try:
    import klayout.db as kdb
except ImportError:  # in the Python of the KLayout binary
    import pya as kdb

GOOD = ("Match", "MatchWithWarning")


def name(obj, attribute="expanded_name"):
    if obj is None:
        return None
    value = getattr(obj, attribute)
    return value() if callable(value) else value


def status(pair):
    return str(pair.status()).split(".")[-1]


def probe(path, cell):
    out = {"loaded": False, "error": None, "compared": False, "match": False, "circuits": [], "devices": [], "nets": [],
           "top": None}
    lvs = kdb.LayoutVsSchematic()
    try:
        lvs.read(path)
    except Exception as e:  # KLayout raises RuntimeError on a truncated or damaged file
        out["error"] = str(e).strip()
        return out
    out["loaded"] = True
    xref = lvs.xref()
    layout = lvs.netlist()
    reference = lvs.reference
    out["compared"] = bool(xref is not None and xref.circuit_count() > 0)
    statuses = []
    if out["compared"]:
        for cp in xref.each_circuit_pair():
            a, b = cp.first(), cp.second()
            circuit = name(a, "name") or name(b, "name")
            statuses.append(status(cp))
            if status(cp) not in GOOD:
                pins = [{"layout": name(p.first()), "reference": name(p.second()), "status": status(p)}
                        for p in xref.each_pin_pair(cp) if status(p) not in GOOD]
                out["circuits"].append({"layout": name(a, "name"), "reference": name(b, "name"), "status": status(cp),
                                        "pins": pins})
            for d in xref.each_device_pair(cp):
                if status(d) not in GOOD:
                    device = d.first() or d.second()
                    out["devices"].append({"circuit": circuit, "layout": name(d.first()), "reference": name(d.second()),
                                           "class": device.device_class().name if device else None, "status": status(d)})
            for n in xref.each_net_pair(cp):
                if status(n) not in GOOD:
                    out["nets"].append({"circuit": circuit, "layout": name(n.first()), "reference": name(n.second()),
                                        "status": status(n)})
    out["match"] = bool(statuses) and all(s in GOOD for s in statuses)
    top = layout.circuit_by_name(cell) if layout is not None else None
    if top is None and layout is not None:
        tops = [c for c in layout.each_circuit_top_down()]
        top = tops[0] if tops else None
    other = None
    if top is not None and out["compared"]:
        other = xref.other_circuit_for(top)
    if other is None and reference is not None:
        other = reference.circuit_by_name(cell) or reference.circuit_by_name(cell.upper())
    out["top"] = {
        "layout": name(top, "name"),
        "layout_pins": [name(p) for p in top.each_pin()] if top is not None else [],
        "reference": name(other, "name"),
        "reference_pins": [name(p) for p in other.each_pin()] if other is not None else [],
    }
    return out


def main(path, result, cell):
    with open(result, "w") as f:
        json.dump(probe(path, cell), f, indent=1)
        f.write("\n")


if __name__ == "__main__" and len(sys.argv) == 4:
    main(sys.argv[1], sys.argv[2], sys.argv[3])
elif "lvsdb" in globals() and "result" in globals():  # klayout -b -r ... -rd lvsdb=... -rd result=...
    main(globals()["lvsdb"], globals()["result"], globals().get("top_cell") or "")
