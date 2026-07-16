import {
  loadYears,
  loadYearData,
  loadWages,
  loadOnet,
  type YearData,
} from "./lib/dataLoader";
import { resolveArea } from "./lib/geography";
import { parseKeywords, matchKeywords } from "./lib/match";
import { buildRows } from "./lib/pipeline";
import { Dropdown, type DropdownOption } from "./lib/dropdown";
import { orderCodes, renderProfile, profileToText } from "./lib/onetView";
import type { YearInfo, WageTable, ResultRow, OnetBundle } from "./lib/types";

const DESC_CLAMP_CHARS = 260;

const els = {
  form: document.getElementById("search-form") as HTMLFormElement,
  tableToggle: document.getElementById("table-toggle") as HTMLElement,
  keyword: document.getElementById("keyword") as HTMLInputElement,
  searchBtn: document.getElementById("search-btn") as HTMLButtonElement,
  hint: document.getElementById("form-hint") as HTMLParagraphElement,
  results: document.getElementById("results") as HTMLElement,
  footerYearNote: document.getElementById("footer-year-note") as HTMLElement,
  cardTpl: document.getElementById("tpl-result-card") as HTMLTemplateElement,
  themeToggle: document.getElementById("theme-toggle") as HTMLButtonElement,
};

let years: YearInfo[] = [];
let table: WageTable = "alc";

let stateDd: Dropdown;
let countyDd: Dropdown;
let yearDd: Dropdown;

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortMode = "avg-asc" | "avg-desc" | "entry-asc" | "entry-desc" | "title-az" | "keyword-az";

const SORT_OPTIONS: DropdownOption[] = [
  { value: "avg-asc", label: "Average wage (low to high)" },
  { value: "avg-desc", label: "Average wage (high to low)" },
  { value: "entry-asc", label: "Entry wage (low to high)" },
  { value: "entry-desc", label: "Entry wage (high to low)" },
  { value: "title-az", label: "Occupation (A–Z)" },
  { value: "keyword-az", label: "Keyword (A–Z)" },
];

const DEFAULT_SORT: SortMode = "avg-asc";

function alphaFirstKeyword(row: ResultRow): string {
  if (row.matchedKeywords.length === 0) return "";
  return row.matchedKeywords
    .reduce((a, b) => (a.toLowerCase() <= b.toLowerCase() ? a : b))
    .toLowerCase();
}

function sortRows(rows: ResultRow[], mode: SortMode): ResultRow[] {
  const out = rows.slice();
  // Rows without a published wage always sink to the end of numeric sorts.
  const byNumber = (key: "avg" | "l1", dir: 1 | -1) => (a: ResultRow, b: ResultRow) => {
    const av = a[key];
    const bv = b[key];
    const aNull = av === null;
    const bNull = bv === null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    return dir * ((av ?? 0) - (bv ?? 0));
  };
  switch (mode) {
    case "avg-asc":
      out.sort(byNumber("avg", 1));
      break;
    case "avg-desc":
      out.sort(byNumber("avg", -1));
      break;
    case "entry-asc":
      out.sort(byNumber("l1", 1));
      break;
    case "entry-desc":
      out.sort(byNumber("l1", -1));
      break;
    case "title-az":
      out.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "keyword-az":
      out.sort((a, b) => alphaFirstKeyword(a).localeCompare(alphaFirstKeyword(b)) || a.title.localeCompare(b.title));
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme(): void {
  els.themeToggle?.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("wage-explorer-theme", next);
    } catch (e) {
      /* ignore private-mode storage errors */
    }
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatUSD(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return "$" + Math.round(value).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Dropdown option sources
// ---------------------------------------------------------------------------

function statesFromData(data: YearData): DropdownOption[] {
  const names = new Set<string>();
  for (const row of data.geo) if (row.state) names.add(row.state);
  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({ value: n, label: n }));
}

function countiesFor(data: YearData, stateInput: string): DropdownOption[] {
  const q = stateInput.trim().toLowerCase();
  if (!q) return [];
  const counties = new Set<string>();
  for (const row of data.geo) {
    if (row.state.toLowerCase() === q || row.stateAb.toLowerCase() === q) {
      if (row.county) counties.add(row.county);
    }
  }
  return Array.from(counties)
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ value: c, label: c }));
}

