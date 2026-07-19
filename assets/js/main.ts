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
import { formatUSD } from "./lib/format";
import {
  orderCodes,
  renderProfile,
  renderAggregateReport,
  aggregateReportToText,
  type AggregateEntry,
} from "./lib/onetView";
import type { YearInfo, WageTable, ResultRow, OnetBundle, OnetHit } from "./lib/types";

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

// Compile / report-view wiring. The aggregate is built only when the user
// chooses "Compile", never on every tick, so the selection handlers and the
// compile action reach the toolbar button and report panel through these.
let compileBtn: HTMLButtonElement | null = null;
let compileLabelEl: HTMLElement | null = null;
let compileCountEl: HTMLElement | null = null;
let reportTabBadge: HTMLElement | null = null;
let switchViewFn: ((view: "explorer" | "report") => void) | null = null;
// Signature of the selection the on-screen report was compiled from (null until
// the first compile). When it diverges from the live selection, the report is
// stale and the UI says so rather than silently showing old numbers.
let compiledSignature: string | null = null;
let compiling = false;

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
  compiledSignature = null;
  compiling = false;

  const activeSeg = els.tableToggle.querySelector<HTMLElement>(".seg.is-active");
  const tableName = (activeSeg?.textContent ?? "").trim();
  const withWage = rows.filter((r) => r.hasWage && r.avg !== null).length;

  els.results.textContent = "";

  // --- top toolbar: page tabs (Job Explorer | Aggregated report) on the left,
  //     the Compile action on the far right ---
  const tabs = document.createElement("div");
  tabs.className = "view-tabs";
  const tabList = makeEl("div", "view-tabs__list");
  tabList.setAttribute("role", "tablist");
  const explorerTab = makeTab("Job Explorer", true);
  const reportTab = makeTab("Aggregated report", false);
  reportTabBadge = makeEl("span", "view-tab__badge");
  reportTabBadge.hidden = true;
  reportTab.appendChild(reportTabBadge);
  tabList.append(explorerTab, reportTab);

  compileBtn = document.createElement("button");
  compileBtn.type = "button";
  compileBtn.className = "view-tabs__compile";
  compileBtn.disabled = true;
  compileLabelEl = makeEl("span", "view-tabs__compile-label", "Compile aggregated job description");
  compileCountEl = makeEl("span", "view-tabs__compile-count");
  compileCountEl.hidden = true;
  compileBtn.append(compileLabelEl, compileCountEl);
  compileBtn.addEventListener("click", () => void compileReport());

  tabs.append(tabList, compileBtn);
  els.results.appendChild(tabs);

  // --- Job Explorer panel: summary bar + result cards ---
  const explorerPanel = makeEl("div", "view-panel");
  explorerPanel.setAttribute("role", "tabpanel");
  els.results.appendChild(explorerPanel);

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
  explorerPanel.appendChild(summary);

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

  if (withWage === 0) {
    const note = document.createElement("p");
    note.className = "results__nowage";
    note.textContent =
      "No wage figures are published for these occupations in this area. They are listed below for reference.";
    explorerPanel.appendChild(note);
  }

  // Re-rendered on sort; selections preserved via the shared `selected` Set.
  listEl = document.createElement("div");
  listEl.className = "results__list";
  explorerPanel.appendChild(listEl);

  // --- Aggregated report panel (built on demand by compileReport) ---
  const reportPanel = makeEl("div", "view-panel");
  reportPanel.setAttribute("role", "tabpanel");
  reportPanel.hidden = true;
  aggregateEl = document.createElement("section");
  aggregateEl.className = "aggregate";
  aggregateEl.setAttribute("aria-live", "polite");
  reportPanel.appendChild(aggregateEl);
  els.results.appendChild(reportPanel);

  // Tabs only toggle panel visibility; ticking a card never switches view and
  // never builds the report -- that waits for an explicit Compile.
  switchViewFn = (view) => {
    const explorer = view === "explorer";
    explorerTab.classList.toggle("is-active", explorer);
    reportTab.classList.toggle("is-active", !explorer);
    explorerTab.setAttribute("aria-selected", explorer ? "true" : "false");
    reportTab.setAttribute("aria-selected", explorer ? "false" : "true");
    explorerPanel.hidden = !explorer;
    reportPanel.hidden = explorer;
  };
  explorerTab.addEventListener("click", () => switchViewFn?.("explorer"));
  reportTab.addEventListener("click", () => switchViewFn?.("report"));

  renderReportPlaceholder();
  renderList();
}

