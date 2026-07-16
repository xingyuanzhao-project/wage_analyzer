/**
 * Dependency-free dropdown widget with two modes:
 *   - "select":   button trigger + custom listbox popup (replaces <select>)
 *   - "combobox": text input + type-to-filter listbox popup (replaces <input list>)
 *
 * Both render an identical rounded popup and an always-present chevron, so the
 * control looks the same in every browser instead of falling back to the native
 * OS menu. Interaction follows the WAI-ARIA combobox/listbox pattern (Arrow keys,
 * Enter, Escape, Home/End, type-to-filter, click-outside to close).
 */

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownConfig {
  mode: "select" | "combobox";
  options?: DropdownOption[];
  value?: string;
  placeholder?: string;
  inputId?: string;
  labelledBy?: string;
  emptyText?: string;
  onChange?: (value: string) => void;
  onType?: (text: string) => void;
}

const CHEVRON =
  '<svg class="dd__chev-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M5.25 7.75 10 12.25l4.75-4.5" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

let uid = 0;

export class Dropdown {
  private root: HTMLElement;
  private mode: "select" | "combobox";
  private options: DropdownOption[];
  private onChange?: (value: string) => void;
  private onType?: (text: string) => void;
  private emptyText: string;
  private placeholder: string;

  private list!: HTMLUListElement;
  private input: HTMLInputElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private valueSpan: HTMLElement | null = null;

  private selectedValue = "";
  private isOpen = false;
  private activeIndex = -1;
  private view: DropdownOption[] = [];
  private listId: string;
  private onDocDown: (e: Event) => void;

  constructor(root: HTMLElement, cfg: DropdownConfig) {
    this.root = root;
    this.mode = cfg.mode;
    this.options = cfg.options ? cfg.options.slice() : [];
    this.onChange = cfg.onChange;
    this.onType = cfg.onType;
    this.emptyText = cfg.emptyText ?? "No matches";
    this.placeholder = cfg.placeholder ?? "";
    this.listId = `dd-list-${++uid}`;
    this.onDocDown = (e: Event) => {
      if (!this.root.contains(e.target as Node)) this.close();
    };
    this.build(cfg);
    if (cfg.value !== undefined) this.value = cfg.value;
  }

  // --- construction -------------------------------------------------------

  private build(cfg: DropdownConfig): void {
    this.root.classList.add("dd", `dd--${this.mode}`);
    this.root.dataset.open = "false";

    if (this.mode === "combobox") {
      this.buildCombobox(cfg);
    } else {
      this.buildSelect(cfg);
    }

    const list = document.createElement("ul");
    list.className = "dd__list";
    list.id = this.listId;
    list.setAttribute("role", "listbox");
    list.hidden = true;
    this.root.appendChild(list);
    this.list = list;
  }

  private buildCombobox(cfg: DropdownConfig): void {
    const control = document.createElement("div");
    control.className = "dd__control";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dd__input";
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", this.listId);
    if (cfg.inputId) input.id = cfg.inputId;
    if (cfg.labelledBy) input.setAttribute("aria-labelledby", cfg.labelledBy);
    if (this.placeholder) input.placeholder = this.placeholder;
    this.input = input;

    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "dd__chev";
    chev.tabIndex = -1;
    chev.setAttribute("aria-label", "Show options");
    chev.innerHTML = CHEVRON;

    control.append(input, chev);
    this.root.appendChild(control);

    input.addEventListener("input", () => {
      this.onType?.(input.value);
      this.openWith(input.value);
    });
    input.addEventListener("keydown", (e) => this.onKeydown(e));
    chev.addEventListener("mousedown", (e) => e.preventDefault());
    chev.addEventListener("click", () => {
      if (this.isOpen) {
        this.close();
      } else {
        input.focus();
        this.openWith("");
      }
    });
  }

  private buildSelect(cfg: DropdownConfig): void {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd__control dd__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", this.listId);
    if (cfg.inputId) trigger.id = cfg.inputId;
    if (cfg.labelledBy) trigger.setAttribute("aria-labelledby", cfg.labelledBy);

    const valueSpan = document.createElement("span");
    valueSpan.className = "dd__value";
    valueSpan.textContent = this.placeholder;
    if (this.placeholder) trigger.classList.add("is-placeholder");

    const chev = document.createElement("span");
    chev.className = "dd__chev";
    chev.innerHTML = CHEVRON;

    trigger.append(valueSpan, chev);
    this.root.appendChild(trigger);
    this.trigger = trigger;
    this.valueSpan = valueSpan;

    trigger.addEventListener("click", () => {
      if (this.isOpen) this.close();
      else this.openWith(null);
    });
    trigger.addEventListener("keydown", (e) => this.onKeydown(e));
  }

  private control(): HTMLElement {
    return (this.input ?? this.trigger) as HTMLElement;
  }

  // --- public API ---------------------------------------------------------

  get value(): string {
    return this.mode === "combobox" ? this.input!.value : this.selectedValue;
  }

