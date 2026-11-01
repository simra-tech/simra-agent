"""Operation "check_design" of the ngspice adapter. It reads a design netlist in the ngspice form and runs no
simulation.

Inputs: file (relative to the design root), subckt, pins (in order), elements (the allowed kinds: "mos", "r", "c"; the
default is all three), devices (the allowed devices of the technology pack; the default is all), limits ({r_ohm, c_f},
the maximum value of one R or C) and technology (optional, the name of a technology pack; the default is the pack whose
"pdks" has $PDK). The technology pack gives the MOS devices, their terminals, their parameters, the minimum sizes and
the size unit (ngspice.devices, ngspice.size_unit_m), and for each PDK the area of the ideal R and C
(ngspice.passives). The file holds only .subckt blocks. In a block, an X line instantiates a device of the pack or
another block of the file, and R and C lines are ideal elements with a plain value. Each other line (sources, .model,
.include, .param, expressions, ...) is an error. The response has status "completed" also when the design has errors:
each error is a diagnostic with severity "error" and the file and line. The measurements are gate_area_um2 (W x L x m
of all MOS devices, hierarchy expanded), passive_area_um2 (the area of the R and C elements, hierarchy expanded:
R x w_min^2 / R_sheet for a resistor and C / density for a capacitor, from the facts of $PDK in the pack), area_um2
(gate_area_um2 + passive_area_um2), mos_count and design_errors (the number of error diagnostics). When the pack has no
area facts for an R or C of the design, passive_area_um2 and area_um2 are failed and a warning tells why. The adapter
does not compare an area with a limit: give that limit as a requirement on area_um2 or gate_area_um2. work/design.json
has the errors, the elements (each R and C with its area) and the measurements.
"""

import json
import os
import re

from ngspice_adapter import CONTRACT, display_path, failure, find_technology, plain_number, sha256, si

DESIGN_KINDS = ("mos", "r", "c")
ELEMENT_LIMITS = ("r_ohm", "c_f")
GROUND_NODES = ("0", "gnd")
ELEMENT_KINDS = {"v": "a voltage source", "i": "a current source", "e": "a controlled source (E)",
                 "f": "a controlled source (F)", "g": "a controlled source (G)", "h": "a controlled source (H)",
                 "b": "a behavioural source (B)", "m": "a MOS model instance (M)", "d": "a diode", "q": "a bipolar transistor",
                 "j": "a JFET", "l": "an inductor", "k": "a coupling (K)", "s": "a switch (S)", "w": "a switch (W)",
                 "t": "a transmission line", "a": "an XSPICE code model (A)", "n": "an OSDI device (N)"}
PASSIVES = {"r": ("an ideal resistor", "r_ohm", "Ω"), "c": ("an ideal capacitor", "c_f", "F")}


def logical_lines(text):
    """[(line number, text)]: the netlist lines without comments, with each "+" line joined to the line before it."""
    out = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line.startswith("*"):
            continue
        line = re.split(r"[;$]", line, 1)[0].strip()
        if not line:
            continue
        if line.startswith("+") and out:
            out[-1] = (out[-1][0], out[-1][1] + " " + line[1:].strip())
        else:
            out.append((number, line))
    return out


def design_tokens(line):
    """The fields of a line; "k = v" becomes one field "k=v"."""
    return re.sub(r"\s*=\s*", "=", line).split()


