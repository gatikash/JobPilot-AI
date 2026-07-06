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
        void startAssist().then((result) => sendResponse({ ok: true, ...result }));
        return true;
      case "analyzePage":
        if (window !== window.top) {
          sendResponse({ ok: true, ignored: true });
          return false;
        }
        void announceCurrentJob(true).then((result) => sendResponse({ ok: true, ...result }));
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
        void startAssist().then((result) => sendResponse({ ok: true, ...result }));
        return true;
    }
  });

  // Top frame announces the page automatically so the side panel has job info
  // before the user clicks Start Assist.
  if (window === window.top) {
    whenReady(() => {
      void announceCurrentJob();
      watchLikelyApplied();
      armSpaWatch();
    });
  }
}

// LinkedIn (and other SPAs) swap jobs without a page load - watch the URL and
// re-analyze so the side panel and match score follow the job you're viewing.
let lastAnnouncedJobKey = "";

function armSpaWatch(): void {
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(() => {
      void announceCurrentJob(true);
      detectLikelyApplied();
    }, 1200); // let the new job pane render
  }, 1000);

  if (detectPortal(location.href) === "linkedin") {
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void announceCurrentJob(), 700);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

async function announceCurrentJob(force = false): Promise<{ applicationId?: string; job: JobInfo }> {
  const result = await analyzeAndReport();
  const key = jobKey(result.job);
  if (!force && key && key === lastAnnouncedJobKey) return result;
  if (key) lastAnnouncedJobKey = key;
  if (result.job.title) {
    void chrome.runtime.sendMessage({ type: "requestMatch" }).catch(() => undefined);
  }
  return result;
}