function refreshCountyOptions(): void {
  const data = yearDataFor(yearDd.value);
  countyDd.setOptions(data ? countiesFor(data, stateDd.value) : []);
}

// ---------------------------------------------------------------------------
// Result state
// ---------------------------------------------------------------------------

let currentRows: ResultRow[] = [];
let currentKeywords: string[] = [];
let currentYear = "";
let sortMode: SortMode = DEFAULT_SORT;
const selected = new Set<string>();

let sortDd: Dropdown | null = null;
let listEl: HTMLElement | null = null;
let aggregateEl: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

function setResultsHTML(html: string): void {
  els.results.innerHTML = html;
}

function renderMessage(kind: "empty" | "error" | "welcome", title: string, body: string): void {
  setResultsHTML(
    `<div class="notice notice--${kind}">
       <h2 class="notice__title">${title}</h2>
       <p class="notice__body">${body}</p>
     </div>`,
  );
}

function renderLoading(): void {
  const skeletons = Array.from({ length: 4 })
    .map(
      () => `<div class="card card--skeleton">
        <div class="sk sk--title"></div>
        <div class="sk sk--tiers"></div>
        <div class="sk sk--text"></div>
      </div>`,
    )
    .join("");
  setResultsHTML(`<div class="results__list">${skeletons}</div>`);
}

function renderResults(
  rows: ResultRow[],
  areaName: string,
  geoDetail: string,
  keywords: string[],
): void {
  currentRows = rows;
  currentKeywords = keywords;
  selected.clear();

  const activeSeg = els.tableToggle.querySelector<HTMLElement>(".seg.is-active");
  const tableName = (activeSeg?.textContent ?? "").trim();
  const withWage = rows.filter((r) => r.hasWage && r.avg !== null).length;

  els.results.textContent = "";

  // --- summary bar (area, counts, sort control) ---
  const summary = document.createElement("div");
  summary.className = "results__summary";

  const heading = document.createElement("div");
  const area = document.createElement("span");
  area.className = "results__area";
  area.textContent = areaName;
  const geo = document.createElement("span");
  geo.className = "results__geo";
  geo.textContent = geoDetail;
  heading.append(area, geo);

  const meta = document.createElement("div");
  meta.className = "results__meta";
  const countPill = document.createElement("span");
  countPill.className = "pill";
  countPill.textContent = `${rows.length} match${rows.length === 1 ? "" : "es"}`;
  const tablePill = document.createElement("span");
  tablePill.className = "pill pill--muted";
  tablePill.textContent = tableName;

  const sortField = document.createElement("div");
  sortField.className = "sort-field";
  const sortLabel = document.createElement("span");
  sortLabel.className = "sort-field__label";
  sortLabel.id = "sort-label";
  sortLabel.textContent = "Sort by";
  const sortMount = document.createElement("div");
  sortField.append(sortLabel, sortMount);

  meta.append(countPill, tablePill, sortField);
  summary.append(heading, meta);
  els.results.appendChild(summary);

  sortDd = new Dropdown(sortMount, {
    mode: "select",
    options: SORT_OPTIONS,
    value: sortMode,
    labelledBy: "sort-label",
    onChange: (v) => {
      sortMode = v as SortMode;
      renderList();
    },
  });

  // --- aggregated job description panel ---
  aggregateEl = document.createElement("section");
  aggregateEl.className = "aggregate";
  aggregateEl.setAttribute("aria-live", "polite");
  els.results.appendChild(aggregateEl);

  if (withWage === 0) {
    const note = document.createElement("p");
    note.className = "results__nowage";
    note.textContent =
      "No wage figures are published for these occupations in this area. They are listed below for reference.";
    els.results.appendChild(note);
  }

  // --- results list (re-rendered on sort, selections preserved) ---
  listEl = document.createElement("div");
  listEl.className = "results__list";
  els.results.appendChild(listEl);

  renderList();
}

function renderList(): void {
  if (!listEl) return;
  const sorted = sortRows(currentRows, sortMode);
  const showKeywords = currentKeywords.length > 1;
  listEl.textContent = "";
  for (const row of sorted) listEl.appendChild(renderCard(row, showKeywords));
  void updateAggregate();
}

