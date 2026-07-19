"""
Build static JSON data for the Wage Explorer web app from the raw OFLC files.

This is the build-time equivalent of the runtime data loading in
scripts/wage_lookup.py. Instead of streaming the 49 MB wage CSVs on every
lookup, we split them by Area once (per data year) into small JSON chunks the
browser can fetch on demand.

Real relations preserved (verified from the OFLC 2025-26 and O*NET 30.3 releases):

  xwalk_plus.csv  (OES_SOCCODE, OnetCode, ONetTitle)
       |  OES_SOCCODE == soccode                    OnetCode == O*NET-SOC Code
       v                                                  |
  oes_soc_occs.csv  (soccode, Title, Description)         v
       |  soccode == SocCode              ONET_30_3/*.txt (per O*NET-SOC profile:
       v                                   tasks, DWAs, job zone, skills,
  ALC_Export.csv / EDC_Export.csv           knowledge, software, education)
       ^  (Area, SocCode -> Level1..4, Average, Label)
       |  Area
  Geography.csv  (State, CountyTownName -> Area)

Wage annualization (identical to load_wages_for_area in wage_lookup.py):
  Label == "Annual Wage"  -> values already annual, kept as-is
  Label == anything else  -> values are hourly, multiplied by HOURS_PER_YEAR

Output (all under static/data/, committed and served verbatim by Hugo):
  years.json
  <YEAR>/geography.json      list[{area, areaName, stateAb, state, county}]
  <YEAR>/occupations.json    {soccode: {title, description}}
  <YEAR>/xwalk.json          {soccode: [{code, title}, ...]}   (O*NET children)
  <YEAR>/wages/alc/<area>.json   {soccode: {l1,l2,l3,l4,avg,label}}
  <YEAR>/wages/edc/<area>.json   {soccode: {l1,l2,l3,l4,avg,label}}
  <YEAR>/onet/<soccode>.json     {onetcode: {code,title,description,tasks,dwas,
                                   jobZone,knowledge,essentialSkills,software,
                                   education}}

Run:  python data_prep/build_data.py
Uses only the Python standard library.
"""

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_prep" / "raw" / "OFLC_Wages_2025-26_Updated"
ONET_RAW = ROOT / "data_prep" / "raw" / "ONET_30_3" / "db_30_3_text"
OUT = ROOT / "static" / "data"

YEAR = "2025-26"
YEAR_LABEL = "2025-2026"
YEAR_SOURCE_NOTE = "OFLC Wage Year 2025-26 (Revised, effective 8/1/25)"
HOURS_PER_YEAR = 2080

# O*NET rating scales (see Scales Reference): importance drives display order,
# level marks relevance. Elements are shown when their level row is relevant.
SCALE_IMPORTANCE = "IM"
SCALE_LEVEL = "LV"
SCALE_REQUIRED_EDUCATION = "RL"

# Ceiling on ranked worker-requirement lists per occupation. Filtered counts are
# already small (irrelevant elements are dropped); this only guards outliers.
MAX_RANKED_ELEMENTS = 20

# Allow very large CSV fields (some descriptions are long).
csv.field_size_limit(1 << 24)


def parse_wage(value: str):
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def round2(value):
    """Trim float noise from the *2080 conversion; display is whole dollars."""
    return round(value, 2) if value is not None else None


def write_json(path: Path, obj, *, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)


def build_years() -> None:
    write_json(
        OUT / "years.json",
        {
            "default": YEAR,
            "years": [
                {"id": YEAR, "label": YEAR_LABEL, "sourceNote": YEAR_SOURCE_NOTE}
            ],
        },
        compact=False,
    )


