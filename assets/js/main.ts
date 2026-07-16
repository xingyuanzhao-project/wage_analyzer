import { loadYears, loadYearData, loadWages, type YearData } from "./lib/dataLoader";
import { resolveArea } from "./lib/geography";
import { matchSoccodes } from "./lib/match";
import { buildRows } from "./lib/pipeline";
import type { YearInfo, WageTable, ResultRow } from "./lib/types";

const DESC_CLAMP_CHARS = 260;

const els = {
  form: document.getElementById("search-form") as HTMLFormElement,
  year: document.getElementById("year") as HTMLSelectElement,
  tableToggle: document.getElementById("table-toggle") as HTMLElement,
  keyword: document.getElementById("keyword") as HTMLInputElement,
  state: document.getElementById("state") as HTMLInputElement,
  county: document.getElementById("county") as HTMLInputElement,
  stateList: document.getElementById("state-list") as HTMLDataListElement,
  countyList: document.getElementById("county-list") as HTMLDataListElement,
  searchBtn: document.getElementById("search-btn") as HTMLButtonElement,
  hint: document.getElementById("form-hint") as HTMLParagraphElement,
  results: document.getElementById("results") as HTMLElement,
  footerYearNote: document.getElementById("footer-year-note") as HTMLElement,
  cardTpl: document.getElementById("tpl-result-card") as HTMLTemplateElement,
  themeToggle: document.getElementById("theme-toggle") as HTMLButtonElement,
};

let years: YearInfo[] = [];
let table: WageTable = "alc";

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

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Datalists
// ---------------------------------------------------------------------------

function populateStateList(data: YearData): void {
  const names = new Set<string>();
  for (const row of data.geo) {
    if (row.state) names.add(row.state);
  }
  const sorted = Array.from(names).sort((a, b) => a.localeCompare(b));
  els.stateList.innerHTML = sorted
    .map((n) => `<option value="${escapeAttr(n)}"></option>`)
    .join("");
}

function populateCountyList(data: YearData, stateInput: string): void {
  const q = stateInput.trim().toLowerCase();
  if (!q) {
    els.countyList.innerHTML = "";
    return;
  }
  const counties = new Set<string>();
  for (const row of data.geo) {
    if (row.state.toLowerCase() === q || row.stateAb.toLowerCase() === q) {
      if (row.county) counties.add(row.county);
    }
  }
  const sorted = Array.from(counties).sort((a, b) => a.localeCompare(b));
  els.countyList.innerHTML = sorted
    .map((c) => `<option value="${escapeAttr(c)}"></option>`)
    .join("");
}

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
  keyword: string,
): void {
  const tableName = table === "alc" ? "All industries (ACWIA)" : "Higher education (ACWIA)";
  const withWage = rows.filter((r) => r.hasWage && r.avg !== null).length;

  const summary = `<div class="results__summary">
      <div>
        <span class="results__area">${areaName}</span>
        <span class="results__geo">${geoDetail}</span>
      </div>
      <div class="results__meta">
        <span class="pill">${rows.length} match${rows.length === 1 ? "" : "es"}</span>
        <span class="pill pill--muted">${tableName}</span>
        <span class="results__sort">Sorted by annual average, low &rarr; high</span>
      </div>
    </div>`;

  const list = document.createElement("div");
  list.className = "results__list";
  for (const row of rows) list.appendChild(renderCard(row));

  setResultsHTML(summary);
  if (withWage === 0) {
    const note = document.createElement("p");
    note.className = "results__nowage";
    note.textContent = `No wage rows exist for “${keyword}” in this area. The matched occupations are listed below without wage figures.`;
    els.results.appendChild(note);
  }
  els.results.appendChild(list);
}

function renderCard(row: ResultRow): HTMLElement {
  const node = els.cardTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  if (!row.hasWage || row.avg === null) node.classList.add("card--nowage");

  (node.querySelector(".card__title") as HTMLElement).textContent = row.title;
  (node.querySelector(".chip--soc") as HTMLElement).textContent = row.soccode;

  const via = node.querySelector(".chip--via") as HTMLElement;
  const uniqueOnet = Array.from(new Set(row.onetHits));
  if (uniqueOnet.length) {
    via.hidden = false;
    via.textContent = "via " + uniqueOnet.join(", ");
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
  const toggle = node.querySelector(".card__desc-toggle") as HTMLButtonElement;
  descText.textContent = row.description || "No description available.";
  if ((row.description || "").length > DESC_CLAMP_CHARS) {
    descText.classList.add("is-clamped");
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      const clamped = descText.classList.toggle("is-clamped");
      toggle.textContent = clamped ? "Show more" : "Show less";
    });
  }

  return node;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searching = false;

async function runSearch(): Promise<void> {
  if (searching) return;

  const keyword = els.keyword.value.trim();
  const state = els.state.value.trim();
  const county = els.county.value.trim();
  const year = els.year.value;

  const missing: string[] = [];
  if (!keyword) missing.push("a job keyword");
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

    const matches = matchSoccodes(keyword, data.occ, data.xwalk);
    if (matches.length === 0) {
      renderMessage(
        "empty",
        "No occupations matched",
        `Area resolved to <strong>${area.areaName}</strong> (${area.detail}), but nothing matched “${keyword}”. Try a broader keyword.`,
      );
      return;
    }

    const wages = await loadWages(year, table, area.area);
    const rows = buildRows(matches, wages);
    renderResults(rows, area.areaName as string, area.detail, keyword);
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

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void runSearch();
  });
  els.state.addEventListener("change", () => {
    const data = yearDataFor(els.year.value);
    if (data) populateCountyList(data, els.state.value);
  });
  els.year.addEventListener("change", () => {
    setFooterNote(els.year.value);
    void refreshYear(els.year.value);
  });

  renderMessage(
    "welcome",
    "Start a search",
    "Enter a job keyword with a state and county above. Results show every matching occupation, each with its four annual wage levels and description, sorted from the lowest average wage upward.",
  );

  try {
    const yearsFile = await loadYears();
    years = yearsFile.years;
    els.year.innerHTML = years
      .map((y) => `<option value="${escapeAttr(y.id)}">${y.label}</option>`)
      .join("");
    els.year.value = yearsFile.default;
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
  populateStateList(data);
  populateCountyList(data, els.state.value);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