  set value(v: string) {
    if (this.mode === "combobox") {
      this.input!.value = v;
      return;
    }
    const opt = this.options.find((o) => o.value === v);
    this.selectedValue = opt ? opt.value : "";
    if (opt) {
      this.valueSpan!.textContent = opt.label;
      this.trigger!.classList.remove("is-placeholder");
    } else {
      this.valueSpan!.textContent = this.placeholder;
      if (this.placeholder) this.trigger!.classList.add("is-placeholder");
    }
  }

  setOptions(opts: DropdownOption[]): void {
    this.options = opts.slice();
    if (this.mode === "select") this.value = this.selectedValue; // resync label
    if (this.isOpen) this.openWith(this.mode === "combobox" ? this.input!.value : null);
  }

  // --- open / close / render ---------------------------------------------

  private openWith(filter: string | null): void {
    if (filter === null) {
      this.view = this.options.slice();
    } else {
      const q = filter.trim().toLowerCase();
      this.view = q ? this.options.filter((o) => o.label.toLowerCase().includes(q)) : this.options.slice();
    }
    this.renderList();
    this.open();
  }

  private currentSelectionKey(): string {
    return this.mode === "select" ? this.selectedValue : this.input!.value.trim().toLowerCase();
  }

  private isOptionSelected(o: DropdownOption): boolean {
    return this.mode === "select"
      ? o.value === this.selectedValue
      : o.label.toLowerCase() === this.currentSelectionKey();
  }

  private renderList(): void {
    this.list.textContent = "";

    if (this.view.length === 0) {
      const li = document.createElement("li");
      li.className = "dd__empty";
      li.textContent = this.emptyText;
      this.list.appendChild(li);
      this.activeIndex = -1;
      return;
    }

    this.view.forEach((o, i) => {
      const li = document.createElement("li");
      li.className = "dd__option";
      li.id = `${this.listId}-opt-${i}`;
      li.setAttribute("role", "option");
      li.dataset.value = o.value;
      li.textContent = o.label;
      if (this.isOptionSelected(o)) li.setAttribute("aria-selected", "true");
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => this.choose(o));
      li.addEventListener("mouseenter", () => this.setActive(i));
      this.list.appendChild(li);
    });

    const selIdx = this.view.findIndex((o) => this.isOptionSelected(o));
    this.setActive(selIdx >= 0 ? selIdx : 0);
  }

  private open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.list.hidden = false;
    this.root.dataset.open = "true";
    this.control().setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", this.onDocDown, true);
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.list.hidden = true;
    this.root.dataset.open = "false";
    this.control().setAttribute("aria-expanded", "false");
    this.control().removeAttribute("aria-activedescendant");
    this.activeIndex = -1;
    document.removeEventListener("mousedown", this.onDocDown, true);
  }

  private setActive(i: number): void {
    const items = Array.from(this.list.querySelectorAll<HTMLElement>(".dd__option"));
    if (items.length === 0) {
      this.activeIndex = -1;
      return;
    }
    this.activeIndex = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((el, idx) => el.classList.toggle("is-active", idx === this.activeIndex));
    const active = items[this.activeIndex];
    this.control().setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }

  private choose(opt: DropdownOption): void {
    if (this.mode === "combobox") {
      this.input!.value = opt.label;
    } else {
      this.selectedValue = opt.value;
      this.valueSpan!.textContent = opt.label;
      this.trigger!.classList.remove("is-placeholder");
    }
    this.close();
    this.onChange?.(opt.value);
    if (this.mode === "select") this.trigger!.focus();
  }

  // --- keyboard -----------------------------------------------------------

  private onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this.isOpen) this.openWith(this.mode === "combobox" ? this.input!.value : null);
        else this.setActive(this.activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!this.isOpen) this.openWith(this.mode === "combobox" ? this.input!.value : null);
        else this.setActive(this.activeIndex - 1);
        break;
      case "Home":
        if (this.isOpen) {
          e.preventDefault();
          this.setActive(0);
        }
        break;
      case "End":
        if (this.isOpen) {
          e.preventDefault();
          this.setActive(this.view.length - 1);
        }
        break;
      case "Enter":
        if (this.isOpen && this.activeIndex >= 0 && this.view[this.activeIndex]) {
          e.preventDefault();
          this.choose(this.view[this.activeIndex]);
        } else if (this.mode === "select") {
          e.preventDefault();
          this.openWith(null);
        }
        // combobox while closed: leave Enter alone so the form can submit.
        break;
      case "Escape":
        if (this.isOpen) {
          e.preventDefault();
          this.close();
        }
        break;
      case "Tab":
        this.close();
        break;
      case " ":
        if (this.mode === "select") {
          e.preventDefault();
          if (!this.isOpen) this.openWith(null);
          else if (this.activeIndex >= 0 && this.view[this.activeIndex]) this.choose(this.view[this.activeIndex]);
        }
        break;
    }
  }
}
