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

function educationList(edu: OnetEducation[]): HTMLElement {
  const list = h("ul", "onet-edu");
  const max = Math.max(...edu.map((e) => e.percent));
  for (const e of edu) {
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

/** The selected-jobs strip: each job's title, SOC, wage, and the child roles
 *  ticked for it. Wages are published only at the SOC level, so the wage stays
 *  on the job line and the ticked sub-roles sit under it as JD contributors --
 *  never as separately-priced rows. */
function rolesStrip(entries: AggregateEntry[]): HTMLElement {
  const strip = h("div", "agg-roles");
  for (const { row, bundle, codes } of entries) {
    const item = h("div", "agg-role");
    const head = h("div", "agg-role__head");
    head.appendChild(h("span", "agg-role__title", row.title));
    head.appendChild(h("span", "chip chip--soc", row.soccode));
    head.appendChild(h("span", "agg-role__wage", `${formatUSD(row.avg)} avg / yr`));
    item.appendChild(head);
    if (bundle) {
      const wanted = new Set(codes);
      const matched = new Set(row.onetHits.map((hit) => hit.code));
      const shown = orderCodes(bundle, matched).filter((code) => wanted.has(code));
      if (shown.length) {
        const subs = h("div", "agg-role__subs");
        for (const code of shown) {
          const sub = h("span", "agg-role__sub", bundle[code].title);
          if (matched.has(code)) sub.classList.add("agg-role__sub--matched");
          subs.appendChild(sub);
        }
        item.appendChild(subs);
      }
    }
    strip.appendChild(item);
  }
  return strip;
}

/** Render the aggregate as section blocks pooled across all selected roles. */
export function renderAggregateReport(entries: AggregateEntry[]): HTMLElement {
  const wrap = h("div", "agg-report");
  wrap.appendChild(rolesStrip(entries));

  const roles = collectRoles(entries);
  if (roles.length === 0) {
    wrap.appendChild(h("p", "onet__empty", "No O*NET detail is available for the selected roles."));
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
    const subs = bundle
      ? orderCodes(bundle, new Set(row.onetHits.map((hit) => hit.code)))
          .filter((code) => wanted.has(code))
          .map((code) => bundle[code].title)
          .join("; ")
      : "";
    const suffix = subs ? `: ${subs}` : "";
    lines.push(`- ${row.title} (${row.soccode}, ${formatUSD(row.avg)} avg/yr)${suffix}`);
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
      const dist = (role.profile.education ?? []).map((e) => `${e.level} ${e.percent}%`).join(", ");
      lines.push(`- ${role.title}: ${dist}`);
    }
  }

  return lines.join("\n");
}
