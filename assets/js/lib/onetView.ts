import type {
  OnetBundle,
  OnetProfile,
  OnetElement,
  OnetJobZone,
  OnetSoftwareCategory,
  OnetEducation,
} from "./types";

// How many items each section shows before a "Show all" toggle appears. Copy
// output is never capped -- the cap is a display affordance, not data loss.
const PREVIEW_CAP = 6;

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

function taskItems(tasks: OnetProfile["tasks"]): HTMLLIElement[] {
  if (!tasks) return [];
  return tasks.map((t) => {
    const li = h("li", "onet-list__item");
    li.append(t.text);
    // "Supplemental" is the only meaningful contrast to core work; other values
    // ("n/a" on data-level .00 codes) mean unclassified, so carry no tag.
    if (t.type === "Supplemental") {
      li.appendChild(h("span", "onet-tag", t.type));
    }
    return li;
  });
}

function textItems(texts: string[] | undefined): HTMLLIElement[] {
  if (!texts) return [];
  return texts.map((t) => h("li", "onet-list__item", t));
}

function elementItems(elements: OnetElement[] | undefined): HTMLLIElement[] {
  if (!elements) return [];
  return elements.map((e) => {
    const li = h("li", "onet-list__item");
    li.appendChild(h("strong", "onet-el__name", e.name));
    if (e.description) {
      li.append(" — ");
      li.appendChild(h("span", "onet-el__desc", e.description));
    }
    return li;
  });
}

function softwareItems(cats: OnetSoftwareCategory[] | undefined): HTMLLIElement[] {
  if (!cats) return [];
  return cats.map((cat) => {
    const li = h("li", "onet-list__item onet-soft");
    li.appendChild(h("span", "onet-soft__cat", cat.category));
    const chips = h("span", "onet-soft__examples");
    for (const ex of cat.examples) {
      const chip = h("span", "onet-chip");
      chip.append(ex.name);
      if (ex.hot) chip.appendChild(h("span", "onet-chip__flag onet-chip__flag--hot", "Hot"));
      else if (ex.inDemand) chip.appendChild(h("span", "onet-chip__flag", "In demand"));
      chips.appendChild(chip);
    }
    li.appendChild(chips);
    return li;
  });
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

function educationBlock(edu: OnetEducation[]): HTMLElement | null {
  if (edu.length === 0) return null;
  const section = h("section", "onet-sec");
  const heading = h("h5", "onet-sec__title");
  heading.append("Education");
  heading.appendChild(h("span", "onet-sec__count", "% of respondents"));
  section.appendChild(heading);

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
  section.appendChild(list);
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

/** Serialize one profile to plain structured text for the clipboard. */
export function profileToText(profile: OnetProfile): string {
  const lines: string[] = [`### ${profile.title} (${profile.code})`];
  if (profile.description) lines.push(profile.description);

  const bulletBlock = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", `${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };

  bulletBlock(
    "Tasks",
    (profile.tasks ?? []).map((t) => (t.type === "Supplemental" ? `${t.text} [Supplemental]` : t.text)),
  );
  bulletBlock("Detailed Work Activities", profile.dwas ?? []);

  if (profile.jobZone) {
    const jz = profile.jobZone;
    lines.push("", `Job Zone: ${jz.name}`);
    if (jz.education) lines.push(`- Education: ${jz.education}`);
    if (jz.experience) lines.push(`- Related experience: ${jz.experience}`);
    if (jz.training) lines.push(`- Job training: ${jz.training}`);
    if (jz.svp) lines.push(`- SVP range: ${jz.svp}`);
  }

  const elementBlock = (title: string, elements: OnetElement[] | undefined) => {
    if (!elements || elements.length === 0) return;
    lines.push("", `${title}:`);
    for (const e of elements) lines.push(e.description ? `- ${e.name} — ${e.description}` : `- ${e.name}`);
  };
  elementBlock("Knowledge", profile.knowledge);
  elementBlock("Skills", profile.essentialSkills);

  if (profile.software && profile.software.length) {
    lines.push("", "Technology Skills:");
    for (const cat of profile.software) {
      const examples = cat.examples
        .map((ex) => (ex.hot ? `${ex.name} (hot)` : ex.inDemand ? `${ex.name} (in demand)` : ex.name))
        .join(", ");
      lines.push(`- ${cat.category}: ${examples}`);
    }
  }

  if (profile.education && profile.education.length) {
    lines.push("", "Education (% of respondents):");
    for (const e of profile.education) lines.push(`- ${e.level}: ${e.percent}%`);
  }

  return lines.join("\n");
}