def build_geography() -> int:
    rows = []
    with open(RAW / "Geography.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            area = r["Area"].strip()
            if not area:
                continue
            rows.append(
                {
                    "area": area,
                    "areaName": r["AreaName"].strip(),
                    "stateAb": r["StateAb"].strip(),
                    "state": r["State"].strip(),
                    "county": r["CountyTownName"].strip(),
                }
            )
    write_json(OUT / YEAR / "geography.json", rows)
    return len(rows)


def build_occupations() -> int:
    occ = {}
    with open(RAW / "oes_soc_occs.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            code = r["soccode"].strip()
            if code:
                occ[code] = {
                    "title": r["Title"].strip(),
                    "description": r["Description"].strip(),
                }
    write_json(OUT / YEAR / "occupations.json", occ)
    return len(occ)


def build_xwalk() -> tuple[dict[str, list[dict]], int]:
    """Emit the crosswalk and return it as the SOC -> O*NET membership map.

    Each parent OES SOC code maps to the list of its O*NET-SOC children, each an
    {code, title} pair. The O*NET code (dropped by the previous title-only build)
    is what lets the app link a match to its full O*NET profile. This returned
    map is the single source of SOC -> O*NET membership consumed by build_onet.
    """
    xw: dict[str, list[dict]] = {}
    seen: set[tuple[str, str]] = set()
    with open(RAW / "xwalk_plus.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            soc = r["OES_SOCCODE"].strip()
            onet_code = r["OnetCode"].strip()
            title = r["ONetTitle"].strip()
            if not (soc and onet_code and title):
                continue
            if (soc, onet_code) in seen:
                continue
            seen.add((soc, onet_code))
            xw.setdefault(soc, []).append({"code": onet_code, "title": title})
    write_json(OUT / YEAR / "xwalk.json", xw)
    return xw, len(xw)


def build_wages(table: str) -> tuple[int, int]:
    filename = "ALC_Export.csv" if table == "alc" else "EDC_Export.csv"
    by_area: dict[str, dict[str, dict]] = {}
    n_rows = 0
    with open(RAW / filename, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            area = r["Area"].strip()
            soc = r["SocCode"].strip()
            if not area or not soc:
                continue
            n_rows += 1

            label = r["Label"].strip()
            is_annual = label == "Annual Wage"

            levels = [parse_wage(r[f"Level{i}"]) for i in range(1, 5)]
            average = parse_wage(r["Average"])

            if not is_annual:
                levels = [v * HOURS_PER_YEAR if v is not None else None for v in levels]
                average = average * HOURS_PER_YEAR if average is not None else None

            by_area.setdefault(area, {})[soc] = {
                "l1": round2(levels[0]),
                "l2": round2(levels[1]),
                "l3": round2(levels[2]),
                "l4": round2(levels[3]),
                "avg": round2(average),
                "label": label,
            }

    out_dir = OUT / YEAR / "wages" / table
    out_dir.mkdir(parents=True, exist_ok=True)
    for area, socs in by_area.items():
        write_json(out_dir / f"{area}.json", socs)

    return len(by_area), n_rows


# ---------------------------------------------------------------------------
# O*NET occupational profiles
#
# The OFLC wage tables publish only 6-digit SOC codes, but O*NET publishes rich
# occupational detail (tasks, work activities, skills, ...) per granular
# O*NET-SOC code (e.g. 15-2051.01). xwalk_plus already provides the authoritative
# SOC -> O*NET membership; build_onet joins the O*NET tabular files onto those
# codes and groups the resulting profiles by parent SOC, so the app can fetch one
# onet/<soc>.json alongside the SOC's wage row.
# ---------------------------------------------------------------------------

def read_tsv(name: str):
    """Yield each row of an O*NET tab-delimited file as a dict."""
    with open(ONET_RAW / name, newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f, delimiter="\t")


def load_element_descriptions() -> dict[str, str]:
    """Content Model element ID -> description (for skills, knowledge, ...)."""
    return {
        r["Element ID"].strip(): r["Description"].strip()
        for r in read_tsv("Content Model Reference.txt")
    }


def load_dwa_names() -> dict[str, str]:
    """Detailed Work Activity element ID -> its display statement."""
    return {
        r["DWA Element ID"].strip(): r["DWA Element Name"].strip()
        for r in read_tsv("GWAs to IWAs to DWAs.txt")
    }


def load_job_zone_reference() -> dict[int, dict]:
    """Job Zone number -> its experience/education/training/example detail."""
    ref = {}
    for r in read_tsv("Job Zone Reference.txt"):
        ref[int(r["Job Zone"])] = {
            "name": r["Name"].strip(),
            "experience": r["Experience"].strip(),
            "education": r["Education"].strip(),
            "training": r["Job Training"].strip(),
            "examples": r["Examples"].strip(),
            "svp": r["SVP Range"].strip(),
        }
    return ref


def load_education_categories() -> dict[int, str]:
    """Required-education percent-frequency category number -> description."""
    return {
        int(r["Category"]): r["Category Description"].strip()
        for r in read_tsv("Education Categories.txt")
        if r["Scale ID"].strip() == SCALE_REQUIRED_EDUCATION
    }


def _tasks_by_code(target: set) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in read_tsv("Task Statements.txt"):
        code = r["O*NET-SOC Code"].strip()
        if code not in target:
            continue
        out.setdefault(code, []).append(
            {"text": r["Task"].strip(), "type": r["Task Type"].strip()}
        )
    # Core tasks first; stable sort preserves each file's original order within.
    for tasks in out.values():
        tasks.sort(key=lambda t: 0 if t["type"] == "Core" else 1)
    return out


def _dwas_by_code(target: set, dwa_names: dict[str, str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    seen: dict[str, set] = {}
    for r in read_tsv("Tasks to DWAs.txt"):
        code = r["O*NET-SOC Code"].strip()
        if code not in target:
            continue
        name = dwa_names.get(r["DWA Element ID"].strip())
        if not name:
            continue
        bucket = seen.setdefault(code, set())
        if name in bucket:
            continue
        bucket.add(name)
        out.setdefault(code, []).append(name)
    return out


def _job_zones_by_code(target: set, ref: dict[int, dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in read_tsv("Job Zones.txt"):
        code = r["O*NET-SOC Code"].strip()
        if code not in target:
            continue
        zone = int(r["Job Zone"])
        detail = ref.get(zone)
        if detail:
            out[code] = {"zone": zone, **detail}
    return out


def _ranked_ratings_by_code(
    filename: str, target: set, descriptions: dict[str, str]
) -> dict[str, list[dict]]:
    """Rank an O*NET rating file (Essential Skills, Knowledge) per occupation.

    An element is shown when its Level row is relevant and not suppressed, and
    elements are ordered by Importance descending -- the same rule O*NET OnLine
    uses for its default display order.
    """
    acc: dict[str, dict[str, dict]] = {}
    for r in read_tsv(filename):
        code = r["O*NET-SOC Code"].strip()
        if code not in target:
            continue
        el = acc.setdefault(code, {}).setdefault(
            r["Element ID"].strip(),
            {"name": r["Element Name"].strip(), "importance": None,
             "relevant": False, "suppress": False},
        )
        scale = r["Scale ID"].strip()
        if scale == SCALE_IMPORTANCE:
            el["importance"] = parse_wage(r["Data Value"])
        elif scale == SCALE_LEVEL:
            el["relevant"] = r["Not Relevant"].strip() != "Y"
        if r["Recommend Suppress"].strip() == "Y":
            el["suppress"] = True

    out: dict[str, list[dict]] = {}
    for code, elements in acc.items():
        chosen = [
            (e_id, e) for e_id, e in elements.items()
            if e["relevant"] and not e["suppress"] and e["importance"] is not None
        ]
        chosen.sort(key=lambda kv: kv[1]["importance"], reverse=True)
        ranked = [
            {"name": e["name"], "description": descriptions.get(e_id, "")}
            for e_id, e in chosen
        ][:MAX_RANKED_ELEMENTS]
        if ranked:
            out[code] = ranked
    return out


def _software_by_code(target: set) -> dict[str, list[dict]]:
    """Software examples grouped by category, matching O*NET's presentation."""
    grouped: dict[str, dict[str, list[dict]]] = {}
    for r in read_tsv("Software Skills.txt"):
        code = r["O*NET-SOC Code"].strip()
        if code not in target:
            continue
        category = r["Element Name"].strip()
        grouped.setdefault(code, {}).setdefault(category, []).append(
            {
                "name": r["Workplace Example"].strip(),
                "hot": r["Hot Technology"].strip() == "Y",
                "inDemand": r["In Demand"].strip() == "Y",
            }
        )
    out: dict[str, list[dict]] = {}
    for code, cats in grouped.items():
        out[code] = [
            {"category": name, "examples": cats[name]}
            for name in sorted(cats)
        ]
    return out


def _education_by_code(target: set, categories: dict[int, str]) -> dict[str, list[dict]]:
    acc: dict[str, list[dict]] = {}
    for r in read_tsv("Education.txt"):
        code = r["O*NET-SOC Code"].strip()
        if code not in target or r["Scale ID"].strip() != SCALE_REQUIRED_EDUCATION:
            continue
        percent = parse_wage(r["Data Value"])
        category = int(r["Category"])
        label = categories.get(category)
        if percent and percent > 0 and label:
            acc.setdefault(code, []).append(
                {"level": label, "percent": round(percent, 1), "rank": category}
            )
    # O*NET's category number is the ordinal education level (1 = Less than a
    # High School Diploma ... 12 = Post-Doctoral Training), so sort by it to read
    # lowest-to-highest rather than by frequency. `rank` is carried through so
    # the frontend keeps this order independent of array position.
    for rows in acc.values():
        rows.sort(key=lambda e: e["rank"])
    return acc


def build_onet(xwalk_map: dict[str, list[dict]]) -> tuple[int, int]:
    """Build per-SOC O*NET profile files from the crosswalk membership map."""
    target = {child["code"] for children in xwalk_map.values() for child in children}

    occupations = {
        r["O*NET-SOC Code"].strip(): {
            "title": r["Title"].strip(),
            "description": r["Description"].strip(),
        }
        for r in read_tsv("Occupation Data.txt")
        if r["O*NET-SOC Code"].strip() in target
    }

    descriptions = load_element_descriptions()
    tasks = _tasks_by_code(target)
    dwas = _dwas_by_code(target, load_dwa_names())
    job_zones = _job_zones_by_code(target, load_job_zone_reference())
    essential = _ranked_ratings_by_code("Essential Skills.txt", target, descriptions)
    knowledge = _ranked_ratings_by_code("Knowledge.txt", target, descriptions)
    software = _software_by_code(target)
    education = _education_by_code(target, load_education_categories())

    def profile_for(code: str, title: str) -> dict:
        occ = occupations.get(code, {})
        # O*NET's own title/description is authoritative for the child; fall back
        # to the crosswalk title only if O*NET has no occupation row.
        p = {
            "code": code,
            "title": occ.get("title") or title,
            "description": occ.get("description", ""),
        }
        for key, value in (
            ("tasks", tasks.get(code)),
            ("dwas", dwas.get(code)),
            ("jobZone", job_zones.get(code)),
            ("knowledge", knowledge.get(code)),
            ("essentialSkills", essential.get(code)),
            ("software", software.get(code)),
            ("education", education.get(code)),
        ):
            if value:
                p[key] = value
        return p

    out_dir = OUT / YEAR / "onet"
    out_dir.mkdir(parents=True, exist_ok=True)
    n_codes = 0
    for soc, children in xwalk_map.items():
        bundle = {}
        for child in children:
            bundle[child["code"]] = profile_for(child["code"], child["title"])
            n_codes += 1
        write_json(out_dir / f"{soc}.json", bundle)

    return len(xwalk_map), n_codes


def main() -> None:
    if not RAW.exists():
        print(f"ERROR: raw data folder not found: {RAW}", file=sys.stderr)
        sys.exit(1)
    if not ONET_RAW.exists():
        print(f"ERROR: O*NET raw data folder not found: {ONET_RAW}", file=sys.stderr)
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)

    build_years()
    n_geo = build_geography()
    n_occ = build_occupations()
    xwalk_map, n_xwalk = build_xwalk()
    n_alc_areas, n_alc_rows = build_wages("alc")
    n_edc_areas, n_edc_rows = build_wages("edc")
    n_onet_socs, n_onet_codes = build_onet(xwalk_map)

    print("Data build complete.")
    print(f"  geography rows : {n_geo}")
    print(f"  occupations    : {n_occ}")
    print(f"  xwalk parents  : {n_xwalk}")
    print(f"  ALC : {n_alc_rows} rows -> {n_alc_areas} area files")
    print(f"  EDC : {n_edc_rows} rows -> {n_edc_areas} area files")
    print(f"  O*NET : {n_onet_codes} profiles -> {n_onet_socs} SOC files")
    print(f"  output dir     : {OUT}")


if __name__ == "__main__":
    main()
