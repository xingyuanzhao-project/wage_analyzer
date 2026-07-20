import type {
  OnetBundle,
  OnetProfile,
  OnetElement,
  OnetJobZone,
  OnetSoftwareCategory,
  OnetSoftwareExample,
  OnetEducation,
  ResultRow,
} from "./types";
import { formatUSD } from "./format";
import { Pdf, rgb, type Color, type Run } from "./pdf";

// How many items each section shows before a "Show all" toggle appears. Copy
// output is never capped -- the cap is a display affordance, not data loss.
const PREVIEW_CAP = 6;

// How many source chips a pooled aggregate item shows before "+N".
const SOURCE_CHIP_CAP = 4;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Order a SOC's O*NET children so the ones that matched the search come first. */
export function orderCodes(bundle: OnetBundle, matched: Set<string>): string[] {
  const codes = Object.keys(bundle);
  const rank = (code: string) => (matched.has(code) ? 0 : 1);
  return codes.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A titled section whose list collapses to PREVIEW_CAP items with a toggle. */
function cappedSection(title: string, items: HTMLLIElement[]): HTMLElement | null {
  if (items.length === 0) return null;

  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append(title);
  const count = h("span", "onet-sec__count", String(items.length));
  heading.appendChild(count);
  section.appendChild(heading);

  const list = h("ul", "onet-list");
  items.forEach((li, i) => {
    if (i >= PREVIEW_CAP) li.hidden = true;
    list.appendChild(li);
  });
  section.appendChild(list);

  if (items.length > PREVIEW_CAP) {
    const toggle = h("button", "link-btn onet-sec__more");
    toggle.type = "button";
    toggle.textContent = `Show all ${items.length}`;
    let expanded = false;
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      items.forEach((li, i) => {
        if (i >= PREVIEW_CAP) li.hidden = !expanded;
      });
      toggle.textContent = expanded ? "Show fewer" : `Show all ${items.length}`;
    });
    section.appendChild(toggle);
  }

  return section;
}

function taskLi(text: string, supplemental: boolean): HTMLLIElement {
  const li = h("li", "onet-list__item");
  li.append(text);
  // "Supplemental" is the only meaningful contrast to core work; other values
  // ("n/a" on data-level .00 codes) mean unclassified, so carry no tag.
  if (supplemental) li.appendChild(h("span", "onet-tag", "Supplemental"));
  return li;
}

function taskItems(tasks: OnetProfile["tasks"]): HTMLLIElement[] {
  if (!tasks) return [];
  return tasks.map((t) => taskLi(t.text, t.type === "Supplemental"));
}

function textItems(texts: string[] | undefined): HTMLLIElement[] {
  if (!texts) return [];
  return texts.map((t) => h("li", "onet-list__item", t));
}

function elementLi(el: OnetElement): HTMLLIElement {
  const li = h("li", "onet-list__item");
  li.appendChild(h("strong", "onet-el__name", el.name));
  if (el.description) {
    li.append(" — ");
    li.appendChild(h("span", "onet-el__desc", el.description));
  }
  return li;
}

function elementItems(elements: OnetElement[] | undefined): HTMLLIElement[] {
  if (!elements) return [];
  return elements.map(elementLi);
}

function softwareChip(ex: OnetSoftwareExample): HTMLElement {
  const chip = h("span", "onet-chip");
  chip.append(ex.name);
  if (ex.hot) chip.appendChild(h("span", "onet-chip__flag onet-chip__flag--hot", "Hot"));
  else if (ex.inDemand) chip.appendChild(h("span", "onet-chip__flag", "In demand"));
  return chip;
}

function softwareLi(category: string, examples: OnetSoftwareExample[]): HTMLLIElement {
  const li = h("li", "onet-list__item onet-soft");
  li.appendChild(h("span", "onet-soft__cat", category));
  const chips = h("span", "onet-soft__examples");
  for (const ex of examples) chips.appendChild(softwareChip(ex));
  li.appendChild(chips);
  return li;
}

function softwareItems(cats: OnetSoftwareCategory[] | undefined): HTMLLIElement[] {
  if (!cats) return [];
  return cats.map((cat) => softwareLi(cat.category, cat.examples));
}

function jobZoneBlock(jz: OnetJobZone): HTMLElement {
  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append("Job Zone");
  heading.appendChild(h("span", "onet-sec__count", `Zone ${jz.zone}`));
  section.appendChild(heading);

  section.appendChild(h("p", "onet-zone__name", jz.name));

  const dl = h("dl", "onet-zone");
  const add = (term: string, value: string) => {
    if (!value) return;
    dl.appendChild(h("dt", "onet-zone__term", term));
    dl.appendChild(h("dd", "onet-zone__def", value));
  };
  add("Education", jz.education);
  add("Related experience", jz.experience);
  add("Job training", jz.training);
  add("SVP range", jz.svp);
  section.appendChild(dl);
  return section;
}

/**
 * O*NET's Required Level of Education (RL) scale: each category label mapped to
 * its ordinal (1 = least ... 12 = most), transcribed verbatim from O*NET's
 * "Education Categories" reference (element 2.D.1). The per-occupation data
 * stores education only as {level, percent}, so this one table is what lets the
 * UI order a distribution by level instead of by frequency -- no ordinal is
 * carried in the data, and this is the single place the ordering is defined.
 */
