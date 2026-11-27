"""Reader and check for an extracted SPEF file. Pure text parsing: no tool run, no PDK facts.

An extraction can end without an error and write a SPEF whose wires have no resistance, for example when the
extraction takes the layer resistance from a technology LEF that has no RESISTANCE values. The timing with such a
file looks better than it is. The check counts the resistance segments and the segments with 0 ohm.
"""

import gzip
import re

UNIT = re.compile(r"^\*([TCRL])_UNIT\s+([-+0-9.eE]+)\s+(\w+)")
R_SCALE = {"OHM": 1.0, "KOHM": 1e3, "MOHM": 1e6}
C_SCALE = {"FF": 1e-3, "PF": 1.0, "NF": 1e3}
# The share of resistance segments with 0 ohm that a real extraction can have: short segments, a via model without
# resistance. More than this share is not plausible for a routed block.
MAX_ZERO_FRACTION = 0.25
# A segment below this value counts as 0 ohm. An extraction without layer resistance can write values such as 1e-17.
ZERO_OHM = 1e-6


def read_spef(path, examples=5):
    """The counts of a SPEF file: {design, r_unit, c_unit, nets, nets_with_res, res_segments, res_zero_segments,
    res_total_ohm, cap_total_pf, zero_nets (the first nets whose segments are all 0 ohm), nets_without_res (the
    first nets with no segment)}. It reads the file line by line."""
    out = {"design": None, "r_unit": None, "c_unit": None, "nets": 0, "nets_with_res": 0, "res_segments": 0,
           "res_zero_segments": 0, "res_total_ohm": 0.0, "cap_total_pf": 0.0, "zero_nets": [], "nets_without_res": [],
           "nets_all_zero": 0}
    r_scale, c_scale = 1.0, 1.0
    names = {}
    section = None
    net, net_segments, net_zero = None, 0, 0

    def close():
        if net is None:
            return
        name = names.get(net, net)
        if net_segments == 0:
            if len(out["nets_without_res"]) < examples:
                out["nets_without_res"].append(name)
        else:
            out["nets_with_res"] += 1
            if net_zero == net_segments:
                out["nets_all_zero"] += 1
                if len(out["zero_nets"]) < examples:
                    out["zero_nets"].append(name)

    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            if line.startswith("*"):
                word = line.split(None, 1)[0]
                if word == "*D_NET" or word == "*R_NET":
                    close()
                    parts = line.split()
                    net, net_segments, net_zero = parts[1], 0, 0
                    section = "net"
                    out["nets"] += 1
                    try:
                        out["cap_total_pf"] += float(parts[2]) * c_scale
                    except (IndexError, ValueError):
                        pass
                    continue
                if word in ("*CONN", "*CAP", "*RES", "*INDUC", "*NAME_MAP", "*PORTS"):
                    section = word[1:].lower()
                    continue
                if word == "*END":
                    close()
                    net, section = None, None
                    continue
                if word == "*DESIGN":
                    m = re.match(r'\*DESIGN\s+"?([^"]+)"?', line)
                    out["design"] = m.group(1).strip() if m else None
                    continue
                m = UNIT.match(line)
                if m:
                    kind, factor, unit = m.group(1), float(m.group(2)), m.group(3).upper()
                    if kind == "R":
                        r_scale = factor * R_SCALE.get(unit, 1.0)
                        out["r_unit"] = "{:g} {}".format(factor, unit)
                    elif kind == "C":
                        c_scale = factor * C_SCALE.get(unit, 1.0)
                        out["c_unit"] = "{:g} {}".format(factor, unit)
                    continue
                if section == "name_map":
                    parts = line.split(None, 1)
                    if len(parts) == 2 and len(names) < 2000000:
                        names[parts[0]] = parts[1].replace("\\", "")
                    continue
                if section not in ("conn", "cap", "res", "induc"):
                    continue
            if section == "res" and net is not None:
                parts = line.split()
                if len(parts) < 4:
                    continue
                try:
                    value = float(parts[3]) * r_scale
                except ValueError:
                    continue
                net_segments += 1
                out["res_segments"] += 1
                out["res_total_ohm"] += value
                if abs(value) < ZERO_OHM:
                    net_zero += 1
                    out["res_zero_segments"] += 1
    close()
    out["res_zero_fraction"] = (out["res_zero_segments"] / out["res_segments"]) if out["res_segments"] else None
    return out


def check_spef(counts, max_zero_fraction=MAX_ZERO_FRACTION):
    """The verdict of the resistance check: ("valid", None) or ("invalid", reason)."""
    if counts["nets"] == 0:
        return "invalid", "the file has no net (*D_NET): nothing was extracted"
    if counts["res_segments"] == 0:
        return "invalid", ("{} nets and no resistance segment (*RES): the file has capacitance only. The wire delay of a "
                           "timing run with this file has no resistance.").format(counts["nets"])
    if counts["res_zero_segments"] == counts["res_segments"]:
        return "invalid", ("all {} resistance segments of {} nets are 0 ohm (below {:g} ohm; the sum is {:.3g} ohm): the "
                           "extraction had no wire resistance. A timing run with this file is a run without wire "
                           "resistance.").format(counts["res_segments"], counts["nets_with_res"], ZERO_OHM, counts["res_total_ohm"])
    fraction = counts["res_zero_fraction"]
    if fraction > max_zero_fraction:
        return "invalid", ("{} of {} resistance segments are 0 ohm ({:.1f} %; the limit is {:.1f} %), and {} nets have "
                           "only such segments (first: {}): a part of the wires, for example some layers, has no "
                           "resistance.").format(
                               counts["res_zero_segments"], counts["res_segments"], 100 * fraction, 100 * max_zero_fraction,
                               counts["nets_all_zero"], ", ".join(counts["zero_nets"]) or "-")
    return "valid", None