def parse_blocks(lines):
    """({name: block}, [(line, message)]): the .subckt blocks of a netlist and the errors of the lines outside them."""
    blocks, errors, stack = {}, [], []
    for number, line in lines:
        t = design_tokens(line)
        head = t[0].lower()
        if head == ".subckt":
            if len(t) < 2:
                errors.append((number, ".subckt without a name"))
                continue
            pins = [p for p in t[2:] if "=" not in p and p.lower() != "params:"]
            block = {"name": t[1], "pins": pins, "line": number, "lines": [], "children": []}
            if len(pins) != len(t) - 2:
                errors.append((number, ".subckt {} has parameters; a block of the design takes no parameters".format(t[1])))
            if t[1].lower() in blocks:
                errors.append((number, ".subckt {} is defined more than once".format(t[1])))
            if stack:
                errors.append((number, ".subckt {} is inside .subckt {}; define each block on its own".format(
                    t[1], stack[-1]["name"])))
            blocks.setdefault(t[1].lower(), block)
            stack.append(block)
        elif head == ".ends":
            if not stack:
                errors.append((number, ".ends without .subckt"))
                continue
            block = stack.pop()
            if len(t) > 1 and t[1].lower() != block["name"].lower():
                errors.append((number, "'{}' closes .subckt {}".format(line, block["name"])))
        elif stack:
            stack[-1]["lines"].append((number, line, t))
        elif head != ".end":
            errors.append((number, "'{}' is outside a .subckt block; outside a block, only .end is allowed".format(line)))
    for block in stack:
        errors.append((block["line"], ".subckt {} has no .ends".format(block["name"])))
    return blocks, errors


def lint_device(name, nodes, params, model, device, size_unit):
    """(errors, values {param: number}, gate area in µm² or None) of one instance of a technology pack device."""
    errors, values = [], {}
    spec = device.get("params") or {}
    terminals = device.get("terminals") or []
    if len(nodes) != len(terminals):
        errors.append("{}: {} nodes; {} has {} terminals ({})".format(
            name, len(nodes), model, len(terminals), " ".join(terminals)))
    given = set()
    for p in params:
        key, _, text = p.partition("=")
        key = key.lower()
        if key not in spec:
            errors.append("{}: {} is not a parameter of {}; its parameters are {}".format(
                name, key, model, ", ".join(sorted(spec))))
            continue
        if key in given:
            errors.append("{}: {} is given more than once".format(name, key))
            continue
        given.add(key)
        value = plain_number(text)
        if value is None:
            errors.append("{}: {}={} is not a plain number (give a number with an optional scale suffix such as "
                          "u, n, p, k or meg)".format(name, key, text))
        else:
            values[key] = value
    for key, s in sorted(spec.items()):
        if s.get("required") and key not in given:
            errors.append("{}: {} is required for {}".format(name, key, model))
    roles = {s.get("role"): key for key, s in spec.items() if s.get("role")}
    fingers = values.get(roles.get("fingers"), 1)
    for key, value in sorted(values.items()):
        s = spec[key]
        if s.get("integer"):
            if value != int(value):
                errors.append("{}: {}={:g} is not an integer".format(name, key, value))
            elif "min" in s and value < s["min"]:
                errors.append("{}: {}={:g} is below the minimum {:g} of {}".format(name, key, value, s["min"], model))
        elif s.get("size"):
            metres = value * size_unit
            per = metres / fingers if s.get("per_finger") and fingers > 0 else metres
            if metres <= 0:
                errors.append("{}: {}={:g} is not a positive size".format(name, key, value))
            elif "min" in s and per < s["min"] * (1 - 1e-9):
                errors.append("{}: {} is {:g} µm{}, below the minimum {:g} µm of {}".format(
                    name, key, per * 1e6, " per finger" if per != metres else "", s["min"] * 1e6, model))
    width, length = values.get(roles.get("width")), values.get(roles.get("length"))
    if width is None or length is None:
        return errors, values, None
    factor = values.get(roles.get("multiplier"), 1) * (1 if device.get("width_total") else fingers)
    return errors, values, width * size_unit * 1e6 * length * size_unit * 1e6 * factor


def passive_factors(pack, pdk):
    """{"r": µm² per Ω, "c": µm² per F} from ngspice.passives.<pdk> of the pack; a kind without facts is left out."""
    facts = ((pack["ngspice"].get("passives") or {}).get(pdk) or {}) if pdk else {}
    out = {}
    r, c = facts.get("r") or {}, facts.get("c") or {}
    if r.get("sheet_ohm") and r.get("width_min_m"):
        out["r"] = (r["width_min_m"] * 1e6) ** 2 / r["sheet_ohm"]
    if c.get("density_f_per_m2"):
        out["c"] = 1 / (c["density_f_per_m2"] * 1e-12)
    return out