function jobKey(job: JobInfo): string {
  const linkedInId = job.portal === "linkedin" ? linkedInJobId(job.url) : "";
  if (linkedInId) return `linkedin:${linkedInId}`;
  return [
    job.url,
    job.title.toLowerCase().replace(/\s+/g, " ").trim(),
    job.company.toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

function linkedInJobId(url: string): string {
  try {
    const u = new URL(url);
    return u.searchParams.get("currentJobId") ?? u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ?? "";
  } catch {
    return url.match(/[?&]currentJobId=(\d+)/)?.[1] ?? url.match(/\/jobs\/view\/(\d+)/)?.[1] ?? "";
  }
}

let lastLikelyAppliedKey = "";

function watchLikelyApplied(): void {
  detectLikelyApplied();
  const observer = new MutationObserver(() => {
    window.setTimeout(detectLikelyApplied, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function detectLikelyApplied(): void {
  if (window !== window.top) return;
  if (detectPortal(location.href) === "linkedin") return;
  const signal = findLikelyAppliedSignal();
  if (!signal) return;
  const key = `${signal.url}|${signal.reason}`;
  if (key === lastLikelyAppliedKey) return;
  lastLikelyAppliedKey = key;
  void chrome.runtime.sendMessage({ type: "likelyApplied", signal }).catch(() => undefined);
}

function findLikelyAppliedSignal(): { reason: string; url: string; detectedAt: number } | null {
  const url = location.href;
  if (/[/?#](thank[-_]?you|confirmation|confirmed|submitted|success|application[-_]?submitted)([/?#=&]|$)/i.test(url)) {
    return { reason: "The page URL looks like a submission confirmation.", url, detectedAt: Date.now() };
  }

  const text = visiblePageText().slice(0, 12000).toLowerCase();
  const strongPatterns: RegExp[] = [
    /\bthank you for (applying|your application)\b/,
    /\byour application (has been|was) (submitted|received)\b/,
    /\bapplication (submitted|received) successfully\b/,
    /\bwe (have )?received your application\b/,
    /\byou have successfully applied\b/,
    /\bapplication already submitted\b/,
    /\byou (have )?already applied\b/,
  ];
  for (const pattern of strongPatterns) {
    const hit = text.match(pattern);
    if (hit?.[0]) {
      return { reason: `The page says "${hit[0]}".`, url, detectedAt: Date.now() };
    }
  }
  return null;
}

function visiblePageText(): string {
  const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!clone) return "";
  if ("querySelectorAll" in clone) {
    clone.querySelectorAll("script, style, noscript, svg").forEach((el) => el.remove());
  }
  return clone.innerText?.replace(/\s+/g, " ").trim() ?? "";
}

function whenReady(fn: () => void): void {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(fn, 500);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(fn, 500));
  }
}

// ---------- page analysis ----------

const MAX_DESCRIPTION_CHARS = 7000;

function extractJobInfo(): JobInfo {
  const url = location.href;
  const portal = detectPortal(url);
  let title = "", company = "", locationText = "", applicants = "", description = "";

  // 1. JSON-LD JobPosting (most reliable when present)
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || "null");
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item["@type"] === "JobPosting") {
          title ||= item.title ?? "";
          company ||= item.hiringOrganization?.name ?? "";
          if (typeof item.description === "string") {
            description ||= stripHtml(item.description);
          }
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
    description ||= textOf("#content") || textOf(".job__description");
  } else if (portal === "lever") {
    title ||= textOf(".posting-headline h2") || textOf("h2");
    company ||= companyFromUrl(url, /jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/);
    locationText ||= textOf(".posting-categories .location") || textOf(".location");
    description ||= textOf('[data-qa="job-description"]') || textOf(".posting-page");
  } else if (portal === "workday") {
    title ||= textOf('[data-automation-id="jobPostingHeader"]') || textOf("h1") || textOf("h2");
    locationText ||= textOf('[data-automation-id="locations"]') || textOf('[data-automation-id="location"]');
    company ||= companyFromUrl(url, /https:\/\/([^.]+)\./);
    description ||= textOf('[data-automation-id="jobPostingDescription"]');
  } else if (portal === "linkedin") {
    // LinkedIn is read-only territory: we only look at the job the user has
    // open. Class names change often, so try several and fall back broadly.
    const linkedIn = linkedInJobDetails();
    title ||= linkedIn.title;
    company ||= linkedIn.company;
    locationText ||= linkedIn.location;
    applicants ||= linkedIn.applicants;
    description ||= textOf("#job-details")
      || textOf(".jobs-description__container")
      || textOf(".jobs-description-content__text")
      || textOf(".jobs-description__content")
      || textOf(".jobs-box__html-content")
      || textOf(".description__text")
      || textOf('[data-job-description]');
    description ||= linkedIn.description;
  } else {
    title ||= textOf("h1") || document.title;
    const metaSite = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]');
    company ||= metaSite?.content ?? "";
  }

  // last-resort description: main content text (noisy but good enough to match)
  description ||= visiblePageText();

  const countryCode = detectCountry(locationText, document.title, url);
  return {
    title: title.trim(),
    company: company.trim(),
    location: locationText.trim(),
    applicants: applicants.trim() || undefined,
    countryCode,
    portal,
    url,
    description: description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS),
  };
}

function stripHtml(html: string): string {
  // DOMParser produces an inert document: nothing loads, nothing executes
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? "";
}

function textFrom(selectors: string[], root: ParentNode = document): string {
  for (const selector of selectors) {
    const text = root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (text) return text;
  }
  return "";
}

function textAll(selectors: string[], root: ParentNode = document): string[] {
  const out: string[] = [];
  for (const selector of selectors) {
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      if (!isVisible(el)) return;
      const text = el.innerText?.replace(/\s+/g, " ").trim()
        || el.textContent?.replace(/\s+/g, " ").trim()
        || "";
      if (text) out.push(text);
    });
  }
  return [...new Set(out)];
}

