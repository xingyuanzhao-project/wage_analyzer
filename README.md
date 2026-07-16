# Wage Explorer

A static web app for exploring U.S. prevailing wages by job and location.

Enter a **job keyword** plus a **state** and **county**, and Wage Explorer returns
every matching occupation with its four prevailing-wage levels and job description,
**annualized** and **sorted from the lowest average wage upward** — so demanding roles
sitting at the bottom of the pay range are easy to spot.

Data source: **U.S. Department of Labor, Office of Foreign Labor Certification (OFLC)**,
Prevailing Wage data, Wage Year 2025-26 (Revised, effective 8/1/25). This project is an
independent explorer and is not affiliated with the U.S. Department of Labor.

## How it works

GitHub Pages serves static files only, so there is no server-side lookup. The pipeline
that the reference CLI (`scripts/wage_lookup.py`) runs per request is instead precomputed
once per data year and shipped as small JSON files the browser fetches on demand.

```
data_prep/raw/OFLC_Wages_2025-26_Updated/   raw OFLC CSV/XLSX/PDF source files
            |
            v  data_prep/build_data.py  (split by Area, annualize wages)
            |
static/data/
  years.json                      list of available data years
  2025-26/geography.json          Area <-> (State, County) rows
  2025-26/occupations.json        soccode -> {title, description}
  2025-26/xwalk.json              parent soccode -> [O*NET titles]
  2025-26/wages/alc/<area>.json   annualized wages per Area (all industries)
  2025-26/wages/edc/<area>.json   annualized wages per Area (higher education)
```

The browser loads the small reference files once, then fetches only the single
`wages/<table>/<area>.json` chunk for the resolved area (tens of KB) instead of the
49 MB of raw wage CSVs.

### Real data relations

- `Geography.csv`: fuzzy-resolve `(State, County)` -> one `Area` code.
- `oes_soc_occs.csv`: keyword -> broad SOC occupations (title + description).
- `xwalk_plus.csv`: keyword -> granular O*NET titles (e.g. "Business Intelligence
  Analysts") that map back to a parent SOC code, so specific queries resolve even when
  the broad title differs ("Data Scientists").
- `ALC_Export.csv` / `EDC_Export.csv`: `(Area, SocCode)` -> `Level1..4`, `Average`, `Label`.

### Wage annualization

The `Label` column is the authoritative unit indicator. `Label == "Annual Wage"` values
are kept as-is; everything else is hourly and multiplied by **2,080 hours/year**
(40 hrs x 52 wks, the standard BLS/OFLC factor). All results are therefore directly
comparable on one annual scale.

The client-side matching engine in `assets/js/lib/` (`fuzzy.ts`, `geography.ts`,
`match.ts`, `pipeline.ts`) is a faithful TypeScript port of the verified logic in
`scripts/wage_lookup.py`, including the `difflib.SequenceMatcher`-based fuzzy matching
and its scoring thresholds.

## Local development

Requires [Hugo extended](https://gohugo.io/installation/) (v0.164.0+) and, only to
regenerate data, Python 3 (standard library only).

```bash
# Serve the site with live reload
hugo server

# Then open the URL Hugo prints (e.g. http://localhost:1313/wage-explorer/)
```

Build the production site into `public/`:

```bash
hugo --gc --minify
```

## Regenerating the data / adding a new year

1. Drop the new OFLC release folder under `data_prep/raw/`.
2. Update the `YEAR*` constants in `data_prep/build_data.py` (and, to keep older years,
   generalize it to loop over multiple releases).
3. Run the prep script from the repo root:

   ```bash
   python data_prep/build_data.py
   ```

4. Add an entry to the `years` array in `static/data/years.json`. The **Data year**
   selector in the UI is populated from that file, so no front-end code changes are
   needed to expose a new year.

## Deployment

The site is published to GitHub Pages from the **`gh-pages`** branch, which holds the
built output of `hugo --minify`. In the repository settings,
**Settings -> Pages -> Build and deployment -> Source** is set to
**Deploy from a branch**, branch **`gh-pages`**, folder **`/ (root)`**.

To rebuild and redeploy after changing the site or regenerating data, publish a fresh
`public/` to that branch (the `.nojekyll` file keeps GitHub Pages from post-processing
the output). For example, using a dedicated worktree:

```bash
hugo --gc --minify
git worktree add .gh-pages gh-pages
rm -rf .gh-pages/* && cp -r public/* .gh-pages/ && touch .gh-pages/.nojekyll
( cd .gh-pages && git add -A && git commit -m "Deploy" && git push origin gh-pages )
git worktree remove .gh-pages
```

Prefer GitHub Actions instead? Add a Hugo Pages workflow under
`.github/workflows/` (pushing it requires a token with the `workflow` scope:
`gh auth refresh -h github.com -s workflow`), then switch the Pages source to
**GitHub Actions**.

## Project layout

```
assets/            CSS + TypeScript (bundled by Hugo Pipes / esbuild)
data_prep/         raw OFLC files + build_data.py
layouts/           Hugo templates (baseof, home, partials)
scripts/           wage_lookup.py — the reference CLI the web app is ported from
static/data/       generated JSON consumed by the browser
.github/workflows/ GitHub Pages deploy workflow
```
