"""
Build the once-per-O*NET-release retrieve index from the already-built shards.

Reads prompts/retrieve.json for relatedness tiers and the output path, then
writes static/data/<year>/retrieve/index.json. The live app ranks against this
file after intake; it does not send the whole O*NET corpus to the model.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ONET_RAW = ROOT / "data_prep" / "raw" / "ONET_30_3" / "db_30_3_text"
OUT = ROOT / "static" / "data"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def read_tsv(name: str):
    with open(ONET_RAW / name, newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f, delimiter="\t")


def major_group(soccode: str) -> str:
    return soccode.split("-", 1)[0]


def year_id() -> str:
    years = read_json(OUT / "years.json")
    year = years.get("default")
    if not year:
        raise RuntimeError("static/data/years.json has no default year")
    return year


def build_retrieve_index() -> tuple[int, int]:
    retrieve = read_json(ROOT / "prompts" / "retrieve.json")
    rel_path = retrieve["occupationIndexPath"]
    tiers = set(retrieve["relatedTiers"])
    cap = int(retrieve["relatedCap"])
    year = year_id()

    onet_dir = OUT / year / "onet"
    if not onet_dir.is_dir():
        raise FileNotFoundError(f"O*NET shards not found: {onet_dir}")

    occupations: dict[str, dict] = {}
    for shard_path in sorted(onet_dir.glob("*.json")):
        shard = read_json(shard_path)
        for parent_soc, bundle in shard.items():
            for code, profile in bundle.items():
                occupations[code] = {
                    "code": code,
                    "title": profile.get("title") or "",
                    "description": profile.get("description") or "",
                    "parentSoc": parent_soc,
                    "major": major_group(parent_soc),
                }

    related: dict[str, list[str]] = {}
    if (ONET_RAW / "Related Occupations.txt").is_file():
        for row in read_tsv("Related Occupations.txt"):
            if row["Relatedness Tier"].strip() not in tiers:
                continue
            src = row["O*NET-SOC Code"].strip()
            dst = row["Related O*NET-SOC Code"].strip()
            if src not in occupations or dst not in occupations:
                continue
            bucket = related.setdefault(src, [])
            if dst not in bucket and len(bucket) < cap:
                bucket.append(dst)

    dest = OUT / year / rel_path
    write_json(dest, {"year": year, "occupations": occupations, "related": related})
    return len(occupations), len(related)


def main() -> None:
    try:
        n_occ, n_rel = build_retrieve_index()
    except Exception as err:
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)
    print(f"Retrieve index: {n_occ} occupations, {n_rel} related-occupation keys")


if __name__ == "__main__":
    main()