function renderList(): void {
  if (!listEl) return;
  const sorted = sortRows(currentRows, sortMode);
  const showKeywords = currentKeywords.length > 1;
  listEl.textContent = "";
  for (const row of sorted) listEl.appendChild(renderCard(row, showKeywords));
  refreshCompileUi();
}

// The report is a snapshot of one Compile. This token drops a compile whose
// bundle loads finish after a newer compile has started, so the panel never
// shows a stale in-flight build.
let compileToken = 0;

/** A job contributes only the child roles ticked on its card. */
function gatherChosen(): { row: ResultRow; codes: string[] }[] {
  return sortRows(currentRows, sortMode)
    .map((row) => ({
      row,
      codes: row.onetChildren.map((c) => c.code).filter((code) => selected.has(code)),
    }))
    .filter((x) => x.codes.length > 0);
}

/** Order-independent fingerprint of the ticked roles; equal signatures mean the
 *  compiled report still matches the live selection. */
function selectionSignature(): string {
  return [...selected].sort().join("|");
}

/**
 * Reconcile the toolbar Compile button and the report panel with the current
 * selection. Called on every tick -- it updates the count and enabled/stale
 * state but never builds the report (that is Compile's job).
 */
function refreshCompileUi(): void {
  const count = selected.size;
  if (compileBtn) compileBtn.disabled = count === 0 || compiling;
  if (compileCountEl) {
    compileCountEl.textContent = String(count);
    compileCountEl.hidden = count === 0;
  }
  const stale = compiledSignature !== null && compiledSignature !== selectionSignature();
  if (compileBtn) compileBtn.classList.toggle("is-stale", stale && count > 0 && !compiling);

  if (compiling) return; // leave the progress bar untouched mid-compile
  if (compiledSignature === null) renderReportPlaceholder();
  else setReportStale(stale);
}

/** The report panel before any compile: a prompt that reflects how many roles
 *  are ticked, with an inline Compile shortcut once at least one is. */
function renderReportPlaceholder(): void {
  if (!aggregateEl) return;
  aggregateEl.textContent = "";
  aggregateEl.classList.remove("is-active");
  const count = selected.size;
  const box = makeEl("div", "aggregate__empty");
  if (count === 0) {
    box.textContent =
      "Tick one or more roles in Job Explorer, then choose Compile aggregated job description.";
  } else {
    box.append(`${count} role${count === 1 ? "" : "s"} selected. `);
    const btn = makeEl("button", "link-btn", "Compile now") as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", () => void compileReport());
    box.appendChild(btn);
  }
  aggregateEl.appendChild(box);
}

/** Show/refresh (or clear) the "report is out of date" banner atop the report. */
function setReportStale(stale: boolean): void {
  if (!aggregateEl) return;
  let banner = aggregateEl.querySelector<HTMLElement>(".agg-stale");
  if (!stale || compiledSignature === null) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = makeEl("div", "agg-stale");
    const text = makeEl("span", "agg-stale__text");
    const btn = makeEl("button", "link-btn agg-stale__btn", "Recompile") as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", () => void compileReport());
    banner.append(text, btn);
    aggregateEl.prepend(banner);
  }
  const count = selected.size;
  banner.querySelector(".agg-stale__text")!.textContent =
    count === 0
      ? "No roles selected — this report is out of date."
      : "Selection changed since this report was compiled.";
  banner.querySelector<HTMLButtonElement>(".agg-stale__btn")!.disabled = count === 0;
}

function updateReportTabBadge(roleCount: number): void {
  if (!reportTabBadge) return;
  reportTabBadge.textContent = String(roleCount);
  reportTabBadge.hidden = roleCount === 0;
}