function linkedInJobDetails(): { title: string; company: string; location: string; applicants: string; description: string } {
  const topCard = document.querySelector<HTMLElement>(
    ".job-details-jobs-unified-top-card, .jobs-unified-top-card, .top-card-layout, .jobs-search__job-details--container, main",
  );
  const searchRoot = topCard ?? document;
  const title = textFrom([
    ".job-details-jobs-unified-top-card__job-title a",
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title a",
    ".jobs-unified-top-card__job-title",
    ".job-details-jobs-unified-top-card__job-title h1",
    ".jobs-unified-top-card__job-title h1",
    ".job-details-jobs-unified-top-card__title",
    '[data-test-job-title]',
    ".top-card-layout__title",
    "h1",
  ], searchRoot) || linkedInTitleFromDocument();
  const explicitCompany = cleanLinkedInMeta(textFrom([
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name a",
    ".jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__primary-description a[href*='/company/']",
    ".job-details-jobs-unified-top-card__primary-description-container a[href*='/company/']",
    ".jobs-unified-top-card__primary-description-container a[href*='/company/']",
    "a[href*='linkedin.com/company/']",
    "a[href^='/company/']",
    ".topcard__org-name-link",
  ], searchRoot)) || linkedInCompanyFromDocument();
  const primaryText = textFrom([
    ".job-details-jobs-unified-top-card__primary-description-container",
    ".job-details-jobs-unified-top-card__primary-description",
    ".jobs-unified-top-card__primary-description-container",
    ".jobs-unified-top-card__primary-description",
    ".topcard__flavor-row",
  ], searchRoot);
  const tertiaryText = textFrom([
    ".job-details-jobs-unified-top-card__tertiary-description-container",
    ".job-details-jobs-unified-top-card__secondary-description-container",
    ".jobs-unified-top-card__tertiary-description-container",
    ".jobs-unified-top-card__secondary-description-container",
    ".jobs-unified-top-card__subtitle-secondary-grouping",
  ], searchRoot);
  const lines = [
    ...textAll([
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".job-details-jobs-unified-top-card__primary-description",
      ".jobs-unified-top-card__primary-description-container",
      ".jobs-unified-top-card__primary-description",
      ".job-details-jobs-unified-top-card__tertiary-description-container",
      ".job-details-jobs-unified-top-card__secondary-description-container",
      ".jobs-unified-top-card__tertiary-description-container",
      ".jobs-unified-top-card__secondary-description-container",
      ".jobs-unified-top-card__subtitle-secondary-grouping",
      ".jobs-unified-top-card__bullet",
      ".job-details-jobs-unified-top-card__bullet",
      ".topcard__flavor",
      ".topcard__flavor-row",
    ], searchRoot),
    ...(searchRoot instanceof HTMLElement
      ? (searchRoot.innerText
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean) ?? [])
      : []),
    primaryText,
    tertiaryText,
  ].filter(Boolean);
  const parsed = parseLinkedInMeta(lines, title, explicitCompany);
  const descriptionRoot = document.querySelector<HTMLElement>(
    "#job-details, .jobs-description__container, .jobs-description-content__text, main",
  );
  return {
    title,
    company: explicitCompany || parsed.company,
    location: parsed.location,
    applicants: parsed.applicants,
    description: descriptionRoot?.innerText?.replace(/\s+/g, " ").trim() || visiblePageText(),
  };
}

function linkedInTitleFromDocument(): string {
  return document.title
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+-\s+.+$/i, "")
    .replace(/\s+at\s+.+$/i, "")
    .trim();
}

function linkedInCompanyFromDocument(): string {
  const cleaned = document.title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  const atMatch = cleaned.match(/\s+at\s+(.+)$/i);
  if (atMatch?.[1]) return cleanLinkedInMeta(atMatch[1]);
  const dashParts = cleaned.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return dashParts.length > 1 ? cleanLinkedInMeta(dashParts[dashParts.length - 1]) : "";
}

