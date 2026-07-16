"""
Wage-to-JD lookup: keyword + State/County -> matching occupations with wage tiers.

Data relations (verified from OFLC 2025-26 release):

  xwalk_plus.csv  (OnetCode, ONetTitle -> OES_SOCCODE)
       |                                         |
       | keyword match on ONetTitle               | OES_SOCCODE = soccode
       v                                         v
  oes_soc_occs.csv  (soccode, Title, Description)
       |
       | soccode = SocCode
       v
  ALC_Export.csv / EDC_Export.csv  (Area, SocCode -> Level1..4, Average, Label)
       ^
       | Area
  Geography.csv  (State, CountyTownName -> Area)

All wages normalized to annual (Label="Annual Wage" kept as-is; hourly * 2080).

Usage:
  python wage_lookup.py --keyword "business intelligence" --state "Texas" --county "Travis"
  python wage_lookup.py   # interactive prompts
"""

import argparse
import csv
import sys
from difflib import SequenceMatcher
from pathlib import Path

DATA_DIR = Path(__file__).parent
HOURS_PER_YEAR = 2080

try:
    from rapidfuzz import fuzz as rf_fuzz

    def _fuzzy_ratio(a: str, b: str) -> float:
        return rf_fuzz.ratio(a.lower(), b.lower())

    def _fuzzy_partial(a: str, b: str) -> float:
        return rf_fuzz.partial_ratio(a.lower(), b.lower())