def lint_block(block, blocks, devices, allowed, elements, limits, size_unit, factors):
    """[(line, message)] of the lines of one block; the elements, the gate area of its devices and the area of its R
    and C (None when factors has no value for the kind) go to the block.
    allowed: the device names of the design contract, or None for every device of the pack."""
    errors, names = [], set()
    block["elements"], block["mos_count"], block["area"], block["passive"] = [], 0, 0.0, 0.0
    for number, line, t in block["lines"]:
        name, letter = t[0], t[0][0].lower()
        if any(c in line for c in "{}'\""):
            errors.append((number, "'{}': an expression or a quoted value is not allowed in the design; give "
                                   "plain numbers".format(line)))
            continue
        if letter == ".":
            errors.append((number, "'{}': {} is not allowed in the design".format(line, t[0])))
            continue
        if name.lower() in names:
            errors.append((number, "{} is defined more than once in .subckt {}".format(name, block["name"])))
        names.add(name.lower())
        if letter in PASSIVES:
            what, limit_name, unit = PASSIVES[letter]
            if letter not in elements:
                errors.append((number, "{}: {} is not allowed by elements ({})".format(name, what, ", ".join(elements))))
                continue
            if len(t) != 4:
                errors.append((number, "{}: {} has exactly 4 fields: {}name n1 n2 value".format(name, what, letter.upper())))
                continue
            value = plain_number(t[3])
            if value is None or value <= 0:
                errors.append((number, "{}: the value {} is not a positive plain number".format(name, t[3])))
                continue
            limit = limits.get(limit_name)
            if limit is not None and value > limit * (1 + 1e-9):
                errors.append((number, "{}: {} is above the limit {} (limits.{})".format(
                    name, si(value, unit), si(limit, unit), limit_name)))
            nodes, kind, model, values = t[1:3], letter, None, {"value": value}
            factor = factors.get(letter)
            values["area_um2"] = None if factor is None else round(value * factor, 9)
            block["passive"] = None if factor is None or block["passive"] is None else block["passive"] + value * factor
        elif letter == "x":
            first = next((i for i, w in enumerate(t) if "=" in w), len(t))
            positional, params = t[:first], t[first:]
            if len(positional) < 3 or any("=" not in p for p in params):
                errors.append((number, "'{}': give X<name> <nodes> <model> [k=v ...]".format(line)))
                continue
            nodes, model = positional[1:-1], positional[-1]
            device = devices.get(model.lower())
            if device is not None:
                if "mos" not in elements:
                    errors.append((number, "{}: MOS devices are not allowed by elements ({})".format(
                        name, ", ".join(elements))))
                    continue
                if allowed is not None and model.lower() not in [a.lower() for a in allowed]:
                    errors.append((number, "{}: {} is not in the devices of the design contract ({})".format(
                        name, model, ", ".join(allowed))))
                    continue
                messages, values, area = lint_device(name, nodes, params, model, device, size_unit)
                errors.extend((number, m) for m in messages)
                kind = "mos"
                block["mos_count"] += 1
                block["area"] = None if area is None or block["area"] is None else block["area"] + area
            elif model.lower() in blocks:
                child = blocks[model.lower()]
                if params:
                    errors.append((number, "{}: an instance of .subckt {} takes no parameters".format(name, child["name"])))
                if len(nodes) != len(child["pins"]):
                    errors.append((number, "{}: {} nodes; .subckt {} has {} pins".format(
                        name, len(nodes), child["name"], len(child["pins"]))))
                block["children"].append((number, child["name"].lower()))
                kind, values = "x", {}
            else:
                errors.append((number, "{}: {} is not a device of the technology pack or a .subckt of this file".format(
                    name, model)))
                continue
        else:
            what = ELEMENT_KINDS.get(letter, "element kind {}".format(letter.upper()))
            errors.append((number, "{}: {} is not allowed in the design; use only {}".format(
                name, what, ", ".join({"mos": "MOS devices of the technology pack (X)", "r": "ideal resistors (R)",
                                        "c": "ideal capacitors (C)"}[k] for k in elements) or "nothing")))
            continue
        for node in nodes:
            if node.lower() in GROUND_NODES:
                errors.append((number, "{}: node {} is the global ground; connect the design only through its "
                                       "pins".format(name, node)))
        block["elements"].append({"block": block["name"], "name": name, "kind": kind,
                                  "model": model.lower() if model else None, "nodes": nodes, "params": values,
                                  "line": number})
    return errors