const EDU_LEVEL_ORDER: Record<string, number> = {
  "Less than a High School Diploma": 1,
  "High School Diploma - or the equivalent (for example, GED)": 2,
  "Post-Secondary Certificate - awarded for training completed after high school (for example, in agriculture or natural resources, computer services, personal or culinary services, engineering technologies, healthcare, construction trades, mechanic and repair technologies, or precision production)": 3,
  "Some College Courses": 4,
  "Associate's Degree (or other 2-year degree)": 5,
  "Bachelor's Degree": 6,
  "Post-Baccalaureate Certificate - awarded for completion of an organized program of study; designed for people who have completed a Baccalaureate degree but do not meet the requirements of academic degrees carrying the title of Master.": 7,
  "Master's Degree": 8,
  "Post-Master's Certificate - awarded for completion of an organized program of study; designed for people who have completed a Master's degree but do not meet the requirements of academic degrees at the doctoral level.": 9,
  "First Professional Degree - awarded for completion of a program that: requires at least 2 years of college work before entrance into the program, includes a total of at least 6 academic years of work to complete, and provides all remaining academic requirements to begin practice in a profession.": 10,
  "Doctoral Degree": 11,
  "Post-Doctoral Training": 12,
};

/**
 * Order a distribution by education level, low to high, so it reads
 * Associate's -> Bachelor's -> Master's -> ... regardless of which level is most
 * common. An unrecognized label sorts last, keeping the render stable.
 */
function eduByLevel(edu: OnetEducation[]): OnetEducation[] {
  const rankOf = (level: string) => EDU_LEVEL_ORDER[level] ?? Number.MAX_SAFE_INTEGER;
  return edu.slice().sort((a, b) => rankOf(a.level) - rankOf(b.level));
}

function educationList(edu: OnetEducation[]): HTMLElement {
  const list = h("ul", "onet-edu");
  const ordered = eduByLevel(edu);
  const max = Math.max(...ordered.map((e) => e.percent));
  for (const e of ordered) {
    const li = h("li", "onet-edu__row");
    li.appendChild(h("span", "onet-edu__label", e.level));
    const bar = h("span", "onet-edu__bar");
    const fill = h("i");
    fill.style.width = max > 0 ? `${Math.max(3, (e.percent / max) * 100)}%` : "0";
    bar.appendChild(fill);
    li.appendChild(bar);
    li.appendChild(h("span", "onet-edu__pct", `${e.percent}%`));
    list.appendChild(li);
  }
  return list;
}

function educationBlock(edu: OnetEducation[]): HTMLElement | null {
  if (edu.length === 0) return null;
  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append("Education");
  heading.appendChild(h("span", "onet-sec__count", "% of respondents"));
  section.appendChild(heading);
  section.appendChild(educationList(edu));
  return section;
}

/** Render one O*NET-SOC child profile as a structured block (card + aggregate). */
export function renderProfile(profile: OnetProfile, matched: boolean): HTMLElement {
  const article = h("article", "onet");
  if (matched) article.classList.add("onet--matched");

  const head = h("header", "onet__head");
  head.appendChild(h("h4", "onet__title", profile.title));
  head.appendChild(h("span", "chip chip--soc", profile.code));
  if (matched) head.appendChild(h("span", "chip chip--match", "matched"));
  article.appendChild(head);

  if (profile.description) {
    article.appendChild(h("p", "onet__desc", profile.description));
  }

  const sections: (HTMLElement | null)[] = [
    cappedSection("Tasks", taskItems(profile.tasks)),
    cappedSection("Detailed Work Activities", textItems(profile.dwas)),
    profile.jobZone ? jobZoneBlock(profile.jobZone) : null,
    cappedSection("Knowledge", elementItems(profile.knowledge)),
    cappedSection("Skills", elementItems(profile.essentialSkills)),
    cappedSection("Technology Skills", softwareItems(profile.software)),
    profile.education ? educationBlock(profile.education) : null,
  ];
  for (const section of sections) {
    if (section) article.appendChild(section);
  }
  return article;
}

// ---------------------------------------------------------------------------
// Aggregated report: pool the selected jobs' O*NET detail BY SECTION
//
// renderProfile (above) shows one job's roles stacked as full profiles. The
// aggregate answers a different question -- "what do ALL these jobs require?" --
// so it flattens every selected job to its distinct O*NET-SOC child roles and
// pools each section (Tasks, Skills, ...) across those roles: shared items are
// deduped and tagged with the role(s) that need them. Job Zone and Education are
// per-role facts that cannot merge into one list, so they are compared instead.
// ---------------------------------------------------------------------------

/**
 * One selected job, its loaded O*NET bundle (null if the fetch failed), and the
 * O*NET-SOC child codes ticked for it on the card. Only these codes are pooled,
 * so a job contributes exactly the sub-roles the user selected -- no more.
 */
export interface AggregateEntry {
  row: ResultRow;
  bundle: OnetBundle | null;
  codes: string[];
}

/** A distinct O*NET-SOC child role contributing to the pool. */
interface RoleRef {
  code: string;
  title: string;
  profile: OnetProfile;
}

/** A pooled item carries the O*NET codes of the roles that contributed it. */
type Pooled<T> = T & { sources: string[] };

/** Flatten selected jobs to the child roles ticked on their cards (matched
 *  first), deduped by O*NET code across the whole selection. */
function collectRoles(entries: AggregateEntry[]): RoleRef[] {
  const roles: RoleRef[] = [];
  const seen = new Set<string>();
  for (const { row, bundle, codes } of entries) {
    if (!bundle) continue;
    const wanted = new Set(codes);
    const matched = new Set(row.onetHits.map((hit) => hit.code));
    for (const code of orderCodes(bundle, matched)) {
      if (!wanted.has(code) || seen.has(code)) continue;
      seen.add(code);
      roles.push({ code, title: bundle[code].title, profile: bundle[code] });
    }
  }
  return roles;
}

/**
 * Pool one section across roles: group each role's items by `key`, dedupe, and
 * record which roles contributed each group. One general path for every list
 * section -- callers only supply how to read, key, seed, and fold an item.
 */