/** A determinate progress bar tied to the actual O*NET bundle loads. */
function makeProgress(total: number): { el: HTMLElement; step: (done: number) => void } {
  const el = makeEl("div", "agg-progress");
  const label = makeEl("p", "agg-progress__label", `Compiling… 0 of ${total}`);
  const track = makeEl("div", "agg-progress__track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(total));
  track.setAttribute("aria-valuenow", "0");
  const fill = makeEl("i", "agg-progress__fill");
  fill.style.width = "0%";
  track.appendChild(fill);
  el.append(label, track);
  return {
    el,
    step(done: number) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 100;
      fill.style.width = `${pct}%`;
      track.setAttribute("aria-valuenow", String(done));
      label.textContent = done >= total ? "Assembling report…" : `Compiling… ${done} of ${total} jobs`;
    },
  };
}

/**
 * Build the aggregated report from the ticked roles: switch to the report tab,
 * show a progress bar while the O*NET bundles load, then render the pooled
 * sections. This runs only on an explicit Compile, so selecting roles stays
 * cheap and the report is a deliberate snapshot the user asked for.
 */
async function compileReport(): Promise<void> {
  if (!aggregateEl || !switchViewFn) return;
  const chosen = gatherChosen();
  if (chosen.length === 0) return;
  const roleCount = chosen.reduce((n, x) => n + x.codes.length, 0);
  const signature = selectionSignature();
  const token = ++compileToken;

  compiling = true;
  switchViewFn("report");
  if (compileLabelEl) compileLabelEl.textContent = "Compiling…";
  refreshCompileUi(); // disables the button, drops the stale flag

  aggregateEl.textContent = "";
  aggregateEl.classList.add("is-active");
  const progress = makeProgress(chosen.length);
  aggregateEl.appendChild(progress.el);

  let done = 0;
  const bundles = await Promise.all(
    chosen.map(async (x) => {
      const bundle = await loadOnetSafe(x.row.soccode);
      progress.step(++done);
      return bundle;
    }),
  );
  if (token !== compileToken) return; // a newer compile superseded this one

  const entries: AggregateEntry[] = chosen.map((x, i) => ({
    row: x.row,
    bundle: bundles[i],
    codes: x.codes,
  }));
  compiledSignature = signature;
  compiling = false;
  if (compileLabelEl) compileLabelEl.textContent = "Compile aggregated job description";

  aggregateEl.textContent = "";
  const head = document.createElement("div");
  head.className = "aggregate__head";
  const count = makeEl(
    "span",
    "aggregate__count",
    `${roleCount} role${roleCount === 1 ? "" : "s"} across ${chosen.length} job${chosen.length === 1 ? "" : "s"}`,
  );
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "aggregate__copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => void copyAggregate(entries, copyBtn));
  head.append(count, copyBtn);
  aggregateEl.appendChild(head);
  aggregateEl.appendChild(renderAggregateReport(entries, () => void compileReport(), renderTiers));

  updateReportTabBadge(roleCount);
  refreshCompileUi();
}

