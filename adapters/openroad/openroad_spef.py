"""Reader and check for an extracted SPEF file. Pure text parsing: no tool run, no PDK facts.

An extraction can end without an error and write a SPEF whose wires have no resistance, for example when the
extraction takes the layer resistance from a technology LEF that has no RESISTANCE values. The timing with such a
file looks better than it is. The check counts the resistance segments and the segments with 0 ohm.
"""

import gzip
import re
import zlib

UNIT = re.compile(r"^\*([TCRL])_UNIT\s+([-+0-9.eE]+)\s+(\w+)")
R_SCALE = {"OHM": 1.0, "KOHM": 1e3, "MOHM": 1e6}
C_SCALE = {"FF": 1e-3, "PF": 1.0, "NF": 1e3}
# The share of resistance segments with 0 ohm that a real extraction can have: short segments, a via model without
# resistance. More than this share is not plausible for a routed block.
MAX_ZERO_FRACTION = 0.25
# A segment below this value counts as 0 ohm. An extraction without layer resistance can write values such as 1e-17.
ZERO_OHM = 1e-6
# A value at or below this (negative) is a negative resistance. The noise of an extraction without layer resistance
# is about 1e-16 ohm, far inside this limit.
NEGATIVE_OHM = 1e-9
CORNERS = ("best", "typical", "worst")
# A value of a SPEF file is one number, or three numbers for the best, typical and worst case ('0.5:0.6:0.7').
SPEF_NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
SPEF_VALUE = re.compile(r"^(" + SPEF_NUMBER + r")(?::(" + SPEF_NUMBER + r"):(" + SPEF_NUMBER + r"))?$")


def spef_value(word):
    """The numbers of a SPEF value: [x] or [best, typical, worst]. None when the word is not a value."""
    m = SPEF_VALUE.match(word)
    if not m:
        return None
    return [float(g) for g in m.groups() if g is not None]


def _lines(f):
    """The lines of the file. Damaged gzip data (a cut file, a damaged block) is an OSError, as a file that is not gzip data."""
    try:
        for line in f:
            yield line
    except (EOFError, zlib.error) as e:
        raise OSError("damaged gzip data: {}".format(e))


