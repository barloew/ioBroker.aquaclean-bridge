#!/usr/bin/env python3
"""Generate the ioBroker adapter's entity table and the entity reference from the bridge component.

Run with a Python that has ESPHome installed (the component imports it):

    python3 tools/generate.py --bridge ../geberit-aquaclean-bridge-for-esp

Reads components/geberit_aquaclean/__init__.py (ENTITIES) and lang/*.yaml, writes:

  lib/entities.json        what the adapter needs at runtime: state ids, roles, names in the ioBroker
                           languages, option texts, and the name table to recognise every entity in all
                           bridge languages
  README.md                the entity reference between <!-- entities:begin --> and <!-- entities:end -->
  docs/de/README.md        the same in German

Only names, kinds, units and value ranges are exported: nothing about the toilet protocol.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from descriptions import D  # noqa: E402

# ioBroker languages -> bridge language file
IOB_LANGS = {"en": "en", "de": "de", "ru": "ru", "pt": "pt", "nl": "nl", "fr": "fr", "it": "it", "es": "es",
             "pl": "pl", "uk": "uk", "zh-cn": "zh"}

# internal domain of the component -> ESPHome platform
PLATFORM = {
    "status": "binary_sensor", "binary_sensor": "binary_sensor", "user_flag": "binary_sensor",
    "stat_counter": "sensor", "stat_hours": "sensor", "stat_seconds": "sensor", "counter": "sensor",
    "days": "sensor", "timestamp": "sensor", "gauge": "sensor", "rssi": "sensor", "user_rssi": "sensor",
    "status_value": "sensor", "counter_value": "sensor",
    "text_sensor": "text_sensor", "uptime": "text_sensor", "user_irk": "text_sensor", "status_enum": "text_sensor",
    "user_text": "text", "user_entity": "text", "user_irk_set": "text", "raw_text": "text",
    "setting_select": "select", "user_welcome": "select", "user_device": "select",
    "number": "number", "threshold": "number",
    "setting_switch": "switch", "hub_switch": "switch",
    "button": "button", "command": "button",
    "setting_time": "time",
    "event": "event",
    "light": "light",
}
UNITS = {"stat_hours": "h", "stat_seconds": "s", "days": "d", "gauge": "B", "rssi": "dBm", "user_rssi": "dBm",
         "threshold": "dBm"}
# option lists the bridge can switch to on some models (same entity, other texts)
OPTION_KEY = {"user_welcome": "welcome_light"}

# channels inside a device, with their names in every ioBroker language
CHANNELS = {
    "settings": {"en": "Settings", "de": "Einstellungen", "ru": "Настройки", "pt": "Configurações",
                 "nl": "Instellingen", "fr": "Réglages", "it": "Impostazioni", "es": "Ajustes", "pl": "Ustawienia",
                 "uk": "Налаштування", "zh-cn": "设置"},
    "info": {"en": "Information", "de": "Informationen", "ru": "Информация", "pt": "Informação",
             "nl": "Informatie", "fr": "Informations", "it": "Informazioni", "es": "Información",
             "pl": "Informacje", "uk": "Інформація", "zh-cn": "信息"},
    "statistics": {"en": "Statistics", "de": "Statistik", "ru": "Статистика", "pt": "Estatísticas",
                   "nl": "Statistieken", "fr": "Statistiques", "it": "Statistiche", "es": "Estadísticas",
                   "pl": "Statystyki", "uk": "Статистика", "zh-cn": "统计"},
    "other": {"en": "Other entities", "de": "Weitere Entitäten", "ru": "Другие объекты", "pt": "Outras entidades",
              "nl": "Overige entiteiten", "fr": "Autres entités", "it": "Altre entità", "es": "Otras entidades",
              "pl": "Inne encje", "uk": "Інші об'єкти", "zh-cn": "其他实体"},
}
BRIDGE_DEVICE = {c: "AquaClean Bridge" for c in IOB_LANGS}


def load_component(bridge: Path):
    sys.path.insert(0, str(bridge / "components"))
    import geberit_aquaclean as g  # noqa: PLC0415
    return g


def device_of(e) -> str:
    return e.group or "bridge"


def leaf_of(e) -> str:
    if e.group and e.group.startswith("profile_"):
        return re.sub(r"^profile_\d_", "", e.key)
    return e.key


def channel_of(e) -> str | None:
    if device_of(e) == "maintenance":
        return None
    if e.key.startswith("stat_"):
        return "statistics"
    cat = e.defaults.get("entity_category")
    return {"config": "settings", "diagnostic": "info"}.get(cat)


def state_id(e) -> str:
    ch = channel_of(e)
    return ".".join(x for x in (device_of(e), ch, leaf_of(e)) if x)


def base_key(e) -> str:
    """Key used for descriptions and for the reference tables (profile N folded)."""
    if e.group and e.group.startswith("profile_"):
        b = leaf_of(e)
        return f"{b}@profile" if f"{b}@profile" in D else b
    return re.sub(r"profile_\d", "profile_N", e.key)


def role_and_type(e, platform: str) -> tuple[str, str, bool, bool]:
    """ioBroker role, type, read, write."""
    d, k = e.domain, e.key
    dc = e.defaults.get("device_class")
    if platform == "binary_sensor":
        role = {"connectivity": "indicator.connected", "problem": "indicator.alarm",
                "running": "indicator.working"}.get(dc, "sensor")
        if k == "toilet_problem":
            role = "indicator.error"
        return role, "boolean", True, False
    if platform == "light":
        return "switch.light", "boolean", True, True
    if platform == "switch":
        cat = e.defaults.get("entity_category")
        return ("switch.enable" if cat == "config" else "switch"), "boolean", True, True
    if platform == "button":
        role = "button"
        if k.startswith("stop_") or k == "descaling_cancel":
            role = "button.stop"
        elif k.endswith("_start"):
            role = "button.start"
        return role, "boolean", False, True
    if platform == "number":
        if k.endswith("light_brightness"):
            return "level.brightness", "number", True, True
        return "level", "number", True, True
    if platform == "select":
        return "level", "number", True, True
    if platform == "time":
        return "text", "string", True, True
    if platform == "text":
        return "text", "string", d != "user_irk_set", True
    if platform == "event":
        return "text", "string", True, False
    if platform == "sensor":
        if d == "timestamp" or dc == "timestamp":
            return "date", "number", True, False
        if d in ("rssi", "user_rssi"):
            return "value.rssi", "number", True, False
        if k == "days_until_filter_change":
            return "value.filter", "number", True, False
        if d == "stat_seconds":
            return "value.interval", "number", True, False
        return "value", "number", True, False
    if platform == "text_sensor":
        if d == "uptime":
            return "date", "number", True, False
        if d == "status_enum" and k != "last_error_text":
            return "value", "number", True, False
        return {"model": "info.model", "firmware": "info.firmware", "serial_number": "info.serial",
                "toilet_address": "info.address"}.get(k, "text"), "string", True, False
    raise SystemExit(f"no role for {platform} ({k})")


def option_groups(g, e) -> list[str]:
    base = OPTION_KEY.get(e.domain, e.key)
    groups = [base]
    for k, _cap, okey in g.OPTION_VARIANTS:
        if k == e.key:
            groups.append(okey)
    return groups


# ------------------------------------------------------------------------------------------------ docs

DOC = {
    "en": {
        "file": "README.md",
        "cols": ("State", "Name", "Type", "Access", "Values", "What it does"),
        "rw": {(True, True): "read/write", (True, False): "read", (False, True): "write (button)"}, "wo": "write",
        "bool": "true/false", "text": "text", "time": "HH:MM", "date": "date/time (ms)",
        "index": "number: {opts}",
        "event": "button id, e.g. `shower`, `shower_long`",
        "profiles_note": "`N` is 1–6. Profiles 1–3 are stored in the toilet (profile keys 1–3 on the remote "
                         "control), profiles 4–6 only on the bridge.",
        "session_profile_note": "`N` is 1–6.",
        "devices": {
            "bridge": "### `bridge` — the bridge (the ESP)",
            "toilet": "### `toilet` — AquaClean Toilet",
            "session": "### `session` — Active session",
            "profile": "### `profile_N` — User profile 1–6",
            "maintenance": "### `maintenance` — Physical maintenance (only while unlocked)",
        },
        "advanced": "#### Advanced entities (option *Also create advanced entities*)\n\nDiscovery and diagnostic "
                    "tools for other models, disabled by default on the bridge: {names}.",
        "type": {"boolean": "boolean", "number": "number", "string": "string"},
    },
    "de": {
        "file": "docs/de/README.md",
        "cols": ("Datenpunkt", "Name", "Typ", "Zugriff", "Werte", "Funktion"),
        "rw": {(True, True): "lesen/schreiben", (True, False): "lesen", (False, True): "schreiben (Taster)"},
        "wo": "schreiben",
        "bool": "true/false", "text": "Text", "time": "HH:MM", "date": "Datum/Uhrzeit (ms)",
        "index": "Zahl: {opts}",
        "event": "Tasten-ID, z. B. `shower`, `shower_long`",
        "profiles_note": "`N` ist 1–6. Die Profile 1–3 sind im WC gespeichert (Profiltasten 1–3 der "
                         "Fernbedienung), die Profile 4–6 nur in der Bridge.",
        "session_profile_note": "`N` ist 1–6.",
        "devices": {
            "bridge": "### `bridge` — die Bridge (der ESP)",
            "toilet": "### `toilet` — AquaClean WC",
            "session": "### `session` — Aktive Sitzung",
            "profile": "### `profile_N` — Benutzerprofil 1–6",
            "maintenance": "### `maintenance` — Physische Wartung (nur solange freigeschaltet)",
        },
        "advanced": "#### Erweiterte Entitäten (Option *Auch erweiterte Entitäten anlegen*)\n\nDiscovery- und "
                    "Diagnosewerkzeuge für andere Modelle, auf der Bridge standardmäßig deaktiviert: {names}.",
        "type": {"boolean": "boolean", "number": "number", "string": "string"},
    },
}


def doc_name(name: str) -> str:
    """House style for the documentation: the shower is called "shower" (Dusche), never by the body part."""
    return re.sub(r"\bAnal[- ]?[dD]usche", "Dusche", name)


def write_docs(g, std, adv, recs) -> None:
    for code, t in DOC.items():
        lang = g.I18N[code]
        path = ROOT / t["file"]
        text = path.read_text(encoding="utf-8")
        out = []
        groups = {"bridge": [], "toilet": [], "session": [], "profile": [], "maintenance": []}
        seen = set()
        for e in std:
            dev = device_of(e)
            gkey = "profile" if dev.startswith("profile_") else dev
            b = base_key(e)
            if (gkey, b) in seen:
                continue
            seen.add((gkey, b))
            groups[gkey].append(e)
        for gkey, ents in groups.items():
            out.append(t["devices"][gkey])
            out.append("")
            if gkey == "profile":
                out += [t["profiles_note"], ""]
            if gkey == "session":
                out += [t["session_profile_note"], ""]
            out.append("| " + " | ".join(t["cols"]) + " |")
            out.append("|" + "---|" * len(t["cols"]))
            for e in ents:
                r = recs[e.key]
                sid = r["id"]
                if gkey == "profile":
                    sid = re.sub(r"^profile_\d", "profile_N", sid)
                sid = re.sub(r"profile_\d(_|$)", r"profile_N\1", sid)
                name = doc_name(g._entity_name(lang, e, True))
                if e.name_args and "n" in e.name_args:
                    name = name.replace(str(e.name_args["n"]), "N")
                name = re.sub(r"\b1\b", "N", name) if e.key.startswith("stat_profile_") else name
                typ = t["type"][r["type"]]
                rw = t["rw"][(r["read"], r["write"])] if r["platform"] == "button" or r["read"] else t["wo"]
                if r["platform"] in ("select",) or r.get("options"):
                    opts = lang["options"][r["options"][0]]
                    vals = t["index"].format(opts=", ".join(f"{i} = {o}" for i, o in enumerate(opts) if o))
                elif r["platform"] == "event":
                    vals = t["event"]
                elif r["type"] == "boolean":
                    vals = t["bool"]
                elif r["platform"] == "time":
                    vals = t["time"]
                elif r["role"] == "date":
                    vals = t["date"]
                elif r["type"] == "string":
                    vals = t["text"]
                else:
                    lo, hi = r.get("min"), r.get("max")
                    vals = f"{lo}–{hi}" if lo is not None else ""
                    if r.get("unit"):
                        vals = f"{vals} {r['unit']}".strip()
                desc = D[base_key(e)][0 if code == "en" else 1]
                out.append(f"| `{sid}` | {name} | {typ} | {rw} | {vals} | {desc} |")
            out.append("")
        names = ", ".join(sorted({doc_name(g._entity_name(lang, e, True)) for e in adv}))
        out.append(t["advanced"].format(names=names))
        block = "\n".join(out)
        new, n = re.subn(r"(<!-- entities:begin -->).*?(<!-- entities:end -->)",
                         lambda m: f"{m.group(1)}\n{block}\n{m.group(2)}", text, flags=re.S)
        if n != 1:
            raise SystemExit(f"{path}: entity markers not found")
        path.write_text(new, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", type=Path, default=ROOT.parent,
                    help="checkout of geberit-aquaclean-bridge-for-esp")
    ap.add_argument("--no-docs", action="store_true")
    args = ap.parse_args()
    g = load_component(args.bridge.resolve())
    lang = g.I18N
    for code in IOB_LANGS.values():
        assert code in lang, f"bridge has no language {code}"

    std = [e for e in g.ENTITIES if not e.discovery and not e.disabled]
    adv = [e for e in g.ENTITIES if e.discovery or e.disabled]

    missing = sorted({base_key(e) for e in std} - set(D))
    if missing:
        raise SystemExit(f"no description for: {', '.join(missing)}")

    # -------------------------------------------------------------- name table (all bridge languages)
    match: dict[str, str] = {}
    for code in g.LANGUAGES:
        tr = lang[code]
        for e in g.ENTITIES:
            dev = "" if e.group is None else tr["devices"][e.group]
            for k in (f"{dev}\u0001{g._entity_name(tr, e, True)}", f"\u0001{g._entity_name(tr, e, False)}"):
                if match.get(k, e.key) != e.key:
                    raise SystemExit(f"name collision: {k!r} -> {match[k]} and {e.key}")
                match[k] = e.key

    # -------------------------------------------------------------- per entity
    recs: dict[str, dict] = {}
    option_texts: dict[str, dict[str, list[str]]] = {}
    for e in g.ENTITIES:
        p = PLATFORM[e.domain]
        role, typ, read, write = role_and_type(e, p)
        r = {"key": e.key, "id": state_id(e), "device": device_of(e), "platform": p, "role": role,
             "type": typ, "read": read, "write": write,
             "name": {c: g._entity_name(lang[b], e, True) for c, b in IOB_LANGS.items()}}
        if channel_of(e):
            r["channel"] = channel_of(e)
        if e.discovery or e.disabled:
            r["advanced"] = True
        unit = UNITS.get(e.domain) or e.defaults.get("unit_of_measurement")
        if unit:
            r["unit"] = unit
        if p == "number":
            if e.domain == "threshold":
                r["min"], r["max"] = -100, -30
            else:
                _kind, _sid, maximum, offset = e.setting[:4]
                r["min"], r["max"] = offset, maximum + offset
        if role == "date":
            r["date"] = "iso" if e.domain == "uptime" else "s"
        if e.domain == "user_irk_set":
            r["secret"] = True
        if p == "select" or (e.domain == "status_enum" and e.key != "last_error_text"):
            groups = option_groups(g, e)
            r["options"] = groups
            for grp in groups:
                option_texts[grp] = {c: lang[c]["options"][grp] for c in g.LANGUAGES}
        recs[e.key] = r

    # remote control buttons, labelled in every ioBroker language
    events = {}
    for c, b in IOB_LANGS.items():
        tr = lang[b]
        labels = {}
        for et in g.EVENT_TYPES:
            if et == "unknown":
                continue
            btn, long = (et[:-5], True) if et.endswith("_long") else (et, False)
            labels[et] = tr["buttons"][btn] + (f" ({tr['button_states'][1]})" if long else "")
        events[c] = labels

    devices = {"bridge": BRIDGE_DEVICE}
    for grp in ["toilet", "session", "maintenance"] + list(g.G_PROFILES):
        devices[grp] = {c: lang[b]["devices"][grp] for c, b in IOB_LANGS.items()}

    ids = [r["id"] for r in recs.values()]
    assert len(ids) == len(set(ids)), "duplicate state id"

    (ROOT / "lib").mkdir(exist_ok=True)
    (ROOT / "lib/entities.json").write_text(json.dumps({
        "_comment": "GENERATED by tools/generate.py from the bridge component. Do not edit.",
        "bridgeLanguages": g.LANGUAGES,
        "devices": devices,
        "channels": CHANNELS,
        "entities": list(recs.values()),
        "options": option_texts,
        "events": events,
        "match": match,
    }, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    if not args.no_docs:
        write_docs(g, std, adv, recs)
    print(f"{len(g.ENTITIES)} entities ({len(std)} standard, {len(adv)} advanced), "
          f"{len(match)} name matches, {len(option_texts)} option lists")


if __name__ == "__main__":
    main()