async function copyAggregate(entries: AggregateEntry[], btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(aggregateReportToText(entries));
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

function makeTab(label: string, active: boolean): HTMLButtonElement {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "view-tab" + (active ? " is-active" : "");
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", active ? "true" : "false");
  tab.append(label);
  return tab;
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

/** One O*NET-SOC sub-role checkbox row (small box + code + title). */
function makeRoleRow(
  child: OnetHit,
  matched: boolean,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "card__role" + (matched ? " card__role--matched" : "");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "card__role-input";
  label.append(
    input,
    makeEl("span", "card__role-box"),
    makeEl("span", "card__role-code", child.code),
    makeEl("span", "card__role-title", child.title),
  );
  return { label, input };
}

/**
 * Wire a card's selection to the shared `selected` set, which holds O*NET-SOC
 * child codes -- the unit that feeds the aggregate. The card's main checkbox is
 * a parent over its children: checked when all are ticked, indeterminate when
 * some are, and it toggles the whole set. Multi-role SOCs also render one box
 * per child so a single role (e.g. Business Intelligence Analysts) can be
 * aggregated on its own. Wages exist only at the SOC level, so these boxes scope
 * which sub-role detail is pooled; they never imply a per-sub-role wage.
 */
function wireSelection(node: HTMLElement, row: ResultRow): void {
  const parent = node.querySelector(".card__select-input") as HTMLInputElement;
  parent.setAttribute("aria-label", `Add ${row.title} to the aggregated job description`);

  const childCodes = row.onetChildren.map((c) => c.code);
  const matchedCodes = new Set(row.onetHits.map((h) => h.code));
  const childControls: { code: string; input: HTMLInputElement }[] = [];

  const selectedCount = (): number =>
    childCodes.reduce((n, code) => n + (selected.has(code) ? 1 : 0), 0);

  const syncParent = (): void => {
    const n = selectedCount();
    parent.checked = n === childCodes.length;
    parent.indeterminate = n > 0 && n < childCodes.length;
    node.classList.toggle("is-selected", n > 0);
  };

  // Multi-role SOCs expose each child; a single-child SOC is driven by the
  // parent box alone (its lone child would just restate the card title).
  if (row.onetChildren.length > 1) {
    const roles = node.querySelector(".card__roles") as HTMLElement;
    roles.hidden = false;
    const ordered = row.onetChildren
      .slice()
      .sort(
        (a, b) =>
          (matchedCodes.has(a.code) ? 0 : 1) - (matchedCodes.has(b.code) ? 0 : 1) ||
          a.code.localeCompare(b.code),
      );
    for (const child of ordered) {
      const { label, input } = makeRoleRow(child, matchedCodes.has(child.code));
      input.checked = selected.has(child.code);
      input.addEventListener("change", () => {
        if (input.checked) selected.add(child.code);
        else selected.delete(child.code);
        syncParent();
        refreshCompileUi();
      });
      childControls.push({ code: child.code, input });
      roles.appendChild(label);
    }
  }

  parent.addEventListener("change", () => {
    const selectAll = selectedCount() < childCodes.length;
    for (const code of childCodes) {
      if (selectAll) selected.add(code);
      else selected.delete(code);
    }
    for (const { code, input } of childControls) input.checked = selected.has(code);
    syncParent();
    refreshCompileUi();
  });

  syncParent();
}

/**
 * Fill a `.tiers` block's four `.tier` rows with a row's wage levels: each bar is
 * scaled to that row's own highest level and shows the annual value. One
 * implementation shared by the result card and the aggregate report.
 */
function fillTiers(tiers: HTMLElement, row: ResultRow): void {
  const levels = [row.l1, row.l2, row.l3, row.l4];
  const scaleMax = Math.max(0, ...levels.filter((v): v is number => v !== null));
  tiers.querySelectorAll(".tier").forEach((tier, i) => {
    const v = levels[i];
    const bar = tier.querySelector("i") as HTMLElement;
    (tier.querySelector(".tier__value") as HTMLElement).textContent = formatUSD(v);
    if (v !== null && scaleMax > 0) {
      bar.style.width = Math.max(4, (v / scaleMax) * 100) + "%";
    } else {
      bar.style.width = "0%";
      tier.classList.add("tier--empty");
    }
  });
}

/**
 * A standalone `.tiers` element for a row, cloned from the card template so the
 * four level labels have a single source (the template in layouts/home.html).
 * Injected into the aggregate report, which is built in script.
 */
function renderTiers(row: ResultRow): HTMLElement {
  const tiers = els.cardTpl.content.querySelector(".tiers")!.cloneNode(true) as HTMLElement;
  fillTiers(tiers, row);
  return tiers;
}

function renderCard(row: ResultRow, showKeywords: boolean): HTMLElement {
  const node = els.cardTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.soc = row.soccode;
  if (!row.hasWage || row.avg === null) node.classList.add("card--nowage");

  (node.querySelector(".card__soc") as HTMLElement).textContent = row.soccode;
  (node.querySelector(".card__title") as HTMLElement).textContent = row.title;

  if (showKeywords) {
    const tags = node.querySelector(".card__tags") as HTMLElement;
    tags.hidden = false;
    for (const kw of row.matchedKeywords) tags.appendChild(makeEl("span", "chip chip--kw", kw));
  }

  wireSelection(node, row);

  (node.querySelector(".card__avg-value") as HTMLElement).textContent = formatUSD(row.avg);
  fillTiers(node.querySelector(".tiers") as HTMLElement, row);

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