// Each aggregate rebuild takes a token; async bundle loads that finish after a
// newer selection change are dropped, so the panel always reflects the latest
// set of ticked roles.
let aggregateToken = 0;

async function updateAggregate(): Promise<void> {
  if (!aggregateEl) return;
  const token = ++aggregateToken;
  const chosen = sortRows(currentRows, sortMode).filter((r) => selected.has(r.soccode));

  if (chosen.length === 0) {
    aggregateEl.textContent = "";
    aggregateEl.classList.remove("is-active", "is-loading");
    const empty = document.createElement("p");
    empty.className = "aggregate__empty";
    empty.textContent = "Tick the box on any roles below to build a combined job description here.";
    aggregateEl.appendChild(empty);
    return;
  }

  aggregateEl.classList.add("is-active", "is-loading");

  const bundles = await Promise.all(chosen.map((r) => loadOnetSafe(r.soccode)));
  if (token !== aggregateToken) return; // a newer selection superseded this build

  aggregateEl.classList.remove("is-loading");
  aggregateEl.textContent = "";

  const head = document.createElement("div");
  head.className = "aggregate__head";
  const title = document.createElement("h3");
  title.className = "aggregate__title";
  title.textContent = "Aggregated job description";
  const count = document.createElement("span");
  count.className = "aggregate__count";
  count.textContent = `${chosen.length} role${chosen.length === 1 ? "" : "s"} selected`;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "aggregate__copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => void copyAggregate(chosen, bundles, copyBtn));
  head.append(title, count, copyBtn);
  aggregateEl.appendChild(head);

  const body = document.createElement("div");
  body.className = "aggregate__body";
  chosen.forEach((r, i) => {
    body.appendChild(renderAggregateRole(r, bundles[i]));
  });
  aggregateEl.appendChild(body);
}

function renderAggregateRole(row: ResultRow, bundle: OnetBundle | null): HTMLElement {
  const role = document.createElement("section");
  role.className = "aggregate__role";

  const header = document.createElement("div");
  header.className = "aggregate__role-head";
  header.appendChild(makeEl("h4", "aggregate__role-title", row.title));
  header.appendChild(makeEl("span", "chip chip--soc", row.soccode));
  const wage = makeEl("span", "aggregate__role-wage", `${formatUSD(row.avg)} avg / yr`);
  header.appendChild(wage);
  role.appendChild(header);

  const matched = new Set(row.onetHits.map((h) => h.code));
  appendOnetProfiles(role, bundle, matched, "aggregate__onet");
  return role;
}

async function copyAggregate(
  rows: ResultRow[],
  bundles: (OnetBundle | null)[],
  btn: HTMLButtonElement,
): Promise<void> {
  const blocks = rows.map((r, i) => {
    const lines = [`## ${r.title} (${r.soccode}) — ${formatUSD(r.avg)} avg / yr`];
    const bundle = bundles[i];
    if (bundle) {
      const matched = new Set(r.onetHits.map((h) => h.code));
      for (const code of orderCodes(bundle, matched)) {
        lines.push("", profileToText(bundle[code]));
      }
    } else if (r.description) {
      lines.push("", r.description);
    }
    return lines.join("\n");
  });
  try {
    await navigator.clipboard.writeText(blocks.join("\n\n"));
    btn.textContent = "Copied";
  } catch (e) {
    btn.textContent = "Press Ctrl+C";
  }
  window.setTimeout(() => {
    btn.textContent = "Copy";
  }, 1600);
}

/** Fetch a SOC's O*NET bundle, resolving to null so one gap never breaks the UI. */
async function loadOnetSafe(soccode: string): Promise<OnetBundle | null> {
  try {
    return await loadOnet(currentYear, soccode);
  } catch (e) {
    return null;
  }
}

