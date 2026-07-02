// Content script: page analysis, field scanning, filling, highlighting.
// Runs in every frame (all_frames) so embedded ATS iframes are covered.
// It never clicks buttons and never submits anything.

import { detectCountry, detectPortal } from "../lib/detectors";
import {
  FieldSignals, isEeoQuestion, isResumeUpload, matchField, pickOption, valueFits,
} from "../lib/fieldMatcher";
import { ContentCommand, FillContext, normalizeQuestion } from "../lib/messages";
import { FillReport, JobInfo, MissingField } from "../lib/types";

declare global {
  interface Window { __fireapplyLoaded?: boolean }
}

if (!window.__fireapplyLoaded) {
  window.__fireapplyLoaded = true;
  init();
}

function init(): void {
  chrome.runtime.onMessage.addListener((msg: ContentCommand, _sender, sendResponse) => {
    switch (msg.type) {
      case "startAssist":
        void startAssist().then(() => sendResponse({ ok: true }));
        return true;
      case "fillWithContext":
        void fillPage(msg.applicationId, msg.ctx).then(() => sendResponse({ ok: true }));
        return true;
      case "fillSingleField":
        fillSingle(msg.fieldId, msg.answer);
        sendResponse({ ok: true });
        return false;
      case "unhighlightField": {
        const el = fieldRegistry.get(msg.fieldId);
        if (el) { el.style.outline = ""; el.style.outlineOffset = ""; }
        sendResponse({ ok: true });
        return false;
      }
      case "resumeAssist":
        void startAssist().then(() => sendResponse({ ok: true }));
        return true;
    }
  });

  // Top frame announces the page automatically so the side panel has job info
  // before the user clicks Start Assist.
  if (window === window.top) {
    whenReady(() => void analyzeAndReport());
  }
}

function whenReady(fn: () => void): void {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(fn, 500);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(fn, 500));
  }
}

// ---------- page analysis ----------

function extractJobInfo(): JobInfo {
  const url = location.href;
  const portal = detectPortal(url);
  let title = "", company = "", locationText = "";

  // 1. JSON-LD JobPosting (most reliable when present)
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "null");
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item["@type"] === "JobPosting") {
          title ||= item.title ?? "";
          company ||= item.hiringOrganization?.name ?? "";
          const addr = item.jobLocation?.address ?? item.jobLocation?.[0]?.address;
          if (addr) {
            locationText ||= [addr.addressLocality, addr.addressRegion, addr.addressCountry]
              .filter(Boolean).join(", ");
          }
        }
      }
    } catch { /* malformed JSON-LD, skip */ }
  }

  // 2. Portal-specific selectors
  if (portal === "greenhouse") {
    title ||= textOf("h1.app-title") || textOf(".job__title h1") || textOf("h1");
    company ||= textOf(".company-name")?.replace(/^at\s+/i, "") || companyFromUrl(url, /greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?&]+)/);
    locationText ||= textOf(".location") || textOf(".job__location");
  } else if (portal === "lever") {
    title ||= textOf(".posting-headline h2") || textOf("h2");
    company ||= companyFromUrl(url, /jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/);
    locationText ||= textOf(".posting-categories .location") || textOf(".location");
  } else if (portal === "workday") {
    title ||= textOf('[data-automation-id="jobPostingHeader"]') || textOf("h1") || textOf("h2");
    locationText ||= textOf('[data-automation-id="locations"]') || textOf('[data-automation-id="location"]');
    company ||= companyFromUrl(url, /https:\/\/([^.]+)\./);
  } else {
    title ||= textOf("h1") || document.title;
    const metaSite = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]');
    company ||= metaSite?.content ?? "";
  }

  const countryCode = detectCountry(locationText, document.title, url);
  return { title: title.trim(), company: company.trim(), location: locationText.trim(), countryCode, portal, url };
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? "";
}

function companyFromUrl(url: string, re: RegExp): string {
  const m = url.match(re);
  return m ? decodeURIComponent(m[1]).replace(/[-_]/g, " ") : "";
}

async function analyzeAndReport(): Promise<{ applicationId?: string; job: JobInfo }> {
  const job = extractJobInfo();
  const res = await chrome.runtime.sendMessage({ type: "pageAnalyzed", job }).catch(() => undefined);
  return { applicationId: res?.applicationId, job };
}

// ---------- safety detection ----------

function hasLoginForm(): boolean {
  const pw = document.querySelector<HTMLInputElement>('input[type="password"]');
  return !!pw && isVisible(pw);
}

