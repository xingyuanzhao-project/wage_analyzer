import { completeCall } from "./llmClient";
import {
  aggregateReportToText,
  rolesStrip,
  type AggregateEntry,
} from "./onetView";
import {
  loadPrompts,
  modelChipFields,
  purposeById,
  type IntakeField,
  type PromptCatalog,
  type PurposeItem,
} from "./prompts";
import { buildEvidencePack, evidenceForPrompt, type EvidencePack } from "./retrieve";
import type { ResultRow } from "./types";

export type CustomizeGate = "no-selection" | "no-compile" | "stale" | "ready";

interface IntakeValue {
  chips: string[];
  text: string;
}

interface OutlineDecision {
  id: string;
  title: string;
  detail: string;
  sources: string[];
}

interface OutlineDoc {
  decisions: OutlineDecision[];
  notes?: string;
}

interface ReportItem {
  text: string;
  sources?: string[];
}

interface ReportFieldValue {
  kind: "prose" | "list";
  text?: string;
  items?: ReportItem[];
  sources?: string[];
}

interface ReportDoc {
  title: string;
  fields: Record<string, ReportFieldValue>;
  model: string;
}

interface Session {
  signature: string;
  phase: "purpose" | "intake" | "outline" | "ready" | "report";
  purposeId: string | null;
  purposeOther: string;
  intake: Record<string, IntakeValue>;
  suggestedChips: Record<string, string[]>;
  outline: OutlineDoc | null;
  revisions: number;
  evidence: EvidencePack | null;
  report: ReportDoc | null;
  error: string;
  busy: boolean;
  busyLabel: string;
  outlineKind: "first" | "regenerate" | "change";
  outlineChange: string;
}