def expand(blocks, top):
    """(mos_count, gate area in µm² or None, R and C area in µm² or None, [(line, message)]): the hierarchy of
    block top, expanded. A block that instantiates itself, directly or through other blocks, is an error."""
    errors, memo, visiting = [], {}, []

    def add(a, b):
        return None if a is None or b is None else a + b

    def visit(name):
        if name in memo:
            return memo[name]
        visiting.append(name)
        block = blocks[name]
        count, area, passive = block["mos_count"], block["area"], block["passive"]
        for number, child in block["children"]:
            if child in visiting:
                path = visiting[visiting.index(child):] + [child]
                errors.append((number, ".subckt {} instantiates itself ({})".format(
                    blocks[child]["name"], " -> ".join(blocks[n]["name"] for n in path))))
                area = passive = None
                continue
            c, a, p = visit(child)
            count += c
            area, passive = add(area, a), add(passive, p)
        visiting.pop()
        memo[name] = (count, area, passive)
        return memo[name]

    count, area, passive = visit(top)
    for name in blocks:  # blocks that the top does not use are checked for loops too
        visit(name)
    return count, area, passive, errors


def check_design(request):
    root = request["root"]
    work_dir = request["work_dir"]
    inputs = request.get("inputs") or {}
    name, subckt, pins = inputs.get("file"), inputs.get("subckt"), inputs.get("pins")
    elements = inputs.get("elements", list(DESIGN_KINDS))
    allowed = inputs.get("devices")
    limits = inputs.get("limits") or {}
    if not isinstance(name, str) or not name or os.path.isabs(name):
        return failure(None, "input 'file' is required (the design netlist, relative to the design root)")
    if not isinstance(subckt, str) or not subckt:
        return failure(None, "input 'subckt' is required (the name of the design subcircuit)")
    if not isinstance(pins, list) or not pins or not all(isinstance(p, str) and p for p in pins):
        return failure(None, "input 'pins' is required (the ordered pin names of the subcircuit)")
    if not isinstance(elements, list) or any(k not in DESIGN_KINDS for k in elements):
        return failure(None, "input 'elements' must be a list of {}".format(", ".join(DESIGN_KINDS)))
    if allowed is not None and (not isinstance(allowed, list) or not allowed
                                or not all(isinstance(d, str) and d for d in allowed)):
        return failure(None, "input 'devices' must be a list of device names of the technology pack")
    if not isinstance(limits, dict) or any(k not in ELEMENT_LIMITS or isinstance(v, bool) or not isinstance(v, (int, float))
                                           or not v > 0 for k, v in limits.items()):
        return failure(None, "input 'limits' must be {{name: positive number}} with names {}".format(", ".join(ELEMENT_LIMITS)))
    pack_path, pack, error = find_technology(inputs.get("technology"), os.environ.get("PDK"), "devices")
    if error:
        return failure(None, error)
    devices = {k.lower(): v for k, v in pack["ngspice"]["devices"].items()}
    size_unit = pack["ngspice"].get("size_unit_m", 1)
    pdk = os.environ.get("PDK")
    factors = passive_factors(pack, pdk)
    unknown = [d for d in allowed or [] if d.lower() not in devices]
    if unknown:
        return failure(None, "input 'devices': {} {} not a device of technology pack {}; its devices are {}".format(
            ", ".join(unknown), "is" if len(unknown) == 1 else "are", pack["name"],
            ", ".join(pack["ngspice"]["devices"])))

    path = os.path.join(root, name)
    files = [{"path": display_path(pack_path, root), "sha256": sha256(pack_path),
              "bytes": os.path.getsize(pack_path), "role": "technology"}]
    errors, warnings, mos_count, area, passive, total, all_elements = [], [], None, None, None, None, []
    if not os.path.isfile(path):
        errors.append((None, "design file not found: {}".format(name)))
    else:
        files.insert(0, {"path": display_path(path, root), "sha256": sha256(path), "bytes": os.path.getsize(path),
                         "role": "design"})
        with open(path, errors="replace") as f:
            blocks, errors = parse_blocks(logical_lines(f.read()))
        for block in blocks.values():
            if block["name"].lower() in devices:
                errors.append((block["line"], ".subckt {} has the name of a device of technology pack {}".format(
                    block["name"], pack["name"])))
            errors.extend(lint_block(block, blocks, devices, allowed, elements, limits, size_unit, factors))
            all_elements.extend(block["elements"])
        top = blocks.get(subckt.lower())
        if top is None:
            errors.append((None, "no .subckt {} in {}".format(subckt, name)))
        else:
            if [p.lower() for p in top["pins"]] != [p.lower() for p in pins]:
                errors.append((top["line"], ".subckt {} has the pins '{}'; the design contract gives '{}', in this "
                                            "order".format(top["name"], " ".join(top["pins"]), " ".join(pins))))
            mos_count, area, passive, loops = expand(blocks, subckt.lower())
            errors.extend(loops)
            area = None if area is None else round(area, 9)
            passive = None if passive is None else round(passive, 9)
            kinds = [k for k in ("r", "c") if k not in factors and any(e["kind"] == k for e in all_elements)]
            if area is not None and passive is not None:
                total = round(area + passive, 9)
            elif kinds and not loops:
                warnings.append((top["line"], "the area of {} is not known: technology pack {} has no ngspice.passives "
                                              "facts for them for PDK '{}'; area_um2 is not measured".format(
                                                  " and ".join({"r": "R", "c": "C"}[k] for k in kinds), pack["name"], pdk)))
    errors.sort(key=lambda e: e[0] or 0)
    diagnostics = [{"severity": severity, "message": m, "source": "{}:{}".format(name, n) if n else name}
                   for severity, found in (("error", errors), ("warning", warnings)) for n, m in found]
    source = "work/design.json"
    measurements = {
        "gate_area_um2": {"value": area, "unit": "um2", "status": "measured" if area is not None else "failed",
                          "source": source},
        "passive_area_um2": {"value": passive, "unit": "um2", "status": "measured" if passive is not None else "failed",
                             "source": source},
        "area_um2": {"value": total, "unit": "um2", "status": "measured" if total is not None else "failed",
                     "source": source},
        "mos_count": {"value": mos_count, "unit": None, "status": "measured" if mos_count is not None else "failed",
                      "source": source},
        "design_errors": {"value": len(errors), "unit": None, "status": "measured", "source": source},
    }
    out = os.path.join(work_dir, "design.json")
    with open(out, "w") as f:
        json.dump({"file": name, "subckt": subckt, "pins": pins, "elements_allowed": elements, "devices": allowed,
                   "limits": limits,
                   "technology": pack["name"], "errors": [{"message": d["message"], "source": d["source"]}
                                                          for d in diagnostics if d["severity"] == "error"],
                   "elements": all_elements, "measurements": {k: v["value"] for k, v in measurements.items()}},
                  f, indent=2, ensure_ascii=False)
        f.write("\n")
    return {"contract": CONTRACT, "status": "completed", "tool": None,
            "input_files": {"files": files, "complete": os.path.isfile(path)},
            "outputs": [{"path": display_path(out, root), "sha256": sha256(out), "bytes": os.path.getsize(out)}],
            "measurements": measurements, "diagnostics": diagnostics}