function detectSafetyStops(): string[] {
  const warnings: string[] = [];
  const bodyText = document.body?.innerText?.slice(0, 5000).toLowerCase() ?? "";

  if (hasLoginForm()) {
    warnings.push("Login or signup detected. Log in manually; let Chrome save the password if it offers. FireApply resumes automatically after login.");
  }
  if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, [data-sitekey]')) {
    warnings.push("CAPTCHA detected. Solve it manually before continuing.");
  }
  if (/\b(one[- ]time password|verification code|enter the code|otp)\b/.test(bodyText)) {
    warnings.push("OTP / verification step detected. Complete it manually.");
  }
  return warnings;
}

// ---------- post-login auto-resume ----------
// Two mechanisms cover both navigation styles:
// 1. Full page reload after login -> background sees pendingAssist and
//    re-triggers assist when the navigation completes.
// 2. SPA login (no reload) -> this watcher polls until the password field
//    disappears or the URL changes, then re-runs assist in place.

let loginWatchArmed = false;

function armLoginWatch(): void {
  if (loginWatchArmed) return;
  loginWatchArmed = true;
  void chrome.runtime.sendMessage({ type: "setPendingAssist" }).catch(() => undefined);

  const startUrl = location.href;
  const started = Date.now();
  const timer = setInterval(() => {
    const loginGone = !hasLoginForm();
    const urlChanged = location.href !== startUrl;
    if (loginGone || urlChanged) {
      clearInterval(timer);
      loginWatchArmed = false;
      toast("Login looks complete - scanning this page and filling your details…");
      setTimeout(() => void startAssist(), 1500);
    } else if (Date.now() - started > 10 * 60_000) {
      clearInterval(timer); // stop watching after 10 minutes
      loginWatchArmed = false;
    }
  }, 1500);
}

// ---------- assist flow ----------

async function startAssist(): Promise<void> {
  const { applicationId, job } = await analyzeAndReport();

  const res = await chrome.runtime.sendMessage({
    type: "getFillContext",
    countryCode: job.countryCode,
    portal: job.portal,
    company: job.company,
  }).catch(() => undefined);

  if (!res?.ok) {
    if (res?.error === "LOCKED") {
      toast("FireApply is locked. Open the extension popup and unlock first.");
    } else {
      toast(res?.error ?? "FireApply could not start.");
    }
    return;
  }
  await fillPage(applicationId ?? "", res.ctx as FillContext);
}

const fieldRegistry = new Map<string, HTMLElement>();
let fieldCounter = 0;

async function fillPage(applicationId: string, ctx: FillContext): Promise<void> {
  fieldRegistry.clear();
  const report: FillReport = { filled: [], missing: [], warnings: [], resumeAttached: false };
  report.warnings.push(...detectSafetyStops());

  // login page: fill what is safe, then wait for the user to log in and
  // auto-resume (background re-triggers on navigation, watcher on SPA login)
  if (hasLoginForm()) armLoginWatch();

  const inputs = collectInputs();
  for (const el of inputs) {
    const signals = collectSignals(el);
    const question = bestQuestion(signals);

    if (el instanceof HTMLInputElement && el.type === "file") {
      if (ctx.resume && isResumeUpload(signals)) {
        const ok = attachFile(el, ctx.resume);
        if (ok) {
          report.filled.push({ fieldId: register(el), question: question || "Resume", value: ctx.resume.fileName, confidence: "high" });
          report.resumeAttached = true;
        } else {
          report.warnings.push(`Could not attach resume automatically. Upload "${ctx.resume.fileName}" manually.`);
          highlight(el, "missing");
        }
      }
      continue;
    }

    if (isFilled(el)) continue;

    // 1. saved answers (highest precedence, may answer EEO/visa questions the
    //    user explicitly configured)
    const savedValue = question ? lookupSavedAnswer(ctx, question) : undefined;
    if (savedValue !== undefined) {
      if (setFieldValue(el, savedValue)) {
        report.filled.push({ fieldId: register(el), question, value: savedValue, confidence: "high" });
        highlight(el, "filled");
        continue;
      }
    }

    // 2. EEO/legal questions without a saved answer: leave alone, flag if required
    const combinedText = `${signals.label} ${signals.nearby} ${signals.aria}`;
    if (isEeoQuestion(combinedText)) {
      if (isRequired(el)) {
        report.missing.push(makeMissing(el, question || "Equal opportunity / legal question", signals));
        highlight(el, "missing");
      }
      continue;
    }

    // 3. rule-based match against profile values
    const match = matchField(signals);
    if (match) {
      const value = ctx.profileValues[match.key] ?? "";
      // medium-confidence fills only on short, plain labels - long or
      // question-style labels ("How many years...?") are too easy to misread,
      // so those go to the user instead of risking nonsense data
      const plainLabel =
        signals.label.length > 0 &&
        signals.label.length <= 60 &&
        !signals.label.includes("?");
      const canFill =
        value !== "" &&
        (match.confidence === "high" ||
          (match.confidence === "medium" && !match.sensitive && plainLabel));
      if (canFill && setFieldValue(el, value)) {
        report.filled.push({ fieldId: register(el), question: question || match.key, value, confidence: match.confidence });
        highlight(el, match.confidence === "high" ? "filled" : "review");
        continue;
      }
      if (match.sensitive && value === "" && isRequired(el)) {
        report.missing.push(makeMissing(el, question || match.key, signals));
        highlight(el, "missing");
        continue;
      }
    }

    // 4. unknown field -> missing when required or clearly a question
    if (isRequired(el) || looksLikeQuestion(question)) {
      report.missing.push(makeMissing(el, question || "Unlabeled field", signals));
      highlight(el, "missing");
    }
  }

  await chrome.runtime.sendMessage({ type: "fillReport", applicationId, report }).catch(() => undefined);
  toast(
    report.missing.length > 0
      ? `Filled ${report.filled.length} field(s). ${report.missing.length} need your input - see the side panel.`
      : `Filled ${report.filled.length} field(s). Review the page, then click Next/Submit yourself.`,
  );
}