export interface CustomizeHost {
  root: HTMLElement;
  year: string;
  wageLevelLabels: string[];
  renderTiers: (row: ResultRow) => HTMLElement;
  getEntries: () => AggregateEntry[] | null;
  getSignature: () => string;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function placeholderCopy(catalog: PromptCatalog, gate: CustomizeGate): string {
  const labels = catalog.workflow.labels;
  if (gate === "no-selection") return labels.placeholderNoSelection;
  if (gate === "no-compile") return labels.placeholderNoCompile;
  if (gate === "stale") return labels.placeholderStale;
  return labels.placeholderReady;
}

export async function renderCustomizePlaceholder(
  host: HTMLElement,
  gate: CustomizeGate,
  actions: { onCompile: () => void; onCustomize: () => void },
): Promise<void> {
  const catalog = await loadPrompts();
  const labels = catalog.workflow.labels;
  host.textContent = "";
  host.classList.remove("is-active");
  const box = el("div", "aggregate__empty");
  box.append(placeholderCopy(catalog, gate));
  if (gate === "no-compile" || gate === "stale") {
    box.append(" ");
    const btn = el("button", "link-btn", labels.compileShortcut) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", actions.onCompile);
    box.appendChild(btn);
  } else if (gate === "ready") {
    box.append(" ");
    const btn = el("button", "link-btn", labels.customizeShortcut) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", actions.onCustomize);
    box.appendChild(btn);
  }
  host.appendChild(box);
}

function emptyIntake(catalog: PromptCatalog): Record<string, IntakeValue> {
  const out: Record<string, IntakeValue> = {};
  for (const field of catalog.purposes.sharedIntakeFields) {
    out[field.id] = { chips: [], text: "" };
  }
  return out;
}

function newSession(signature: string, catalog: PromptCatalog): Session {
  return {
    signature,
    phase: "purpose",
    purposeId: null,
    purposeOther: "",
    intake: emptyIntake(catalog),
    suggestedChips: {},
    outline: null,
    revisions: 0,
    evidence: null,
    report: null,
    error: "",
    busy: false,
    busyLabel: catalog.workflow.labels.working,
    outlineKind: "first",
    outlineChange: "",
  };
}

let session: Session | null = null;
let hostRef: CustomizeHost | null = null;
let catalogRef: PromptCatalog | null = null;

export function resetCustomize(): void {
  session = null;
}

export function activeCustomizeSignature(): string | null {
  return session?.signature ?? null;
}

function purpose(): PurposeItem {
  if (!catalogRef || !session?.purposeId) throw new Error("Purpose is not selected");
  return purposeById(catalogRef, session.purposeId);
}

function chunkById(id: string): { id: string; text: string; code: string; title: string } | undefined {
  return session?.evidence?.chunks.find((chunk) => chunk.id === id);
}

function sourceChips(ids: string[] | undefined): HTMLElement | null {
  if (!ids?.length) return null;
  const wrap = el("span", "agg-src");
  for (const id of ids) {
    const chunk = chunkById(id);
    const chip = el("span", "agg-src__chip", chunk ? chunk.code : id);
    chip.title = chunk ? `${chunk.code} ${chunk.title} — ${chunk.text}` : id;
    wrap.appendChild(chip);
  }
  return wrap;
}

function setBusy(busy: boolean, label?: string): void {
  if (!session || !catalogRef) return;
  session.busy = busy;
  session.busyLabel = label || catalogRef.workflow.labels.working;
  renderFlow();
}

function showError(err: unknown): void {
  if (!session || !catalogRef) return;
  session.error = err instanceof Error ? err.message : String(err);
  session.busy = false;
  renderFlow();
}

async function goIntake(): Promise<void> {
  if (!session || !catalogRef || !hostRef) return;
  session.error = "";
  session.phase = "intake";
  setBusy(true, catalogRef.workflow.labels.workingChips);
  const entries = hostRef.getEntries();
  if (!entries) {
    showError(catalogRef.workflow.labels.missingAggregate);
    return;
  }
  try {
    const fields = modelChipFields(catalogRef);
    const result = await completeCall<{ chips?: Record<string, string[]> }>("intake-chips", {
      purpose_id: session.purposeId,
      purpose_label: purpose().label,
      purpose_other: session.purposeOther,
      aggregate_text: aggregateReportToText(entries),
      chip_fields: fields.map((field) => ({ id: field.id, label: field.label })),
    });
    if (!result.parsed.chips || typeof result.parsed.chips !== "object") {
      throw new Error(catalogRef.workflow.labels.chipsError);
    }
    session.suggestedChips = result.parsed.chips;
    session.phase = "intake";
    session.busy = false;
    session.error = "";
    renderFlow();
  } catch (err) {
    session.suggestedChips = {};
    session.phase = "intake";
    session.error = err instanceof Error ? err.message : String(err);
    session.busy = false;
    renderFlow();
  }
}

async function goOutline(kind: "first" | "regenerate" | "change", changeMessage = ""): Promise<void> {
  if (!session || !catalogRef || !hostRef) return;
  const entries = hostRef.getEntries();
  if (!entries) {
    showError(catalogRef.workflow.labels.missingAggregate);
    return;
  }
  session.error = "";
  session.outlineKind = kind;
  session.outlineChange = changeMessage;
  if (kind === "first" || !session.outline) session.phase = "outline";
  setBusy(true, catalogRef.workflow.labels.workingOutline);
  try {
    if (!session.evidence || kind === "first" || (kind === "change" && changeMessage.trim())) {
      session.evidence = await buildEvidencePack({
        catalog: catalogRef,
        year: hostRef.year,
        entries,
        purposeId: session.purposeId!,
        purposeOther: session.purposeOther,
        intake: session.intake,
      });
    }
    const vars = {
      purpose_id: session.purposeId,
      purpose_label: purpose().label,
      purpose_other: session.purposeOther,
      intake: session.intake,
      evidence: evidenceForPrompt(session.evidence),
      report_fields: purpose().reportFields,
    };
    const result =
      kind === "first"
        ? await completeCall<OutlineDoc>("outline", vars)
        : await completeCall<OutlineDoc>("outline-revise", {
            ...vars,
            current_outline: session.outline,
            change_message: changeMessage,
            revision_n: session.revisions + 1,
            max_revisions: catalogRef.workflow.outline.maxRevisions,
          });
    if (!Array.isArray(result.parsed.decisions)) {
      throw new Error(catalogRef.workflow.labels.missingOutlineDecisions);
    }
    session.outline = result.parsed;
    if (kind !== "first") session.revisions += 1;
    session.phase = session.revisions >= catalogRef.workflow.outline.maxRevisions ? "ready" : "outline";
    session.busy = false;
    renderFlow();
  } catch (err) {
    showError(err);
  }
}

function acceptOutline(): void {
  if (!session) return;
  session.phase = "ready";
  session.error = "";
  renderFlow();
}

async function goGenerate(): Promise<void> {
  if (!session || !catalogRef || !session.outline || !session.evidence) return;
  session.error = "";
  setBusy(true, catalogRef.workflow.labels.workingGenerate);
  try {
    const result = await completeCall<ReportDoc>("generate", {
      purpose_id: session.purposeId,
      purpose_label: purpose().label,
      purpose_other: session.purposeOther,
      intake: session.intake,
      evidence: evidenceForPrompt(session.evidence),
      outline: session.outline,
      report_fields: purpose().reportFields,
    });
    if (!result.parsed.fields || typeof result.parsed.fields !== "object") {
      throw new Error(catalogRef.workflow.labels.missingReportFields);
    }
    session.report = { ...result.parsed, model: result.model };
    session.phase = "report";
    session.busy = false;
    renderFlow();
  } catch (err) {
    showError(err);
  }
}

function renderPurpose(thread: HTMLElement, composer: HTMLElement): void {
  if (!session || !catalogRef) return;
  const labels = catalogRef.workflow.labels;
  thread.appendChild(el("p", "customize__prompt", labels.purposeHeading));
  const list = el("div", "customize__options");
  for (const item of catalogRef.purposes.items) {
    if (item.allowsFreeText) continue;
    const btn = el("button", "customize__option", item.label) as HTMLButtonElement;
    btn.type = "button";
    btn.classList.toggle("is-selected", session.purposeId === item.id);
    btn.disabled = session.busy;
    btn.addEventListener("click", () => {
      if (!session) return;
      session.purposeId = item.id;
      session.purposeOther = "";
      session.error = "";
      renderFlow();
    });
    list.appendChild(btn);
  }
  thread.appendChild(list);

  const other = catalogRef.purposes.items.find((item) => item.allowsFreeText);
  if (other) {
    const block = el("div", "customize__other");
    const lab = el("label", "customize__field-label", labels.purposeOtherLabel);
    const input = document.createElement("textarea");
    input.className = "customize__textarea";
    input.rows = 2;
    input.placeholder = labels.purposeOtherPlaceholder;
    input.value = session.purposeId === other.id ? session.purposeOther : "";
    input.disabled = session.busy;
    input.addEventListener("input", () => {
      if (!session) return;
      session.purposeId = other.id;
      session.purposeOther = input.value;
    });
    input.addEventListener("focus", () => {
      if (!session) return;
      session.purposeId = other.id;
      renderFlow();
    });
    lab.setAttribute("for", "customize-purpose-other");
    input.id = "customize-purpose-other";
    block.append(lab, input);
    thread.appendChild(block);
  }

  const actions = el("div", "customize__actions");
  const go = actionButton(labels.purposeContinue, true, () => void goIntake());
  go.disabled = session.busy || !session.purposeId;
  actions.appendChild(go);
  composer.appendChild(actions);
}

function fieldChips(field: IntakeField): string[] {
  if (!session || !hostRef || !catalogRef) return [];
  if (field.chipSource === "wage-levels") return hostRef.wageLevelLabels.filter(Boolean);
  return session.suggestedChips[field.id] || [];
}

function renderIntake(thread: HTMLElement, composer: HTMLElement): void {
  if (!session || !catalogRef) return;
  const labels = catalogRef.workflow.labels;
  thread.appendChild(el("p", "customize__prompt", labels.intakeHeading));
  thread.appendChild(el("p", "customize__hint", labels.intakeHint));
  const card = el("div", "customize__card");
  for (const field of catalogRef.purposes.sharedIntakeFields) {
    const row = el("div", "customize__field");
    row.appendChild(el("div", "customize__field-label", field.label));
    if (field.help) row.appendChild(el("p", "customize__hint", field.help));
    const selected = new Set(session.intake[field.id].chips);
    const chips = fieldChips(field);
    if (chips.length && field.kind !== "text") {
      const wrap = el("div", "customize__chips");
      for (const chip of chips) {
        const btn = el("button", "customize__chip", chip) as HTMLButtonElement;
        btn.type = "button";
        btn.classList.toggle("is-selected", selected.has(chip));
        btn.disabled = session.busy;
        btn.addEventListener("click", () => {
          if (!session) return;
          const cur = new Set(session.intake[field.id].chips);
          if (cur.has(chip)) cur.delete(chip);
          else cur.add(chip);
          session.intake[field.id].chips = [...cur];
          renderFlow();
        });
        wrap.appendChild(btn);
      }
      row.appendChild(wrap);
    }
    if (field.kind !== "chips") {
      const area = document.createElement("textarea");
      area.className = "customize__textarea";
      area.rows = 3;
      area.placeholder = field.placeholder || "";
      area.value = session.intake[field.id].text;
      area.disabled = session.busy;
      area.addEventListener("input", () => {
        if (!session) return;
        session.intake[field.id].text = area.value;
      });
      row.appendChild(area);
    }
    card.appendChild(row);
  }
  thread.appendChild(card);
  const actions = el("div", "customize__actions");
  actions.appendChild(actionButton(labels.intakeContinue, true, () => void goOutline("first")));
  composer.appendChild(actions);
}

function renderOutlineList(thread: HTMLElement): void {
  if (!session || !catalogRef || !session.outline) return;
  const labels = catalogRef.workflow.labels;
  const max = catalogRef.workflow.outline.maxRevisions;
  thread.appendChild(el("p", "customize__prompt", labels.outlineHeading));
  thread.appendChild(el("p", "customize__hint", labels.outlineHint));
  thread.appendChild(
    el("p", "customize__meta", `${labels.revisionCaption}: ${session.revisions} / ${max}`),
  );
  const list = el("ol", "customize__decisions");
  for (const decision of session.outline.decisions) {
    const item = el("li", "customize__decision");
    item.appendChild(el("strong", "customize__decision-title", decision.title));
    item.appendChild(el("p", "customize__decision-detail", decision.detail));
    const chips = sourceChips(decision.sources);
    if (chips) item.appendChild(chips);
    list.appendChild(item);
  }
  thread.appendChild(list);
  if (session.outline.notes) thread.appendChild(el("p", "customize__hint", session.outline.notes));
}

function actionButton(label: string, current: boolean, onClick: () => void): HTMLButtonElement {
  const btn = el("button", "view-tabs__compile", label) as HTMLButtonElement;
  btn.type = "button";
  btn.classList.toggle("is-current", current);
  btn.disabled = !!session?.busy;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderOutline(thread: HTMLElement, composer: HTMLElement): void {
  if (!session || !catalogRef) return;
  const labels = catalogRef.workflow.labels;
  const max = catalogRef.workflow.outline.maxRevisions;
  if (!session.outline) {
    if (!session.busy) {
      const actions = el("div", "customize__actions");
      actions.appendChild(
        actionButton(labels.tryAgain, true, () =>
          void goOutline(session!.outlineKind, session!.outlineChange),
        ),
      );
      composer.appendChild(actions);
    }
    return;
  }
  renderOutlineList(thread);
  const actions = el("div", "customize__outline-actions");
  const buttons = el("div", "customize__actions");
  buttons.appendChild(actionButton(labels.outlineAccept, true, acceptOutline));
  if (session.revisions < max) {
    buttons.appendChild(actionButton(labels.outlineRegenerate, false, () => void goOutline("regenerate")));
    const change = document.createElement("textarea");
    change.className = "customize__textarea";
    change.rows = 2;
    change.placeholder = labels.outlineChangePlaceholder;
    change.disabled = session.busy;
    buttons.appendChild(actionButton(labels.outlineSendChange, false, () => void goOutline("change", change.value)));
    actions.append(buttons, change);
  } else {
    actions.appendChild(buttons);
  }
  composer.appendChild(actions);
}

function renderReady(thread: HTMLElement, composer: HTMLElement): void {
  renderOutlineList(thread);
  if (!catalogRef || !session) return;
  const actions = el("div", "customize__actions");
  actions.appendChild(actionButton(catalogRef.workflow.labels.generateButton, true, () => void goGenerate()));
  composer.appendChild(actions);
}

function renderReport(thread: HTMLElement, composer: HTMLElement): void {
  if (!session || !catalogRef || !hostRef || !session.report) return;
  const entries = hostRef.getEntries();
  const report = el("div", "customize__report agg-report");
  if (entries) report.appendChild(rolesStrip(entries, () => {}, hostRef.renderTiers));
  report.appendChild(el("h3", "customize__report-title", session.report.title || purpose().label));
  if (session.report.model) {
    report.appendChild(el("p", "customize__meta", session.report.model));
  }
  for (const spec of purpose().reportFields) {
    const value = session.report.fields[spec.id];
    if (!value) continue;
    const section = el("section", "onet-sec");
    const heading = el("h5", "onet-sec__title", spec.title);
    section.appendChild(heading);
    if (spec.kind === "list") {
      const ul = el("ul", "onet-list");
      for (const item of value.items || []) {
        const li = el("li", "onet-list__item", item.text);
        const chips = sourceChips(item.sources);
        if (chips) li.appendChild(chips);
        ul.appendChild(li);
      }
      section.appendChild(ul);
    } else if (value.text) {
      const p = el("p", "onet__desc", value.text);
      const chips = sourceChips(value.sources);
      if (chips) p.appendChild(chips);
      section.appendChild(p);
    }
    report.appendChild(section);
  }
  thread.appendChild(report);
  renderOutlineList(thread);
}

function renderFlow(): void {
  if (!hostRef || !session || !catalogRef) return;
  const root = hostRef.root;
  root.textContent = "";
  root.classList.add("is-active");
  const wrap = el("div", "customize");
  const thread = el("div", "customize__thread");
  const composer = el("div", "customize__composer");
  if (session.error) thread.appendChild(el("p", "onet__error", session.error));
  if (session.busy) {
    const progress = el("div", "customize__progress");
    progress.setAttribute("role", "status");
    const spin = el("span", "customize__spinner");
    spin.setAttribute("aria-hidden", "true");
    progress.append(
      spin,
      el("p", "customize__progress-label", session.busyLabel),
    );
    const track = el("div", "customize__progress-track");
    track.appendChild(el("i", "customize__progress-fill"));
    progress.appendChild(track);
    thread.appendChild(progress);
  }
  if (session.phase === "purpose") renderPurpose(thread, composer);
  else if (session.phase === "intake") renderIntake(thread, composer);
  else if (session.phase === "outline") renderOutline(thread, composer);
  else if (session.phase === "ready") renderReady(thread, composer);
  else renderReport(thread, composer);
  wrap.append(thread, composer);
  root.appendChild(wrap);
}

export async function beginCustomize(host: CustomizeHost): Promise<void> {
  const catalog = await loadPrompts();
  catalogRef = catalog;
  hostRef = host;
  const signature = host.getSignature();
  if (!session || session.signature !== signature) {
    session = newSession(signature, catalog);
  }
  renderFlow();
}
