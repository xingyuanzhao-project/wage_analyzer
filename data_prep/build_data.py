"""
Build static JSON data for the Wage Explorer web app from the raw OFLC files.

This is the build-time equivalent of the runtime data loading in
scripts/wage_lookup.py. Instead of streaming the 49 MB wage CSVs on every
lookup, we split them by Area once (per data year) into small JSON chunks the
browser can fetch on demand.

Real relations preserved (verified from the OFLC 2025-26 release):

  xwalk_plus.csv  (OES_SOCCODE, ONetTitle)
       |  OES_SOCCODE == soccode
       v
  oes_soc_occs.csv  (soccode, Title, Description)
       |  soccode == SocCode
       v
  ALC_Export.csv / EDC_Export.csv  (Area, SocCode -> Level1..4, Average, Label)
       ^  Area
  Geography.csv  (State, CountyTownName -> Area)

Wage annualization (identical to load_wages_for_area in wage_lookup.py):
  Label == "Annual Wage"  -> values already annual, kept as-is
  Label == anything else  -> values are hourly, multiplied by HOURS_PER_YEAR

Output (all under static/data/, committed and served verbatim by Hugo):
  years.json
  <YEAR>/geography.json      list[{area, areaName, stateAb, state, county}]
  <YEAR>/occupations.json    {soccode: {title, description}}
  <YEAR>/xwalk.json          {soccode: [ONetTitle, ...]}
  <YEAR>/wages/alc/<area>.json   {soccode: {l1,l2,l3,l4,avg,label}}
  <YEAR>/wages/edc/<area>.json   {soccode: {l1,l2,l3,l4,avg,label}}

Run:  python data_prep/build_data.py
Uses only the Python standard library.
"""

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_prep" / "raw" / "OFLC_Wages_2025-26_Updated"
OUT = ROOT / "static" / "data"

YEAR = "2025-26"
YEAR_LABEL = "2025-2026"
YEAR_SOURCE_NOTE = "OFLC Wage Year 2025-26 (Revised, effective 8/1/25)"
HOURS_PER_YEAR = 2080

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


def build_xwalk() -> int:
    xw: dict[str, list[str]] = {}
    with open(RAW / "xwalk_plus.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            code = r["OES_SOCCODE"].strip()
            title = r["ONetTitle"].strip()
            if code and title:
                xw.setdefault(code, []).append(title)
    write_json(OUT / YEAR / "xwalk.json", xw)
    return len(xw)


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


def main() -> None:
    if not RAW.exists():
        print(f"ERROR: raw data folder not found: {RAW}", file=sys.stderr)
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)

    build_years()
    n_geo = build_geography()
    n_occ = build_occupations()
    n_xwalk = build_xwalk()
    n_alc_areas, n_alc_rows = build_wages("alc")
    n_edc_areas, n_edc_rows = build_wages("edc")

    print("Data build complete.")
    print(f"  geography rows : {n_geo}")
    print(f"  occupations    : {n_occ}")
    print(f"  xwalk parents  : {n_xwalk}")
    print(f"  ALC : {n_alc_rows} rows -> {n_alc_areas} area files")
    print(f"  EDC : {n_edc_rows} rows -> {n_edc_areas} area files")
    print(f"  output dir     : {OUT}")


if __name__ == "__main__":
    main()