function parseLinkedInMeta(lines: string[], title: string, explicitCompany: string): { company: string; location: string; applicants: string } {
  const applicants = parseApplicants(lines);
  const candidates = lines
    .flatMap((line) => line.split(/\s*(?:\u00b7|\u2022|\|)\s*|\s+-\s+/g))
    .map((line) => cleanLinkedInMeta(line))
    .filter((line) => line && !isLinkedInNoise(line));
  const location = candidates.find((line) => looksLikeLocation(line, explicitCompany, title)) ?? "";
  const company = explicitCompany || (candidates.find((line) =>
    line !== title &&
    line !== location &&
    !looksLikeLocation(line, explicitCompany, title) &&
    !line.toLowerCase().includes("linkedin") &&
    line.length < 90) ?? "");
  return { company, location, applicants };
}

function parseApplicants(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/\b(?:over\s+|less than\s+)?\d[\d,]*\+?\s+applicants?\b/i);
    if (match?.[0]) return match[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

function cleanLinkedInMeta(value: string): string {
  return value
    .replace(/\b(?:over\s+|less than\s+)?\d[\d,]*\+?\s*(applicants?|connections?)\b/gi, "")
    .replace(/\b(reposted|posted|promoted)\b.*$/i, "")
    .replace(/\b(easy apply|actively hiring|be an early applicant)\b/gi, "")
    .replace(/\b(company logo|verified|follow|view profile)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:\u00b7|\u2022|\||-|\s)+|(?:\u00b7|\u2022|\||-|\s)+$/g, "")
    .trim();
}

function isLinkedInNoise(value: string): boolean {
  return /^(full-time|part-time|contract|temporary|internship|intern|associate|mid-senior level|entry level|director|executive)$/i.test(value)
    || /^(?:over\s+|less than\s+)?\d[\d,]*\+?\s*(applicants?|connections?)$/i.test(value)
    || /\b(reposted|posted|promoted|easy apply|be an early applicant|company logo|verified|follow)\b/i.test(value);
}

function looksLikeLocation(value: string, company = "", title = ""): boolean {
  const normalized = value.toLowerCase();
  if (!value || value === company || value === title) return false;
  if (normalized.includes("applicant") || normalized.includes("connection")) return false;
  return /\b(remote|hybrid|on-site|onsite|united states|usa|u\.s\.|india|canada|singapore|united kingdom|germany|australia|netherlands|ireland|uae)\b/i.test(value)
    || /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/.test(value)
    || /^[A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?$/.test(value);
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
    warnings.push("Login or signup detected. Log in manually; let Chrome save the password if it offers. JobPilot AI resumes automatically after login.");
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

async function startAssist(): Promise<{ applicationId?: string; job: JobInfo }> {
  const { applicationId, job } = await analyzeAndReport();

  // LinkedIn is analyze/match only - never fill or touch its forms
  // (account-risk line from the PRD stays intact)
  if (job.portal === "linkedin") {
    void chrome.runtime.sendMessage({ type: "requestMatch" }).catch(() => undefined);
    toast("LinkedIn is match-only: check the side panel for your profile match. JobPilot AI never fills or automates LinkedIn.");
    return { applicationId, job };
  }

  const res = await chrome.runtime.sendMessage({
    type: "getFillContext",
    countryCode: job.countryCode,
    portal: job.portal,
    company: job.company,
  }).catch(() => undefined);

  if (!res?.ok) {
    toast(res?.error ?? "JobPilot AI could not start.");
    return { applicationId, job };
  }
  await fillPage(applicationId ?? "", res.ctx as FillContext);
  return { applicationId, job };
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
    if ("querySelectorAll" in clone) {
      clone.querySelectorAll("input, textarea, select, button, option").forEach((c) => c.remove());
    }
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
  toastEl.textContent = `JobPilot AI: ${message}`;
  toastEl.style.display = "block";
  setTimeout(() => { if (toastEl) toastEl.style.display = "none"; }, 8000);
}
