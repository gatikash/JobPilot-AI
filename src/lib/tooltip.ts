// Reusable info-icon tooltip. Pure CSS rendering (styles.css .tip) plus a
// small positioning hook that flips the bubble when close to viewport edges.

import { FIELD_HELP } from "./fieldHelp";

export function makeTip(text: string): HTMLElement {
  const tip = document.createElement("i");
  tip.className = "tip";
  tip.textContent = "i";
  tip.setAttribute("data-tip", text);
  tip.tabIndex = 0;
  tip.setAttribute("role", "img");
  tip.setAttribute("aria-label", text);
  wirePositioning(tip);
  return tip;
}

/** Attach edge-aware positioning to already-rendered .tip elements. */
export function initStaticTips(root: ParentNode = document): void {
  for (const tip of root.querySelectorAll<HTMLElement>(".tip[data-tip]")) {
    wirePositioning(tip);
    if (!tip.hasAttribute("tabindex")) tip.tabIndex = 0;
  }
}

function wirePositioning(tip: HTMLElement): void {
  const reposition = (): void => {
    const rect = tip.getBoundingClientRect();
    tip.classList.toggle("tip-below", rect.top < 130);
    tip.classList.remove("tip-left", "tip-right");
    if (rect.left < 140) tip.classList.add("tip-left");
    else if (window.innerWidth - rect.right < 140) tip.classList.add("tip-right");
  };
  tip.addEventListener("mouseenter", reposition);
  tip.addEventListener("focus", reposition);
}

/**
 * Add help tooltips to every known field in the given root.
 * Looks up help text by data-f / data-c attribute or element id and appends
 * the icon to the field's label (or preceding heading).
 */
export function decorateFieldLabels(root: ParentNode = document): void {
  const targets = root.querySelectorAll<HTMLElement>("[data-f], [data-c], [data-help]");
  for (const el of targets) {
    const key = el.dataset.help || el.dataset.f || el.dataset.c || el.id;
    attach(el, key);
  }
  // id-keyed one-offs (resume manager, settings)
  for (const key of Object.keys(FIELD_HELP)) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(key)}`);
    if (el) attach(el, key);
  }
}

function attach(el: HTMLElement, key: string): void {
  const help = FIELD_HELP[key];
  if (!help) return;
  const label = findLabel(el);
  if (!label || label.querySelector(".tip")) return;
  label.appendChild(makeTip(help));
}

function findLabel(el: HTMLElement): HTMLElement | null {
  // input nested inside its label (checkboxes)
  const wrapping = el.closest("label");
  if (wrapping) return wrapping;
  // label or section heading directly above the field
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === "LABEL" || sib.tagName === "H2") return sib as HTMLElement;
    sib = sib.previousElementSibling;
  }
  // small wrapper div (grid cells): first label inside
  const wrap = el.parentElement;
  if (wrap && wrap.querySelectorAll("input, select, textarea").length === 1) {
    return wrap.querySelector("label");
  }
  return null;
}