function makeEl(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Render every O*NET child of a SOC (matched first) into a container. Every SOC
 * that reaches here has a profile bundle; a null bundle means the fetch itself
 * failed, so the message reflects a load error, not missing data.
 */
function appendOnetProfiles(
  host: HTMLElement,
  bundle: OnetBundle | null,
  matched: Set<string>,
  wrapClass: string,
): void {
  const wrap = makeEl("div", wrapClass);
  if (!bundle) {
    wrap.appendChild(makeEl("p", "onet__empty", "O*NET details couldn't be loaded. Reopen to try again."));
    host.appendChild(wrap);
    return;
  }
  for (const code of orderCodes(bundle, matched)) {
    wrap.appendChild(renderProfile(bundle[code], matched.has(code)));
  }
  host.appendChild(wrap);
}

function renderCard(row: ResultRow, showKeywords: boolean): HTMLElement {
  const node = els.cardTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.soc = row.soccode;
  if (!row.hasWage || row.avg === null) node.classList.add("card--nowage");

  const checkbox = node.querySelector(".card__select-input") as HTMLInputElement;
  checkbox.checked = selected.has(row.soccode);
  checkbox.setAttribute("aria-label", `Add ${row.title} to the aggregated job description`);
  if (checkbox.checked) node.classList.add("is-selected");
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(row.soccode);
    else selected.delete(row.soccode);
    node.classList.toggle("is-selected", checkbox.checked);
    void updateAggregate();
  });

  (node.querySelector(".card__title") as HTMLElement).textContent = row.title;
  (node.querySelector(".chip--soc") as HTMLElement).textContent = row.soccode;

  if (showKeywords) {
    const tags = node.querySelector(".card__tags") as HTMLElement;
    const socChip = node.querySelector(".chip--soc");
    for (const kw of row.matchedKeywords) {
      const chip = document.createElement("span");
      chip.className = "chip chip--kw";
      chip.textContent = kw;
      tags.insertBefore(chip, socChip);
    }
  }

  const via = node.querySelector(".chip--via") as HTMLElement;
  if (row.onetHits.length) {
    via.hidden = false;
    via.textContent = "via " + row.onetHits.map((h) => h.title).join(", ");
    via.title = "Matched through an O*NET occupation in the crosswalk";
  }

  (node.querySelector(".card__avg-value") as HTMLElement).textContent = formatUSD(row.avg);

  const levels = [row.l1, row.l2, row.l3, row.l4];
  const scaleMax = Math.max(0, ...levels.filter((v): v is number => v !== null));
  const tierEls = node.querySelectorAll(".tier");
  tierEls.forEach((tier, i) => {
    const v = levels[i];
    const bar = tier.querySelector("i") as HTMLElement;
    const valueEl = tier.querySelector(".tier__value") as HTMLElement;
    valueEl.textContent = formatUSD(v);
    if (v !== null && scaleMax > 0) {
      bar.style.width = Math.max(4, (v / scaleMax) * 100) + "%";
    } else {
      bar.style.width = "0%";
      tier.classList.add("tier--empty");
    }
  });

  const descText = node.querySelector(".card__desc-text") as HTMLElement;
  descText.textContent = row.description || "No description available.";
  const longDesc = (row.description || "").length > DESC_CLAMP_CHARS;
  if (longDesc) descText.classList.add("is-clamped");

  wireOnetToggle(node, row, descText, longDesc);
  return node;
}

/**
 * Wire the "Show O*NET details" control. The DOL description is the collapsed
 * preview; expanding lazily fetches the SOC's O*NET bundle (once), reveals the
 * full description, and renders each O*NET child profile.
 */