def read_spef(path, examples=5):
    """The counts of a SPEF file: {design, r_unit, c_unit, unit_errors, nets, nets_with_res, res_segments,
    res_zero_segments, res_negative_segments, res_bad_rows, res_total_ohm, cap_total_pf, zero_nets (the first nets
    whose segments are all 0 ohm), nets_without_res (the first nets with no segment), nets_all_zero, bad_rows (the
    first rows of a *RES section that are not a resistance), res_zero_fraction}.

    A resistance is one number or a triplet (best:typical:worst). A triplet is one segment: its typical value goes
    into the sum, the segments of 0 ohm (below 1e-6 ohm) are counted for each of the three corners (res_zero_by_corner; a single
    number counts in all three), res_zero_segments is the count of the corner with the most, and a segment is
    negative when one value is -1e-9 ohm or lower. A row of a *RES
    section that cannot be read is counted in res_bad_rows: it is never left out without a count. unit_errors: a
    *R_UNIT or *C_UNIT that is missing or not known (the sums are then in the numbers of the file, without a scale).
    The function reads the file line by line. It raises OSError or EOFError for a file that cannot be read (also a
    .gz file that is not gzip data)."""
    out = {"design": None, "r_unit": None, "c_unit": None, "unit_errors": [], "nets": 0, "nets_with_res": 0, "res_segments": 0,
           "res_zero_segments": 0, "res_negative_segments": 0, "res_bad_rows": 0, "res_total_ohm": 0.0, "cap_total_pf": 0.0,
           "zero_nets": [], "nets_without_res": [], "nets_all_zero": 0, "bad_rows": [], "res_zero_by_corner": [0, 0, 0],
           "triplets": 0}
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
        for number, raw in enumerate(_lines(f), 1):
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            if line.startswith("*"):
                word = line.split(None, 1)[0]
                if word == "*D_NET" or word == "*R_NET":
                    close()
                    parts = line.split()
                    net, net_segments, net_zero = parts[1] if len(parts) > 1 else "?", 0, 0
                    section = "net"
                    out["nets"] += 1
                    total = spef_value(parts[2]) if len(parts) > 2 else None
                    if total:
                        out["cap_total_pf"] += total[len(total) // 2] * c_scale
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
                        out["r_unit"] = "{:g} {}".format(factor, unit)
                        if unit in R_SCALE and factor > 0:
                            r_scale = factor * R_SCALE[unit]
                        else:
                            out["unit_errors"].append("*R_UNIT {:g} {}".format(factor, unit))
                    elif kind == "C":
                        out["c_unit"] = "{:g} {}".format(factor, unit)
                        if unit in C_SCALE and factor > 0:
                            c_scale = factor * C_SCALE[unit]
                        else:
                            out["unit_errors"].append("*C_UNIT {:g} {}".format(factor, unit))
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
                values = spef_value(parts[3]) if len(parts) >= 4 else None
                if values is None:
                    out["res_bad_rows"] += 1
                    if len(out["bad_rows"]) < examples:
                        out["bad_rows"].append("line {}: {}".format(number, line[:80]))
                    continue
                if len(values) == 3:
                    out["triplets"] += 1
                values = [v * r_scale for v in values] * (1 if len(values) == 3 else 3)
                net_segments += 1
                out["res_segments"] += 1
                out["res_total_ohm"] += values[1]
                # A real extraction without layer resistance writes values such as -5e-16: they count as 0 ohm.
                if min(values) <= -NEGATIVE_OHM:
                    out["res_negative_segments"] += 1
                    continue
                for corner, value in enumerate(values):
                    if abs(value) < ZERO_OHM:
                        out["res_zero_by_corner"][corner] += 1
                if max(abs(v) for v in values) < ZERO_OHM:
                    net_zero += 1
    close()
    if out["r_unit"] is None:
        out["unit_errors"].append("no *R_UNIT line")
    if out["c_unit"] is None:
        out["unit_errors"].append("no *C_UNIT line")
    # The count of the corner with the most segments of 0 ohm: a file is checked for each corner.
    out["res_zero_segments"] = max(out["res_zero_by_corner"])
    out["res_zero_fraction"] = (out["res_zero_segments"] / out["res_segments"]) if out["res_segments"] else None
    return out


def check_spef(counts, max_zero_fraction=MAX_ZERO_FRACTION):
    """The verdict of the resistance check: ("valid", None) or ("invalid", reason)."""
    if counts["nets"] == 0:
        return "invalid", "the file has no net (*D_NET): nothing was extracted"
    if counts["unit_errors"]:
        return "invalid", ("the units of the file are not supported: {}. The check knows OHM, KOHM and MOHM, and FF, PF and "
                           "NF. Without the unit, the resistance values cannot be checked.").format("; ".join(counts["unit_errors"]))
    if counts["res_bad_rows"]:
        return "invalid", ("{} rows of the *RES sections are not a resistance (first: {}). The file is damaged, or it has a "
                           "form that this check does not read; its segments cannot be counted.").format(
                               counts["res_bad_rows"], "; ".join(counts["bad_rows"][:2]))
    if counts["res_segments"] == 0:
        return "invalid", ("{} nets and no resistance segment (*RES): the file has capacitance only. The wire delay of a "
                           "timing run with this file has no resistance.").format(counts["nets"])
    if counts["res_negative_segments"]:
        return "invalid", ("{} of {} resistance segments are negative: a wire resistance cannot be negative. The "
                           "extraction is wrong.").format(counts["res_negative_segments"], counts["res_segments"])
    by_corner = counts["res_zero_by_corner"]
    corners = [k for k in range(3)] if counts["triplets"] else [1]
    all_zero = [k for k in corners if by_corner[k] == counts["res_segments"]]
    if all_zero:
        where = "" if not counts["triplets"] or len(all_zero) == 3 else " in the {} corner{}".format(
            " and ".join(CORNERS[k] for k in all_zero), "" if len(all_zero) == 1 else "s")
        return "invalid", ("all {} resistance segments of {} nets are 0 ohm{} (below {:g} ohm; the sum of the typical values is "
                           "{:.3g} ohm): the extraction had no wire resistance. A timing run with this file is a run without "
                           "wire resistance.").format(counts["res_segments"], counts["nets_with_res"], where, ZERO_OHM, counts["res_total_ohm"])
    over = [k for k in corners if by_corner[k] / counts["res_segments"] > max_zero_fraction]
    if over:
        worst = max(over, key=lambda k: by_corner[k])
        where = " in the {} corner".format(CORNERS[worst]) if counts["triplets"] else ""
        return "invalid", ("{} of {} resistance segments are 0 ohm{} ({:.1f} %; the limit is {:.1f} %), and {} nets have "
                           "only such segments{} (first: {}): a part of the wires, for example some layers, has no "
                           "resistance.").format(
                               by_corner[worst], counts["res_segments"], where, 100 * by_corner[worst] / counts["res_segments"],
                               100 * max_zero_fraction, counts["nets_all_zero"], " in all corners" if counts["triplets"] else "",
                               ", ".join(counts["zero_nets"]) or "-")
    return "valid", None