function register(el: HTMLElement): string {
  for (const [id, existing] of fieldRegistry) if (existing === el) return id;
  const id = `fa-${++fieldCounter}`;
  fieldRegistry.set(id, el);
  return id;
}

function makeMissing(el: HTMLElement, question: string, _signals: FieldSignals): MissingField {
  const fieldId = register(el);
  let kind: MissingField["kind"] = "text";
  let options: string[] | undefined;

  if (el instanceof HTMLTextAreaElement) kind = "textarea";
  else if (el instanceof HTMLSelectElement) {
    kind = "select";
    options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^select|^choose|^--/i.test(t));
  } else if (el instanceof HTMLInputElement) {
    if (el.type === "radio") {
      kind = "radio";
      options = radioGroupOptions(el);
    } else if (el.type === "checkbox") kind = "checkbox";
    else if (el.type === "date") kind = "date";
    else if (el.type === "file") kind = "file";
  }
  return { fieldId, question, kind, options, required: isRequired(el) };
}

function radioGroupOptions(input: HTMLInputElement): string[] {
  if (!input.name || !input.form) return [labelTextFor(input)].filter(Boolean);
  const group = input.form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(input.name)}"]`);
  return [...group].map((r) => labelTextFor(r)).filter(Boolean);
}

// ---------- input collection & signals ----------

type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function collectInputs(): Fillable[] {
  const seen = new Set<Element>();
  const out: Fillable[] = [];
  const selector = "input, textarea, select";

  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll<Fillable>(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el instanceof HTMLInputElement &&
        ["hidden", "submit", "button", "image", "reset"].includes(el.type)) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    // pierce open shadow roots (Workday et al.)
    for (const host of root.querySelectorAll<HTMLElement>("*")) {
      if (host.shadowRoot) walk(host.shadowRoot);
    }
  };
  walk(document);
  return out;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function collectSignals(el: Fillable): FieldSignals {
  return {
    label: labelTextFor(el),
    placeholder: (el as HTMLInputElement).placeholder ?? "",
    name: el.name ?? "",
    id: el.id ?? "",
    aria: el.getAttribute("aria-label") ?? ariaLabelledText(el),
    nearby: nearbyText(el),
    autocomplete: el.getAttribute("autocomplete") ?? "",
  };
}

function labelTextFor(el: HTMLElement): string {
  const input = el as Fillable;
  if (input.labels && input.labels.length > 0) {
    return [...input.labels].map((l) => l.textContent?.trim() ?? "").join(" ").trim();
  }
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl?.textContent) return lbl.textContent.trim();
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent) return wrapping.textContent.trim();
  return "";
}

function ariaLabelledText(el: HTMLElement): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return ids.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ").trim();
}

function nearbyText(el: HTMLElement): string {
  // walk up a couple of levels and grab short leading text (section labels,
  // question paragraphs) without swallowing the entire form
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, textarea, select, button, option").forEach((c) => c.remove());
    const text = clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (text.length > 2 && text.length < 300) return text;
  }
  return "";
}

function bestQuestion(signals: FieldSignals): string {
  return (signals.label || signals.aria || signals.placeholder || signals.nearby || "").trim().slice(0, 200);
}

function looksLikeQuestion(q: string): boolean {
  return q.length > 12 && (q.includes("?") || /\b(do you|are you|have you|will you|how many|please)\b/i.test(q));
}