function poolItems<Src, Acc extends object>(
  roles: RoleRef[],
  read: (p: OnetProfile) => Src[] | undefined,
  key: (s: Src) => string,
  seed: (s: Src) => Acc,
  fold: (acc: Acc, s: Src) => void,
): Pooled<Acc>[] {
  const map = new Map<string, Pooled<Acc>>();
  for (const role of roles) {
    for (const s of read(role.profile) ?? []) {
      const k = key(s);
      let acc = map.get(k);
      if (!acc) {
        acc = { ...seed(s), sources: [] } as Pooled<Acc>;
        map.set(k, acc);
      }
      fold(acc, s);
      if (!acc.sources.includes(role.code)) acc.sources.push(role.code);
    }
  }
  return [...map.values()];
}

/** Most broadly-shared requirements first -- the point of the aggregate. */
function sortShared<T extends { sources: string[] }>(items: T[]): T[] {
  return items.sort((a, b) => b.sources.length - a.sources.length);
}

interface AggregatePools {
  tasks: Pooled<{ text: string; supplemental: boolean }>[];
  dwas: Pooled<{ text: string }>[];
  knowledge: Pooled<{ name: string; description: string }>[];
  skills: Pooled<{ name: string; description: string }>[];
  software: { category: string; examples: OnetSoftwareExample[]; sources: string[] }[];
  zones: Pooled<{ zone: number; name: string }>[];
  roles: RoleRef[]; // in selection order, for the per-role Education comparison
}

const elementSeed = (e: OnetElement) => ({ name: e.name, description: e.description });

/** Compute every pooled section once so the DOM view and the copy text agree. */
function buildPools(roles: RoleRef[]): AggregatePools {
  return {
    tasks: sortShared(
      poolItems(
        roles,
        (p) => p.tasks,
        (t) => t.text.trim().toLowerCase(),
        (t) => ({ text: t.text, supplemental: true }),
        // Tagged Supplemental only if EVERY contributing role marks it so --
        // the same rule renderProfile applies to a single profile's tasks.
        (acc, t) => {
          acc.supplemental = acc.supplemental && t.type === "Supplemental";
        },
      ),
    ),
    dwas: sortShared(
      poolItems(roles, (p) => p.dwas, (t) => t.trim().toLowerCase(), (t) => ({ text: t }), () => {}),
    ),
    knowledge: sortShared(
      poolItems(roles, (p) => p.knowledge, (e) => e.name.trim().toLowerCase(), elementSeed, () => {}),
    ),
    skills: sortShared(
      poolItems(roles, (p) => p.essentialSkills, (e) => e.name.trim().toLowerCase(), elementSeed, () => {}),
    ),
    software: sortShared(
      poolItems(
        roles,
        (p) => p.software,
        (c) => c.category.trim().toLowerCase(),
        (c) => ({ category: c.category, examples: new Map<string, OnetSoftwareExample>() }),
        (acc, c) => {
          for (const ex of c.examples) {
            const ek = ex.name.trim().toLowerCase();
            const prev = acc.examples.get(ek);
            if (!prev) acc.examples.set(ek, { ...ex });
            else {
              prev.hot = prev.hot || ex.hot;
              prev.inDemand = prev.inDemand || ex.inDemand;
            }
          }
        },
      ),
    ).map((c) => ({ category: c.category, examples: [...c.examples.values()], sources: c.sources })),
    zones: poolItems(
      roles,
      (p) => (p.jobZone ? [p.jobZone] : []),
      (jz) => String(jz.zone),
      (jz) => ({ zone: jz.zone, name: jz.name }),
      () => {},
    ).sort((a, b) => a.zone - b.zone),
    roles,
  };
}

function sourceChips(sources: string[], titleByCode: Map<string, string>): HTMLElement {
  const wrap = h("span", "agg-src");
  for (const code of sources.slice(0, SOURCE_CHIP_CAP)) {
    wrap.appendChild(h("span", "agg-src__chip", titleByCode.get(code) ?? code));
  }
  if (sources.length > SOURCE_CHIP_CAP) {
    wrap.appendChild(
      h("span", "agg-src__chip agg-src__chip--more", `+${sources.length - SOURCE_CHIP_CAP}`),
    );
  }
  return wrap;
}

/** A capped list section whose items carry source chips (shown only when the
 *  report spans more than one role, else every chip would say the same thing). */
function pooledSection(
  title: string,
  items: { li: HTMLLIElement; sources: string[] }[],
  titleByCode: Map<string, string>,
  showSrc: boolean,
): HTMLElement | null {
  const lis = items.map(({ li, sources }) => {
    if (showSrc) li.appendChild(sourceChips(sources, titleByCode));
    return li;
  });
  return cappedSection(title, lis);
}