except ImportError:

    def _fuzzy_ratio(a: str, b: str) -> float:
        return SequenceMatcher(None, a.lower(), b.lower()).ratio() * 100

    def _fuzzy_partial(a: str, b: str) -> float:
        a_low, b_low = a.lower(), b.lower()
        if len(a_low) <= len(b_low):
            short, long = a_low, b_low
        else:
            short, long = b_low, a_low
        best = 0.0
        n = len(short)
        for i in range(len(long) - n + 1):
            r = SequenceMatcher(None, short, long[i : i + n]).ratio() * 100
            if r > best:
                best = r
        return best


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def load_occupations() -> dict:
    """soccode -> (Title, Description)"""
    occ = {}
    with open(DATA_DIR / "oes_soc_occs.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            code = row["soccode"].strip()
            if code:
                occ[code] = (row["Title"].strip(), row["Description"].strip())
    return occ


def load_xwalk() -> dict:
    """OES_SOCCODE -> [ONetTitle, ...] from xwalk_plus.csv."""
    xw = {}
    with open(DATA_DIR / "xwalk_plus.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            code = row["OES_SOCCODE"].strip()
            title = row["ONetTitle"].strip()
            if code and title:
                xw.setdefault(code, []).append(title)
    return xw


def load_geography() -> list:
    """List of (Area, AreaName, StateAb, State, CountyTownName)."""
    rows = []
    with open(DATA_DIR / "Geography.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            area = row["Area"].strip()
            if not area:
                continue
            rows.append((
                area,
                row["AreaName"].strip(),
                row["StateAb"].strip(),
                row["State"].strip(),
                row["CountyTownName"].strip(),
            ))
    return rows


def _parse_wage(val: str):
    val = val.strip()
    if val == "":
        return None
    try:
        return float(val)
    except ValueError:
        return None


def load_wages_for_area(area: str, soccodes: set, table: str = "ALC") -> dict:
    """Streaming pass -> {soccode: {Level1..4, Average, Label, GeoLvl}}.

    All wages normalized to annual:
      Label == "Annual Wage"  -> values already annual, keep as-is
      Label == "" / other     -> values are hourly, multiply by 2080
    """
    filename = "ALC_Export.csv" if table.upper() == "ALC" else "EDC_Export.csv"
    wages = {}
    with open(DATA_DIR / filename, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["Area"].strip() != area:
                continue
            sc = row["SocCode"].strip()
            if sc not in soccodes:
                continue

            label = row["Label"].strip()
            is_annual = (label == "Annual Wage")

            raw = [_parse_wage(row[f"Level{i}"]) for i in range(1, 5)]
            avg = _parse_wage(row["Average"])

            if not is_annual:
                raw = [v * HOURS_PER_YEAR if v is not None else None for v in raw]
                avg = avg * HOURS_PER_YEAR if avg is not None else None

            wages[sc] = {
                "Level1": raw[0], "Level2": raw[1],
                "Level3": raw[2], "Level4": raw[3],
                "Average": avg,
                "Label": label,
                "GeoLvl": row["GeoLvl"].strip(),
            }
    return wages


# ---------------------------------------------------------------------------
# Resolvers
# ---------------------------------------------------------------------------

def resolve_area(state_input: str, county_input: str, geo: list):
    """Fuzzy-match (state, county) -> (Area, AreaName, detail_string) or Nones."""
    state_input = state_input.strip()
    county_input = county_input.strip()

    state_scored = []
    for area, area_name, state_ab, state_full, county in geo:
        s1 = _fuzzy_ratio(state_input, state_full)
        s2 = _fuzzy_ratio(state_input, state_ab)
        best_state = max(s1, s2)
        if best_state >= 50:
            state_scored.append((best_state, area, area_name, state_ab, state_full, county))

    if not state_scored:
        return None, None, "No state match"

    top_state_score = max(s[0] for s in state_scored)
    state_rows = [s for s in state_scored if s[0] >= top_state_score - 5]

    best_county_score = -1
    best_match = None
    for _, area, area_name, state_ab, state_full, county in state_rows:
        cs = _fuzzy_partial(county_input, county)
        if cs > best_county_score:
            best_county_score = cs
            best_match = (area, area_name, f"{county}, {state_ab}")

    if best_match is None or best_county_score < 40:
        return None, None, "No county match in matched state"

    return best_match[0], best_match[1], best_match[2]


def _word_prefix_hit(keyword_lower: str, text_lower: str) -> bool:
    for word in text_lower.split():
        word = word.strip(".,;:()\"'")
        if word.startswith(keyword_lower):
            return True
    return False


def _score_title(keyword_lower: str, title: str, multi_word: bool,
                 sub_score: float, prefix_score: float, fuzzy_thresh: float):
    """Score keyword against a title. Uses full-string ratio for fuzzy."""
    title_lower = title.lower()
    if keyword_lower in title_lower:
        return sub_score
    if _word_prefix_hit(keyword_lower, title_lower):
        return prefix_score
    if multi_word or len(keyword_lower) >= 6:
        fs = _fuzzy_ratio(keyword_lower, title_lower)
        if fs >= fuzzy_thresh:
            return fs
    return 0


def _score_desc(keyword_lower: str, desc: str, multi_word: bool,
                sub_score: float, prefix_score: float, fuzzy_thresh: float):
    """Score keyword against a description. Uses partial ratio for fuzzy."""
    desc_lower = desc.lower()
    if keyword_lower in desc_lower:
        return sub_score
    if _word_prefix_hit(keyword_lower, desc_lower):
        return prefix_score
    if multi_word:
        fs = _fuzzy_partial(keyword_lower, desc_lower)
        if fs >= fuzzy_thresh:
            return fs
    return 0


def match_soccodes(keyword: str, occ: dict, xwalk: dict) -> list:
    """Return [{soccode, Title, Description, score, onet_hits}].

    Searches two surfaces — both are real join paths, not fallbacks:
      1. oes_soc_occs.csv  Title / Description  (broad SOC, 849 entries)
      2. xwalk_plus.csv    ONetTitle             (granular O*NET, 998 entries)
    When an O*NET title matches, the parent OES_SOCCODE is included and
    the matched O*NET title(s) are recorded in onet_hits.

    Title matching uses full-string fuzzy ratio (is this title about the keyword?).
    Description matching uses partial fuzzy ratio (does the keyword appear in the text?).
    """
    keyword_lower = keyword.strip().lower()
    multi_word = " " in keyword_lower
    hits = {}  # soccode -> {score, onet_hits}

    def _update(code, score, onet_title=None):
        if code not in hits:
            hits[code] = {"score": score, "onet_hits": []}
        else:
            hits[code]["score"] = max(hits[code]["score"], score)
        if onet_title:
            hits[code]["onet_hits"].append(onet_title)

    for code, (title, desc) in occ.items():
        ts = _score_title(keyword_lower, title, multi_word,
                          sub_score=100, prefix_score=95, fuzzy_thresh=65)
        if ts > 0:
            _update(code, ts)
            continue
        ds = _score_desc(keyword_lower, desc, multi_word,
                         sub_score=90, prefix_score=85, fuzzy_thresh=80)
        if ds > 0:
            _update(code, ds)

    for code, onet_titles in xwalk.items():
        for ot in onet_titles:
            s = _score_title(keyword_lower, ot, multi_word,
                             sub_score=98, prefix_score=93, fuzzy_thresh=65)
            if s > 0:
                _update(code, s, onet_title=ot)

    results = []
    for code, h in hits.items():
        if code not in occ:
            continue
        title, desc = occ[code]
        results.append({
            "SocCode": code,
            "Title": title,
            "Description": desc,
            "score": h["score"],
            "onet_hits": h["onet_hits"],
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def lookup(keyword: str, state: str, county: str, table: str = "ALC"):
    """Full pipeline: keyword + state/county -> sorted wage rows."""
    occ = load_occupations()
    xwalk = load_xwalk()
    geo = load_geography()

    area, area_name, geo_detail = resolve_area(state, county, geo)
    if area is None:
        return None, geo_detail, []

    matches = match_soccodes(keyword, occ, xwalk)
    if not matches:
        return area_name, geo_detail, []

    soccodes = {m["SocCode"] for m in matches}
    wages = load_wages_for_area(area, soccodes, table)

    rows = []
    for m in matches:
        code = m["SocCode"]
        w = wages.get(code)
        if w is None:
            rows.append({
                **m,
                "Level1": None, "Level2": None,
                "Level3": None, "Level4": None,
                "Average": None,
                "Label": "no data for area",
                "GeoLvl": "",
            })
        else:
            rows.append({**m, **w})

    rows.sort(key=lambda r: (r["Average"] is None, r["Average"] or 0))
    return area_name, geo_detail, rows


# ---------------------------------------------------------------------------
# Formatter
# ---------------------------------------------------------------------------

def _fmt_annual(val) -> str:
    if val is None:
        return "     N/A"
    return f"{val:>8,.0f}"


def format_rows(rows: list, area_name: str, geo_detail: str, top_n: int | None = None):
    print(f"\nArea: {area_name}  ({geo_detail})")
    print(f"Matches: {len(rows)}  (all wages annualized)")
    if top_n:
        rows = rows[:top_n]
    print("-" * 110)

    for r in rows:
        lvls = (
            f"[{_fmt_annual(r['Level1'])},"
            f" {_fmt_annual(r['Level2'])},"
            f" {_fmt_annual(r['Level3'])},"
            f" {_fmt_annual(r['Level4'])}]"
        )
        avg = _fmt_annual(r["Average"])
        label = r.get("Label", "")
        label_str = f"  [{label}]" if label and label != "Annual Wage" else ""

        onet_hits = r.get("onet_hits", [])
        onet_str = f"  via: {', '.join(onet_hits)}" if onet_hits else ""

        desc = r["Description"]
        if len(desc) > 120:
            desc = desc[:117] + "..."

        print(f"{r['SocCode']}  {r['Title']}{onet_str}")
        print(f"  Annual: {lvls}  avg={avg}{label_str}")
        print(f"  Desc:   {desc}")
        print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Look up OFLC wages by job keyword and location."
    )
    parser.add_argument("--keyword", "-k", help="Job keyword to search")
    parser.add_argument("--state", "-s", help="State name or abbreviation")
    parser.add_argument("--county", "-c", help="County name")
    parser.add_argument(
        "--table", "-t", choices=["ALC", "EDC"], default="ALC",
        help="Wage table: ALC (all-industries, default) or EDC (higher-ed)"
    )
    parser.add_argument(
        "--top", "-n", type=int, default=None,
        help="Show only top N results"
    )
    args = parser.parse_args()

    keyword = args.keyword or input("Job keyword: ").strip()
    state = args.state or input("State: ").strip()
    county = args.county or input("County: ").strip()

    if not keyword or not state or not county:
        print("Error: keyword, state, and county are all required.", file=sys.stderr)
        sys.exit(1)

    area_name, geo_detail, rows = lookup(keyword, state, county, args.table)

    if area_name is None:
        print(f"Error: {geo_detail}", file=sys.stderr)
        sys.exit(1)

    if not rows:
        print(f"Area resolved to: {area_name} ({geo_detail})")
        print(f"No occupations matched keyword '{keyword}'.")
        sys.exit(0)

    format_rows(rows, area_name, geo_detail, args.top)


if __name__ == "__main__":
    main()