function wireOnetToggle(
  node: HTMLElement,
  row: ResultRow,
  descText: HTMLElement,
  longDesc: boolean,
): void {
  const toggle = node.querySelector(".card__detail-toggle") as HTMLButtonElement;
  const panel = node.querySelector(".card__onet") as HTMLElement;
  const label = node.querySelector(".card__detail-label") as HTMLElement;
  const matched = new Set(row.onetHits.map((h) => h.code));

  let loaded = false;
  let open = false;
  toggle.addEventListener("click", async () => {
    open = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    label.textContent = open ? "Hide O*NET details" : "Show O*NET details";
    if (longDesc) descText.classList.toggle("is-clamped", !open);
    panel.hidden = !open;

    if (open && !loaded) {
      panel.textContent = "";
      panel.appendChild(makeEl("p", "onet__loading", "Loading O*NET profile…"));
      const bundle = await loadOnetSafe(row.soccode);
      loaded = bundle !== null; // keep the result cached; let a failed load retry
      panel.textContent = "";
      appendOnetProfiles(panel, bundle, matched, "card__onet-list");
    }
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searching = false;

async function runSearch(): Promise<void> {
  if (searching) return;

  const keywords = parseKeywords(els.keyword.value);
  const state = stateDd.value.trim();
  const county = countyDd.value.trim();
  const year = yearDd.value;

  const missing: string[] = [];
  if (keywords.length === 0) missing.push("a job keyword");
  if (!state) missing.push("a state");
  if (!county) missing.push("a county");
  if (missing.length) {
    els.hint.textContent = "Please enter " + missing.join(", ") + ".";
    return;
  }
  els.hint.textContent = "";

  searching = true;
  els.searchBtn.disabled = true;
  els.searchBtn.textContent = "Searching…";
  renderLoading();

  try {
    const data = await loadYearData(year);

    const area = resolveArea(state, county, data.geo);
    if (area.area === null) {
      const help =
        area.detail === "No state match"
          ? "We couldn't match that state. Try the full name or the two-letter abbreviation, e.g. “Texas” or “TX”."
          : "We found the state, but not that county. Try the official county name, e.g. “Travis County”.";
      renderMessage("empty", "No location match", `${area.detail}. ${help}`);
      return;
    }

    const matches = matchKeywords(keywords, data.occ, data.xwalk);
    if (matches.length === 0) {
      const kwText = keywords.map((k) => `“${k}”`).join(", ");
      renderMessage(
        "empty",
        "No occupations matched",
        `Area resolved to <strong>${area.areaName}</strong> (${area.detail}), but nothing matched ${kwText}. Try broader keywords.`,
      );
      return;
    }

    const wages = await loadWages(year, table, area.area);
    const rows = buildRows(matches, wages);
    currentYear = year;
    renderResults(rows, area.areaName as string, area.detail, keywords);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderMessage(
      "error",
      "Something went wrong",
      `We couldn't complete that search. ${message}`,
    );
  } finally {
    searching = false;
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = "Search wages";
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initTableToggle(): void {
  els.tableToggle.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".seg") as HTMLElement | null;
    if (!btn) return;
    table = (btn.dataset.table as WageTable) || "alc";
    els.tableToggle.querySelectorAll(".seg").forEach((s) => {
      const active = s === btn;
      s.classList.toggle("is-active", active);
      s.setAttribute("aria-checked", active ? "true" : "false");
    });
  });
}

function setFooterNote(yearId: string): void {
  const info = years.find((y) => y.id === yearId);
  if (info && els.footerYearNote) {
    els.footerYearNote.textContent = `Showing ${info.sourceNote}. `;
  }
}

async function init(): Promise<void> {
  initTheme();
  initTableToggle();

  stateDd = new Dropdown(document.getElementById("state-dd") as HTMLElement, {
    mode: "combobox",
    inputId: "state",
    labelledBy: "state-label",
    emptyText: "No matching state",
    onChange: () => refreshCountyOptions(),
    onType: () => refreshCountyOptions(),
  });
  countyDd = new Dropdown(document.getElementById("county-dd") as HTMLElement, {
    mode: "combobox",
    inputId: "county",
    labelledBy: "county-label",
    emptyText: "Choose a state to list its counties",
  });
  yearDd = new Dropdown(document.getElementById("year-dd") as HTMLElement, {
    mode: "select",
    labelledBy: "year-label",
    placeholder: "Select year",
    onChange: (v) => {
      setFooterNote(v);
      void refreshYear(v);
    },
  });

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void runSearch();
  });

  renderMessage(
    "welcome",
    "Start a search",
    "Enter one or more job titles with a state and county above. Results show every matching occupation, each with its four annual wage levels and description, sorted from the lowest average wage upward.",
  );

  try {
    const yearsFile = await loadYears();
    years = yearsFile.years;
    yearDd.setOptions(years.map((y) => ({ value: y.id, label: y.label })));
    yearDd.value = yearsFile.default;
    setFooterNote(yearsFile.default);
    await refreshYear(yearsFile.default);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderMessage("error", "Couldn't load data", message);
  }
}

const loadedYearData = new Map<string, YearData>();
function yearDataFor(year: string): YearData | undefined {
  return loadedYearData.get(year);
}

async function refreshYear(year: string): Promise<void> {
  const data = await loadYearData(year);
  loadedYearData.set(year, data);
  stateDd.setOptions(statesFromData(data));
  refreshCountyOptions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