function isRequired(el: HTMLElement): boolean {
  const f = el as Fillable;
  if (f.required || el.getAttribute("aria-required") === "true") return true;
  const label = labelTextFor(el);
  return /\*\s*$/.test(label) || /\brequired\b/i.test(el.closest("[class]")?.className ?? "");
}

function isFilled(el: Fillable): boolean {
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 && el.value !== "";
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    if (el.type === "radio" && el.name && el.form) {
      return [...el.form.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`)].some((r) => r.checked);
    }
    return el.checked;
  }
  return el.value.trim() !== "";
}

// ---------- saved answers ----------

function lookupSavedAnswer(ctx: FillContext, question: string): string | undefined {
  const norm = normalizeQuestion(question);
  if (!norm) return undefined;
  // ctx.savedAnswers is pre-sorted by scope rank (background)
  for (const a of ctx.savedAnswers) {
    if (a.questionNormalized === norm) return a.answer;
  }
  // relaxed containment match for long questions
  for (const a of ctx.savedAnswers) {
    if (norm.length > 20 && (norm.includes(a.questionNormalized) || a.questionNormalized.includes(norm))) {
      return a.answer;
    }
  }
  return undefined;
}

// ---------- value setting ----------

function setFieldValue(el: Fillable, value: string): boolean {
  if (el instanceof HTMLSelectElement) return setSelect(el, value);
  if (el instanceof HTMLInputElement && el.type === "radio") return setRadio(el, value);
  if (el instanceof HTMLInputElement && el.type === "checkbox") return setCheckbox(el, value);
  if (el instanceof HTMLInputElement && el.type === "file") return false;
  return setText(el as HTMLInputElement | HTMLTextAreaElement, value);
}

function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  // Refuse values that don't fit the input's own constraints - no text in
  // number boxes, no names in email fields, nothing over maxlength.
  const inputType = el instanceof HTMLInputElement ? el.type : "text";
  if (!valueFits(value, inputType, el.maxLength)) return false;

  // Use the native setter so React/Vue controlled inputs pick the change up.
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  // verify the value stuck (a framework may have rejected/rewritten it)
  return el.value === value;
}

function setSelect(el: HTMLSelectElement, value: string): boolean {
  const idx = pickOption([...el.options].map((o) => o.text), value);
  if (idx < 0) return false;
  el.selectedIndex = idx;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.selectedIndex === idx;
}

function setRadio(el: HTMLInputElement, value: string): boolean {
  const group = el.name && el.form
    ? [...el.form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
    : [el];
  const idx = pickOption(group.map((r) => labelTextFor(r)), value);
  if (idx < 0) return false;
  group[idx].click();
  return group[idx].checked;
}

function setCheckbox(el: HTMLInputElement, value: string): boolean {
  const v = value.trim().toLowerCase();
  // only act on unambiguous values; anything else goes back to the user
  const shouldCheck = ["yes", "true", "1", "checked"].includes(v);
  const shouldUncheck = ["no", "false", "0", "unchecked"].includes(v);
  if (!shouldCheck && !shouldUncheck) return false;
  if (el.checked !== shouldCheck) el.click();
  return el.checked === shouldCheck;
}

function attachFile(input: HTMLInputElement, resume: NonNullable<FillContext["resume"]>): boolean {
  try {
    const bin = atob(resume.dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], resume.fileName, { type: resume.mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length === 1;
  } catch {
    return false;
  }
}

function fillSingle(fieldId: string, answer: string): void {
  const el = fieldRegistry.get(fieldId);
  if (!el) return;
  if (setFieldValue(el as Fillable, answer)) {
    highlight(el, "filled");
  } else {
    highlight(el, "missing");
    toast("Could not set that value automatically. Please enter it manually.");
  }
}

// ---------- visuals ----------

function highlight(el: HTMLElement, kind: "filled" | "review" | "missing"): void {
  const colors = { filled: "#22c55e", review: "#f59e0b", missing: "#ef4444" };
  el.style.outline = `2px solid ${colors[kind]}`;
  el.style.outlineOffset = "1px";
  if (kind === "missing") el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

let toastEl: HTMLDivElement | null = null;

function toast(message: string): void {
  if (window !== window.top) return; // only the top frame shows toasts
  if (!toastEl) {
    toastEl = document.createElement("div");
    Object.assign(toastEl.style, {
      position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
      background: "#1f2937", color: "#fff", padding: "12px 16px",
      borderRadius: "8px", font: "13px/1.5 system-ui, sans-serif",
      maxWidth: "360px", boxShadow: "0 4px 12px rgba(0,0,0,.3)",
    });
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = `FireApply: ${message}`;
  toastEl.style.display = "block";
  setTimeout(() => { if (toastEl) toastEl.style.display = "none"; }, 8000);
}