/** Job Zone: distinct zones across roles, each showing which roles fall in it. */
function jobZoneSection(
  zones: AggregatePools["zones"],
  titleByCode: Map<string, string>,
  showSrc: boolean,
): HTMLElement | null {
  if (zones.length === 0) return null;
  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append("Job Zone");
  heading.appendChild(h("span", "onet-sec__count", zones.length === 1 ? "1 level" : `${zones.length} levels`));
  section.appendChild(heading);
  const list = h("ul", "onet-list");
  for (const z of zones) {
    const li = h("li", "onet-list__item");
    li.appendChild(h("strong", "onet-el__name", `Zone ${z.zone}`));
    li.append(` \u2014 ${z.name}`);
    if (showSrc) li.appendChild(sourceChips(z.sources, titleByCode));
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

/** Education: a percent distribution per role -- cannot merge, so compared. */
function educationSection(roles: RoleRef[]): HTMLElement | null {
  const blocks: HTMLElement[] = [];
  for (const role of roles) {
    const edu = role.profile.education;
    if (!edu?.length) continue;
    const block = h("div", "agg-edu");
    block.appendChild(h("p", "agg-edu__role", role.title));
    block.appendChild(educationList(edu));
    blocks.push(block);
  }
  if (blocks.length === 0) return null;
  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append("Education");
  heading.appendChild(h("span", "onet-sec__count", "% of respondents"));
  section.appendChild(heading);
  for (const block of blocks) section.appendChild(block);
  return section;
}

/**
 * A failed O*NET fetch is a load error, not evidence the detail was never
 * published -- every SOC in the crosswalk is written into a major-group shard
 * (see build_onet in data_prep/build_data.py), so a null bundle here always
 * means the shard fetch or lookup failed. Say so explicitly and offer a real
 * retry rather than a silent gap that reads as "no data exists."
 */
function loadFailureNote(jobTitles: string[], onRetry: () => void): HTMLElement {
  const note = h("p", "onet__error");
  note.append(
    jobTitles.length === 1
      ? `Couldn't load O*NET detail for ${jobTitles[0]}.`
      : `Couldn't load O*NET detail for ${jobTitles.length} jobs.`,
  );
  note.append(" ");
  const retry = h("button", "link-btn", "Retry");
  retry.type = "button";
  retry.addEventListener("click", onRetry);
  note.appendChild(retry);
  return note;
}

/** The selected-jobs strip: each job's title, SOC, average wage, the four wage
 *  levels, and the child roles ticked for it. Wages are published only at the
 *  SOC level, so the wage and tiers stay on the job line and the ticked
 *  sub-roles sit under them as JD contributors -- never as separately-priced
 *  rows. `renderTiers` is injected by the caller: main.ts owns the card template
 *  that the tier labels live in, so the level labels keep a single source. */
function rolesStrip(
  entries: AggregateEntry[],
  onRetry: () => void,
  renderTiers: (row: ResultRow) => HTMLElement,
): HTMLElement {
  const strip = h("div", "agg-roles");
  for (const { row, bundle, codes } of entries) {
    const item = h("div", "agg-role");
    const head = h("div", "agg-role__head");
    head.appendChild(h("span", "agg-role__title", row.title));
    head.appendChild(h("span", "chip chip--soc", row.soccode));
    head.appendChild(h("span", "agg-role__wage", `${formatUSD(row.avg)} avg / yr`));
    item.appendChild(head);
    item.appendChild(renderTiers(row));
    if (bundle) {
      const wanted = new Set(codes);
      const matched = new Set(row.onetHits.map((hit) => hit.code));
      const shown = orderCodes(bundle, matched).filter((code) => wanted.has(code));
      if (shown.length) {
        const subs = h("div", "agg-role__subs");
        for (const code of shown) {
          // "code Title" (e.g. 15-2051.01 Business Intelligence Analysts), the
          // same shape as the card's sub-role rows. Uniform styling -- matched vs
          // unmatched is not colour-coded here (only the list order reflects it).
          const sub = h("span", "agg-role__sub");
          sub.appendChild(h("span", "agg-role__sub-code", code));
          sub.appendChild(h("span", "agg-role__sub-title", bundle[code].title));
          subs.appendChild(sub);
        }
        item.appendChild(subs);
      }
    } else {
      item.appendChild(loadFailureNote([row.title], onRetry));
    }
    strip.appendChild(item);
  }
  return strip;
}

/**
 * Render the aggregate as section blocks pooled across all selected roles.
 * `onRetry` recompiles the aggregate (re-running compileReport), giving any SOC
 * whose O*NET fetch failed a real chance to succeed on a fresh request.
 * `renderTiers` draws a row's four wage levels, injected so the card and the
 * report share one tier renderer (and one source for the level labels).
 */
export function renderAggregateReport(
  entries: AggregateEntry[],
  onRetry: () => void,
  renderTiers: (row: ResultRow) => HTMLElement,
): HTMLElement {
  const wrap = h("div", "agg-report");
  wrap.appendChild(rolesStrip(entries, onRetry, renderTiers));

  const failedTitles = entries.filter((e) => !e.bundle).map((e) => e.row.title);
  const roles = collectRoles(entries);
  if (roles.length === 0) {
    wrap.appendChild(
      failedTitles.length > 0
        ? loadFailureNote(failedTitles, onRetry)
        : h("p", "onet__empty", "No O*NET detail is available for the selected roles."),
    );
    return wrap;
  }

  const pools = buildPools(roles);
  const titleByCode = new Map(roles.map((r) => [r.code, r.title]));
  const showSrc = roles.length > 1;

  const sections: (HTMLElement | null)[] = [
    pooledSection(
      "Tasks",
      pools.tasks.map((p) => ({ li: taskLi(p.text, p.supplemental), sources: p.sources })),
      titleByCode,
      showSrc,
    ),
    pooledSection(
      "Detailed Work Activities",
      pools.dwas.map((p) => ({ li: h("li", "onet-list__item", p.text), sources: p.sources })),
      titleByCode,
      showSrc,
    ),
    jobZoneSection(pools.zones, titleByCode, showSrc),
    pooledSection(
      "Knowledge",
      pools.knowledge.map((p) => ({ li: elementLi(p), sources: p.sources })),
      titleByCode,
      showSrc,
    ),
    pooledSection(
      "Skills",
      pools.skills.map((p) => ({ li: elementLi(p), sources: p.sources })),
      titleByCode,
      showSrc,
    ),
    pooledSection(
      "Technology Skills",
      pools.software.map((p) => ({ li: softwareLi(p.category, p.examples), sources: p.sources })),
      titleByCode,
      showSrc,
    ),
    educationSection(pools.roles),
  ];
  for (const section of sections) {
    if (section) wrap.appendChild(section);
  }
  return wrap;
}

/** Serialize the same pooled aggregate to plain structured text for clipboard. */
export function aggregateReportToText(entries: AggregateEntry[]): string {
  const roles = collectRoles(entries);
  const titleByCode = new Map(roles.map((r) => [r.code, r.title]));
  const showSrc = roles.length > 1;
  const jobWord = entries.length === 1 ? "job" : "jobs";
  const roleWord = roles.length === 1 ? "role" : "roles";
  const lines: string[] = [
    `Aggregated job description \u2014 ${roles.length} ${roleWord} across ${entries.length} ${jobWord}`,
  ];

  lines.push("", "Selected jobs:");
  for (const { row, bundle, codes } of entries) {
    const wanted = new Set(codes);
    // A null bundle is a failed fetch, not an absence of O*NET data (every SOC
    // has a published bundle) -- say so rather than silently dropping the roles.
    const suffix = !bundle
      ? ": [O*NET detail failed to load -- retry in the app]"
      : (() => {
          const subs = orderCodes(bundle, new Set(row.onetHits.map((hit) => hit.code)))
            .filter((code) => wanted.has(code))
            .map((code) => bundle[code].title)
            .join("; ");
          return subs ? `: ${subs}` : "";
        })();
    const tiers = [row.l1, row.l2, row.l3, row.l4]
      .map((v, i) => `L${i + 1} ${formatUSD(v)}`)
      .join(" / ");
    lines.push(`- ${row.title} (${row.soccode}, ${formatUSD(row.avg)} avg/yr; ${tiers})${suffix}`);
  }

  if (roles.length === 0) return lines.join("\n");

  const pools = buildPools(roles);
  const src = (sources: string[]): string =>
    showSrc ? ` (roles: ${sources.map((c) => titleByCode.get(c) ?? c).join(", ")})` : "";

  const bulletBlock = (title: string, rows: { text: string; sources: string[] }[]): void => {
    if (rows.length === 0) return;
    lines.push("", `${title}:`);
    for (const r of rows) lines.push(`- ${r.text}${src(r.sources)}`);
  };

  bulletBlock(
    "Tasks",
    pools.tasks.map((t) => ({ text: t.supplemental ? `${t.text} [Supplemental]` : t.text, sources: t.sources })),
  );
  bulletBlock("Detailed Work Activities", pools.dwas);

  if (pools.zones.length) {
    lines.push("", "Job Zone:");
    for (const z of pools.zones) lines.push(`- Zone ${z.zone} \u2014 ${z.name}${src(z.sources)}`);
  }

  const elementText = (e: { name: string; description: string; sources: string[] }): string =>
    (e.description ? `${e.name} \u2014 ${e.description}` : e.name) + src(e.sources);
  if (pools.knowledge.length) {
    lines.push("", "Knowledge:");
    for (const e of pools.knowledge) lines.push(`- ${elementText(e)}`);
  }
  if (pools.skills.length) {
    lines.push("", "Skills:");
    for (const e of pools.skills) lines.push(`- ${elementText(e)}`);
  }

  if (pools.software.length) {
    lines.push("", "Technology Skills:");
    for (const c of pools.software) {
      const examples = c.examples
        .map((ex) => (ex.hot ? `${ex.name} (hot)` : ex.inDemand ? `${ex.name} (in demand)` : ex.name))
        .join(", ");
      lines.push(`- ${c.category}: ${examples}${src(c.sources)}`);
    }
  }

  const eduRoles = pools.roles.filter((r) => r.profile.education?.length);
  if (eduRoles.length) {
    lines.push("", "Education (% of respondents):");
    for (const role of eduRoles) {
      const dist = eduByLevel(role.profile.education ?? [])
        .map((e) => `${e.level} ${e.percent}%`)
        .join(", ");
      lines.push(`- ${role.title}: ${dist}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Aggregated report: PDF view
//
// A third rendering of the same pooled aggregate (alongside the DOM view and the
// copy text), drawn with pdf.ts primitives so the download mirrors the on-screen
// report's layout -- role cards with four scaled wage bars, code+title sub-role
// pills, and each pooled section as a headed bullet list with role chips. What
// the HTML collapses (PREVIEW_CAP items, "+N" source chips) is drawn in full
// here: a downloaded document has no "Show all", so every item and every source
// is present.
// ---------------------------------------------------------------------------

// Light-theme tokens copied from main.css :root -- a printed page is always
// light, so the PDF does not follow the app's dark theme.
const PDF_INK = rgb("#121a2b");
const PDF_MUTED = rgb("#5c6780");
const PDF_FAINT = rgb("#8a94a8");
const PDF_ACCENT = rgb("#2563eb");
const PDF_BORDER = rgb("#e2e6ef");
const PDF_SUNKEN = rgb("#eef1f7");
const PDF_ELEVATED = rgb("#ffffff");
const PDF_WARN = rgb("#b45309");
const PDF_TIERS = [rgb("#7dd3fc"), rgb("#38bdf8"), rgb("#2563eb"), rgb("#1e3a8a")];

const TITLE_SIZE = 15;
const SUBTITLE_SIZE = 9.5;
const CARD_TITLE = 11.5;
const SOC_SIZE = 8.5;
const WAGE_SIZE = 9;
const TIER_LABEL = 8.5;
const TIER_VALUE = 9;
const TIER_ROW_H = 13;
const TIER_LABEL_W = 118;
const TIER_VALUE_W = 60;
const COL_GAP = 8;
const BAR_H = 5.5;
const CARD_PAD = 10;
const CARD_GAP = 9;
const SEC_TITLE = 9.5;
const SEC_COUNT = 8;
const SECTION_GAP = 11;
const ITEM_SIZE = 9.5;
const ITEM_LH = 12.6;
const ITEM_GAP = 2.5;
const SRC_CHIP = 7.5;
const TAG_CHIP = 7;
const SUB_CHIP = 8;
const EDU_LABEL = 8.5;
const EDU_LABEL_LH = 11;
const EDU_BAR_H = 5;
const EDU_PCT = 8.5;
const EDU_ROW_MIN = 12;

const CHIP_PADX = 4.5;
const CHIP_PADY = 2.4;
const CHIP_GAP = 4;
const CHIP_RADIUS = 3;
const BULLET_INDENT = 12;

interface PdfChip {
  parts: { text: string; color: Color; bold?: boolean }[];
  bg: Color;
  border: Color;
  size: number;
}

/** Baseline-align a secondary run of size `s` to a primary run of size `p` whose
 *  em box top is `pTop`, so codes/wages sit on the title's baseline. */
function alignTop(pTop: number, p: number, s: number): number {
  return pTop + (p - s) * 0.8;
}

function chipSize(pdf: Pdf, chip: PdfChip): { w: number; h: number } {
  const space = pdf.measure(" ", chip.size);
  let inner = 0;
  chip.parts.forEach((part, i) => {
    inner += pdf.measure(part.text, chip.size, part.bold);
    if (i > 0) inner += space;
  });
  return { w: inner + CHIP_PADX * 2, h: chip.size + CHIP_PADY * 2 };
}

function drawChip(pdf: Pdf, x: number, top: number, chip: PdfChip): void {
  const { w, h } = chipSize(pdf, chip);
  pdf.box(x, top, w, h, { fill: chip.bg, stroke: chip.border, radius: CHIP_RADIUS, lineWidth: 0.6 });
  const space = pdf.measure(" ", chip.size);
  let tx = x + CHIP_PADX;
  const ty = top + (h - chip.size) / 2;
  chip.parts.forEach((part, i) => {
    if (i > 0) tx += space;
    pdf.text(tx, ty, part.text, { size: chip.size, bold: part.bold, color: part.color });
    tx += pdf.measure(part.text, chip.size, part.bold);
  });
}

/** Flow chips left-to-right within [leftX, rightX], wrapping to new rows. Returns
 *  the last row's top and height; draw=false measures only (for pagination).
 *  `startRowH` seeds the first row's height so chips that trail wrapped text and
 *  overflow drop a full text line instead of colliding with it. */
function flowChips(
  pdf: Pdf,
  startX: number,
  top: number,
  leftX: number,
  rightX: number,
  chips: PdfChip[],
  draw: boolean,
  startRowH = 0,
): { rowTop: number; rowH: number } {
  let cx = startX;
  let cy = top;
  let rowH = startRowH;
  for (const chip of chips) {
    const { w, h } = chipSize(pdf, chip);
    if (cx + w > rightX && cx > leftX) {
      cy += rowH + 3;
      cx = leftX;
      rowH = 0;
    }
    if (draw) drawChip(pdf, cx, cy, chip);
    cx += w + CHIP_GAP;
    rowH = Math.max(rowH, h);
  }
  return { rowTop: cy, rowH };
}

/** Source-attribution chips for a pooled item -- all of them (no "+N" cap),
 *  shown only when the report spans more than one role. */
function srcChips(sources: string[], titleByCode: Map<string, string>, showSrc: boolean): PdfChip[] {
  if (!showSrc) return [];
  return sources.map((code) => ({
    parts: [{ text: titleByCode.get(code) ?? code, color: PDF_MUTED }],
    bg: PDF_SUNKEN,
    border: PDF_BORDER,
    size: SRC_CHIP,
  }));
}

function sectionHeading(pdf: Pdf, title: string, count: string, x: number): void {
  pdf.ensure(SEC_TITLE + 8 + ITEM_LH);
  const upper = title.toUpperCase();
  pdf.text(x, pdf.top, upper, { size: SEC_TITLE, bold: true, color: PDF_INK });
  if (count) {
    const tw = pdf.measure(upper, SEC_TITLE, true);
    pdf.text(x + tw + 6, alignTop(pdf.top, SEC_TITLE, SEC_COUNT), count, { size: SEC_COUNT, color: PDF_FAINT });
  }
  pdf.top += SEC_TITLE + 7;
}

/** A "• text …" bullet with a hanging indent, followed by trailing chips (tags,
 *  sources). Measures the whole block first so it never breaks across a page. */
function bulletItem(pdf: Pdf, x: number, w: number, runs: Run[], chips: PdfChip[]): void {
  const textX = x + BULLET_INDENT;
  const textW = w - BULLET_INDENT;
  const rightX = x + w;

  const dry = pdf.paragraph(textX, 0, textW, runs, ITEM_SIZE, ITEM_LH, false);
  let bottom = dry.endTop + ITEM_LH;
  if (chips.length) {
    const c = flowChips(pdf, dry.endX + CHIP_GAP, dry.endTop, textX, rightX, chips, false, ITEM_LH);
    bottom = Math.max(bottom, c.rowTop + c.rowH);
  }
  pdf.ensure(bottom + ITEM_GAP);

  const top = pdf.top;
  pdf.text(x, top, "\u2022", { size: ITEM_SIZE, color: PDF_MUTED });
  const p = pdf.paragraph(textX, top, textW, runs, ITEM_SIZE, ITEM_LH, true);
  let realBottom = p.endTop + ITEM_LH;
  if (chips.length) {
    const c = flowChips(pdf, p.endX + CHIP_GAP, p.endTop, textX, rightX, chips, true, ITEM_LH);
    realBottom = Math.max(realBottom, c.rowTop + c.rowH);
  }
  pdf.top = realBottom + ITEM_GAP;
}

/** One selected job: title, SOC code, average wage, four scaled wage bars, and
 *  the ticked sub-role pills (or a load-failure note). */
function drawJobCard(pdf: Pdf, entry: AggregateEntry, tierLabels: string[], x: number, w: number): void {
  const { row, bundle, codes } = entry;
  const innerX = x + CARD_PAD;
  const innerRight = x + w - CARD_PAD;
  const wanted = new Set(codes);
  const matched = new Set(row.onetHits.map((hit) => hit.code));
  const shown = bundle ? orderCodes(bundle, matched).filter((code) => wanted.has(code)) : [];
  const subChips: PdfChip[] = shown.map((code) => ({
    parts: [
      { text: code, color: PDF_FAINT },
      { text: bundle![code].title, color: PDF_MUTED },
    ],
    bg: PDF_ELEVATED,
    border: PDF_BORDER,
    size: SUB_CHIP,
  }));

  const headH = 17;
  const tiersH = 4 * TIER_ROW_H;
  let subsH = 0;
  if (subChips.length) {
    const dry = flowChips(pdf, innerX, 0, innerX, innerRight, subChips, false);
    subsH = 6 + dry.rowTop + dry.rowH;
  }
  const failH = bundle ? 0 : ITEM_LH + 2;
  const cardH = CARD_PAD + headH + tiersH + subsH + failH + CARD_PAD;

  pdf.ensure(cardH + CARD_GAP);
  const top0 = pdf.top;
  pdf.box(x, top0, w, cardH, { fill: PDF_SUNKEN, stroke: PDF_BORDER, radius: 8, lineWidth: 0.8 });

  const titleTop = top0 + CARD_PAD;
  pdf.text(innerX, titleTop, row.title, { size: CARD_TITLE, bold: true, color: PDF_INK });
  const titleW = pdf.measure(row.title, CARD_TITLE, true);
  pdf.text(innerX + titleW + 7, alignTop(titleTop, CARD_TITLE, SOC_SIZE), row.soccode, {
    size: SOC_SIZE,
    bold: true,
    color: PDF_MUTED,
  });
  const wageText = `${formatUSD(row.avg)} avg / yr`;
  pdf.text(innerRight - pdf.measure(wageText, WAGE_SIZE), alignTop(titleTop, CARD_TITLE, WAGE_SIZE), wageText, {
    size: WAGE_SIZE,
    color: PDF_MUTED,
  });

  const tiersTop = titleTop + headH;
  const levels = [row.l1, row.l2, row.l3, row.l4];
  const scaleMax = Math.max(0, ...levels.filter((v): v is number => v !== null));
  const barX = innerX + TIER_LABEL_W + COL_GAP;
  const barW = innerRight - TIER_VALUE_W - COL_GAP - barX;
  for (let i = 0; i < 4; i++) {
    const rowTop = tiersTop + i * TIER_ROW_H;
    const v = levels[i];
    pdf.text(innerX, rowTop + (TIER_ROW_H - TIER_LABEL) / 2, tierLabels[i] || `Level ${i + 1}`, {
      size: TIER_LABEL,
      color: v === null ? PDF_FAINT : PDF_MUTED,
    });
    if (v !== null && scaleMax > 0) {
      pdf.box(barX, rowTop + (TIER_ROW_H - BAR_H) / 2, Math.max(4, (v / scaleMax) * barW), BAR_H, {
        fill: PDF_TIERS[i],
        radius: BAR_H / 2,
      });
    }
    const valText = formatUSD(v);
    pdf.text(innerRight - pdf.measure(valText, TIER_VALUE, true), rowTop + (TIER_ROW_H - TIER_VALUE) / 2, valText, {
      size: TIER_VALUE,
      bold: true,
      color: v === null ? PDF_FAINT : PDF_INK,
    });
  }

  const belowTiers = tiersTop + tiersH;
  if (!bundle) {
    pdf.text(innerX, belowTiers + 2, "O*NET detail failed to load \u2014 retry in the app.", {
      size: ITEM_SIZE,
      color: PDF_WARN,
    });
  } else if (subChips.length) {
    flowChips(pdf, innerX, belowTiers + 6, innerX, innerRight, subChips, true);
  }

  pdf.top = top0 + cardH + CARD_GAP;
}

/** Education: one percent distribution per role (level low-to-high), a per-role
 *  fact that cannot be pooled, so it is compared just like the on-screen view. */
function drawEducation(pdf: Pdf, roles: RoleRef[], x: number, w: number): void {
  const eduRoles = roles.filter((r) => r.profile.education?.length);
  if (eduRoles.length === 0) return;
  pdf.top += SECTION_GAP;
  sectionHeading(pdf, "Education", "% of respondents", x);

  const labelW = 150;
  const barX = x + labelW + COL_GAP;
  for (const role of eduRoles) {
    const dist = eduByLevel(role.profile.education ?? []);
    const maxPct = Math.max(0, ...dist.map((e) => e.percent));
    pdf.ensure(9 + 5 + EDU_ROW_MIN);
    pdf.text(x, pdf.top, role.title, { size: 9, bold: true, color: PDF_MUTED });
    pdf.top += 9 + 5;
    for (const e of dist) {
      const lines = pdf.wrap(e.level, EDU_LABEL, false, labelW);
      const rowH = Math.max(lines.length * EDU_LABEL_LH, EDU_ROW_MIN);
      pdf.ensure(rowH);
      const rowTop = pdf.top;
      lines.forEach((ln, i) => pdf.text(x, rowTop + i * EDU_LABEL_LH, ln, { size: EDU_LABEL, color: PDF_MUTED }));
      const barTop = rowTop + (EDU_LABEL_LH - EDU_BAR_H) / 2;
      const barW = x + w - EDU_PCT - 24 - COL_GAP - barX;
      if (maxPct > 0) {
        pdf.box(barX, barTop, Math.max(3, (e.percent / maxPct) * barW), EDU_BAR_H, {
          fill: PDF_TIERS[2],
          radius: EDU_BAR_H / 2,
        });
      }
      const pct = `${e.percent}%`;
      pdf.text(x + w - pdf.measure(pct, EDU_PCT, true), rowTop + (EDU_LABEL_LH - EDU_PCT) / 2, pct, {
        size: EDU_PCT,
        bold: true,
        color: PDF_INK,
      });
      pdf.top = rowTop + rowH + 2;
    }
    pdf.top += 4;
  }
}

/**
 * Render the aggregate as a downloadable PDF that mirrors the on-screen report.
 * `tierLabels` are the four wage-level names, passed in from the card template so
 * the level labels keep a single source (the same reason renderAggregateReport
 * takes an injected tier renderer). Every section is drawn in full -- no preview
 * cap and no source-chip cap -- so the download is the complete report.
 */
export function aggregateReportToPdfBlob(entries: AggregateEntry[], tierLabels: string[]): Blob {
  const pdf = new Pdf();
  const x = pdf.margin;
  const w = pdf.contentW;

  const roles = collectRoles(entries);
  const jobWord = entries.length === 1 ? "job" : "jobs";
  const roleWord = roles.length === 1 ? "role" : "roles";

  pdf.text(x, pdf.top, "Aggregated job description", { size: TITLE_SIZE, bold: true, color: PDF_INK });
  pdf.top += TITLE_SIZE + 4;
  pdf.text(x, pdf.top, `${roles.length} ${roleWord} across ${entries.length} ${jobWord}`, {
    size: SUBTITLE_SIZE,
    color: PDF_MUTED,
  });
  pdf.top += SUBTITLE_SIZE + 8;
  pdf.box(x, pdf.top, w, 0.8, { fill: PDF_BORDER });
  pdf.top += 12;

  for (const entry of entries) drawJobCard(pdf, entry, tierLabels, x, w);

  if (roles.length === 0) {
    const failed = entries.some((e) => !e.bundle);
    pdf.top += 6;
    pdf.text(
      x,
      pdf.top,
      failed
        ? "O*NET detail failed to load \u2014 retry in the app."
        : "No O*NET detail is available for the selected roles.",
      { size: ITEM_SIZE, color: failed ? PDF_WARN : PDF_MUTED },
    );
    return pdf.blob();
  }

  const pools = buildPools(roles);
  const titleByCode = new Map(roles.map((r) => [r.code, r.title]));
  const showSrc = roles.length > 1;

  if (pools.tasks.length) {
    pdf.top += SECTION_GAP;
    sectionHeading(pdf, "Tasks", String(pools.tasks.length), x);
    for (const t of pools.tasks) {
      const chips: PdfChip[] = [];
      if (t.supplemental) {
        chips.push({ parts: [{ text: "SUPPLEMENTAL", color: PDF_FAINT }], bg: PDF_ELEVATED, border: PDF_BORDER, size: TAG_CHIP });
      }
      chips.push(...srcChips(t.sources, titleByCode, showSrc));
      bulletItem(pdf, x, w, [{ text: t.text, color: PDF_MUTED }], chips);
    }
  }

  if (pools.dwas.length) {
    pdf.top += SECTION_GAP;
    sectionHeading(pdf, "Detailed Work Activities", String(pools.dwas.length), x);
    for (const d of pools.dwas) {
      bulletItem(pdf, x, w, [{ text: d.text, color: PDF_MUTED }], srcChips(d.sources, titleByCode, showSrc));
    }
  }

  if (pools.zones.length) {
    pdf.top += SECTION_GAP;
    sectionHeading(pdf, "Job Zone", pools.zones.length === 1 ? "1 level" : `${pools.zones.length} levels`, x);
    for (const z of pools.zones) {
      bulletItem(
        pdf,
        x,
        w,
        [
          { text: `Zone ${z.zone}`, bold: true, color: PDF_INK },
          { text: "\u2014", color: PDF_MUTED },
          { text: z.name, color: PDF_MUTED },
        ],
        srcChips(z.sources, titleByCode, showSrc),
      );
    }
  }

  const elementSection = (title: string, items: { name: string; description: string; sources: string[] }[]): void => {
    if (items.length === 0) return;
    pdf.top += SECTION_GAP;
    sectionHeading(pdf, title, String(items.length), x);
    for (const e of items) {
      const runs: Run[] = [{ text: e.name, bold: true, color: PDF_INK }];
      if (e.description) {
        runs.push({ text: "\u2014", color: PDF_MUTED }, { text: e.description, color: PDF_MUTED });
      }
      bulletItem(pdf, x, w, runs, srcChips(e.sources, titleByCode, showSrc));
    }
  };
  elementSection("Knowledge", pools.knowledge);
  elementSection("Skills", pools.skills);

  if (pools.software.length) {
    pdf.top += SECTION_GAP;
    sectionHeading(pdf, "Technology Skills", String(pools.software.length), x);
    for (const c of pools.software) {
      const chips: PdfChip[] = c.examples.map((ex) => {
        const parts: { text: string; color: Color; bold?: boolean }[] = [{ text: ex.name, color: PDF_MUTED }];
        if (ex.hot) parts.push({ text: "HOT", color: PDF_WARN, bold: true });
        else if (ex.inDemand) parts.push({ text: "IN DEMAND", color: PDF_ACCENT, bold: true });
        return { parts, bg: PDF_ELEVATED, border: PDF_BORDER, size: SRC_CHIP };
      });
      chips.push(...srcChips(c.sources, titleByCode, showSrc));
      bulletItem(pdf, x, w, [{ text: c.category, bold: true, color: PDF_INK }], chips);
    }
  }

  drawEducation(pdf, pools.roles, x, w);

  return pdf.blob();
}
