// Content script: page analysis, field scanning, filling, highlighting.
// Runs in every frame (all_frames) so embedded ATS iframes are covered.
// It never clicks buttons and never submits anything.

import { detectCountry, detectPortal } from "../lib/detectors";
import {
  FieldSignals, isEeoQuestion, isResumeUpload, matchField, pickOption, valueFits,
} from "../lib/fieldMatcher";
import { ContentCommand, FillContext, normalizeQuestion } from "../lib/messages";
import { FillReport, JobInfo, MissingField, WorkExperienceEntry } from "../lib/types";

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
      case "getPageText":
        if (window !== window.top) {
          sendResponse({ ok: true, ignored: true, text: "" });
          return false;
        }
        sendResponse({ ok: true, text: visiblePageText(), pageTitle: document.title });
        return false;
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
    const prevId = linkedInJobId(lastUrl);
    const nextId = linkedInJobId(location.href);
    lastUrl = location.href;
    // jobChanged = the URL clearly points at a different job (LinkedIn ids);
    // background blanks the old data and shows the loading state right away
    const jobChanged = (!!prevId || !!nextId) && prevId !== nextId;
    void chrome.runtime.sendMessage({ type: "pageChanging", jobChanged }).catch(() => undefined);
    void announceWhenReady();
  }, 700);

  if (detectPortal(location.href) === "linkedin") {
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void announceCurrentJob(), 700);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let announceToken = 0;

/** Wait until the page shows a consistent scrape of the job the URL points at,
 * then announce it. Never announces half-rendered or mismatched job details. */
async function announceWhenReady(): Promise<void> {
  const token = ++announceToken;
  const deadline = Date.now() + 9000;
  let lastKey = "";
  while (Date.now() < deadline) {
    await sleep(700);
    if (token !== announceToken) return; // superseded by a newer navigation
    const job = extractJobInfo();
    if (!jobScrapeReady(job)) { lastKey = ""; continue; }
    const key = jobKey(job);
    if (key && key === lastKey) { // stable across two consecutive polls
      await announceCurrentJob(true);
      detectLikelyApplied();
      return;
    }
    lastKey = key;
  }
  // Timed out: never report possibly-wrong details. Send an empty signal so
  // the side panel stops its loading state and stays blank instead of stale.
  const job = extractJobInfo();
  if (jobScrapeReady(job)) {
    await announceCurrentJob(true);
  } else {
    void chrome.runtime.sendMessage({
      type: "pageAnalyzed",
      job: { ...job, title: "", description: "" },
    }).catch(() => undefined);
  }
  detectLikelyApplied();
}

/** True when the scraped details are trustworthy for the current URL. */
function jobScrapeReady(job: JobInfo): boolean {
  if (!job.title.trim()) return false;
  if (job.portal !== "linkedin") return true;
  const urlId = linkedInJobId(location.href);
  const paneId = linkedInDetailPaneJobId();
  // the detail pane still shows the previously selected job
  if (urlId && paneId && urlId !== paneId) return false;
  return true;
}

function linkedInDetailPaneJobId(): string {
  const pane = document.querySelector<HTMLElement>(
    ".job-details-jobs-unified-top-card, .jobs-unified-top-card, .jobs-search__job-details--container, .top-card-layout",
  );
  const link = pane?.querySelector<HTMLAnchorElement>("a[href*='/jobs/view/']");
  return link?.href.match(/\/jobs\/view\/(\d+)/)?.[1] ?? "";
}

async function announceCurrentJob(force = false): Promise<{ applicationId?: string; job: JobInfo }> {
  if (detectPortal(location.href) === "linkedin") {
    const probe = extractJobInfo();
    if (!jobScrapeReady(probe)) {
      // never report a stale pane; blank title so callers keep retrying
      return { job: { ...probe, title: "", description: "" } };
    }
  }
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
  // include the title so a corrected scrape of the same job id re-announces
  if (linkedInId) return `linkedin:${linkedInId}|${job.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
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
    ".job-details-jobs-unified-top-card, .jobs-unified-top-card, .top-card-layout, .jobs-search__job-details--container",
  );
  // On search/collections pages the whole page is a job list; only the detail
  // pane may be scraped. Broad fallbacks are allowed on /jobs/view/ pages only.
  const onJobView = /\/jobs\/view\//.test(location.pathname);
  const searchRoot: ParentNode | null = topCard ?? (onJobView ? document.querySelector("main") ?? document : null);
  if (!searchRoot) {
    return { title: "", company: "", location: "", applicants: "", description: "" };
  }
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
  ], searchRoot) || (onJobView ? linkedInTitleFromDocument() : "");
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
  ], searchRoot)) || (onJobView ? linkedInCompanyFromDocument() : "");
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
    "#job-details, .jobs-description__container, .jobs-description-content__text" + (onJobView ? ", main" : ""),
  );
  return {
    title,
    company: explicitCompany || parsed.company,
    location: parsed.location,
    applicants: parsed.applicants,
    description: descriptionRoot?.innerText?.replace(/\s+/g, " ").trim()
      || (onJobView ? visiblePageText() : ""),
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
  const ctx = res.ctx as FillContext;
  cachedFillCtx = { applicationId: applicationId ?? "", ctx };
  await fillPage(applicationId ?? "", ctx);

  // Many portals (LinkedIn Easy Apply, Lever quick-apply, Workday intake,
  // Greenhouse "Apply for this job") open the actual form inside a modal
  // that mounts *after* startAssist finishes, or swap the modal's contents
  // when the user hits Next. Watch for those and re-run the fill on the
  // freshly-mounted subtree so multi-step modals get the same treatment as
  // a plain page.
  armModalWatch();

  if (job.portal === "linkedin") {
    toast("Easy Apply detected - review each step before clicking Next; JobPilot AI never clicks Submit for you.");
  }
  return { applicationId, job };
}

/** Cached fill context so modal re-scans do not have to round-trip through
 * the background service worker for every mutation burst. Refreshed on each
 * startAssist. */
let cachedFillCtx: { applicationId: string; ctx: FillContext } | undefined;

let modalWatchArmed = false;

/** Watch for application modals mounting after startAssist and re-run the
 * fill inside them. Debounced so a mutation storm from an SPA route only
 * triggers one fill pass. */
function armModalWatch(): void {
  if (modalWatchArmed) return;
  modalWatchArmed = true;

  let timer: number | undefined;
  let lastFillAt = 0;
  const observer = new MutationObserver((records) => {
    if (!cachedFillCtx) return;
    if (!recordsLookLikeModalOrForm(records)) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!cachedFillCtx) return;
      // rate-limit: never re-fill more than once every ~1.2s regardless of
      // how noisy the page's mutations are
      const now = Date.now();
      if (now - lastFillAt < 1200) return;
      // Autofill on modal mutations is opt-in via the side panel: if the
      // user closed the panel we treat it as "stop touching my forms" and
      // wait for an explicit Scan & fill / Start Assist click instead.
      void (async () => {
        const open = await isSidePanelOpen();
        if (!open) return;
        if (!cachedFillCtx) return;
        lastFillAt = Date.now();
        const { applicationId, ctx } = cachedFillCtx;
        void fillPage(applicationId, ctx).catch(() => undefined);
      })();
    }, 600);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/** Ask the background service worker whether at least one side panel is
 * currently open. Returns false on any error so the safe default is "do
 * not autofill". */
async function isSidePanelOpen(): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: "isSidePanelOpen" });
    return !!res?.open;
  } catch {
    return false;
  }
}

/** Cheap pre-filter over MutationObserver records so we only pay for a full
 * fillPage when something that could reasonably be an application form
 * showed up (dialog element, aria-modal container, or a subtree containing
 * form controls). */
function recordsLookLikeModalOrForm(records: MutationRecord[]): boolean {
  const modalSelector = [
    "dialog",
    "[role='dialog']",
    "[aria-modal='true']",
    ".artdeco-modal",                    // LinkedIn Easy Apply shell
    ".jobs-easy-apply-modal",            // LinkedIn Easy Apply modal
    ".jobs-easy-apply-content",          // LinkedIn Easy Apply step body
    ".modal",
    ".modal-dialog",
    ".ReactModal__Content",
  ].join(",");

  for (const rec of records) {
    for (const node of Array.from(rec.addedNodes)) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches?.(modalSelector) || node.querySelector?.(modalSelector)) return true;
      // Fallback: a subtree with several fillable controls almost certainly
      // is the next Easy Apply step or a mid-flight form injection.
      const controls = node.querySelectorAll?.("input, textarea, select");
      if (controls && controls.length >= 3) return true;
    }
  }
  return false;
}

const fieldRegistry = new Map<string, HTMLElement>();
let fieldCounter = 0;

// ---------- multi-organization work experience (Workday-style repeating blocks) ----------

async function fillWorkExperienceBlocks(
  ctx: FillContext, report: FillReport, filledSet: Set<HTMLElement>,
): Promise<void> {
  const entries = ctx.workExperience ?? [];
  if (entries.length === 0) return;
  if (!hasWorkExperienceSection()) return;

  await ensureWorkExperienceBlocks(entries.length);
  const blocks = findWorkExperienceBlocks();
  if (blocks.length === 0) return;

  const n = Math.min(blocks.length, entries.length);
  for (let i = 0; i < n; i++) {
    fillWorkExperienceBlock(blocks[i], entries[i], report, filledSet);
  }
}

function hasWorkExperienceSection(): boolean {
  const patterns = /\b(work experience|employment history|work history|professional experience)\b/i;
  for (const el of document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,legend,[role='heading'],label")) {
    const t = (el.textContent ?? "").trim();
    if (t && t.length < 80 && patterns.test(t)) return true;
  }
  return false;
}

/** Detect repeating work-experience blocks. Workday numbers them "Work Experience 1..N";
 * generic fallback: sibling fieldsets/sections whose heading matches. */
function findWorkExperienceBlocks(): HTMLElement[] {
  const heads: HTMLElement[] = [];
  const numbered = /^\s*(work experience|employment)\s+\d+\s*$/i;
  for (const el of document.querySelectorAll<HTMLElement>(
    "h1,h2,h3,h4,h5,h6,legend,[role='heading']"
  )) {
    const t = (el.textContent ?? "").trim();
    if (t && numbered.test(t)) heads.push(el);
  }

  const blocks: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const h of heads) {
    const block = (h.closest("fieldset, section, [role='group'], [data-automation-id]") as HTMLElement | null)
      ?? h.parentElement;
    if (block && !seen.has(block) && isVisible(block)) {
      seen.add(block);
      blocks.push(block);
    }
  }
  return blocks;
}

async function ensureWorkExperienceBlocks(need: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const have = findWorkExperienceBlocks().length;
    if (have >= need) return;
    const addBtn = findAddWorkExpButton();
    if (!addBtn) return;
    addBtn.click();
    await sleep(500);
  }
}

function findAddWorkExpButton(): HTMLElement | null {
  const re = /^(add another|add work experience|add employment|add more|\+\s*add|add organization|add job)$/i;
  for (const btn of document.querySelectorAll<HTMLElement>("button, [role='button'], a")) {
    const t = (btn.textContent ?? "").trim();
    if (t && re.test(t) && isVisible(btn)) return btn;
  }
  return null;
}

function fillWorkExperienceBlock(
  block: HTMLElement, entry: WorkExperienceEntry,
  report: FillReport, filledSet: Set<HTMLElement>,
): void {
  const trySet = (patterns: RegExp[], value: string, kindHint: "text" | "textarea" = "text"): void => {
    if (!value) return;
    const el = findInputInBlock(block, patterns, kindHint);
    if (!el || filledSet.has(el) || isFilled(el)) return;
    if (setFieldValue(el, value)) {
      filledSet.add(el);
      report.filled.push({
        fieldId: register(el), question: labelTextFor(el) || patterns[0].source,
        value, confidence: "high",
      });
      highlight(el, "filled");
    }
  };

  trySet([/^job title|position title|title$/i], entry.jobTitle);
  trySet([/^company|employer|organi[sz]ation/i], entry.company);
  trySet([/^location|^city/i], entry.location);
  trySet([/role description|responsibilities|description|summary/i], entry.description, "textarea");

  if (entry.currentlyWorking) {
    const cb = findCheckboxInBlock(block, /currently work here|present position|i currently work/i);
    if (cb && !filledSet.has(cb) && !cb.checked) {
      cb.click();
      filledSet.add(cb);
      report.filled.push({
        fieldId: register(cb), question: "Currently work here",
        value: "Yes", confidence: "high",
      });
      highlight(cb, "filled");
    }
  }

  fillWorkExpDate(block, "from", entry.startMonth, entry.startYear, report, filledSet);
  if (!entry.currentlyWorking) {
    fillWorkExpDate(block, "to", entry.endMonth, entry.endYear, report, filledSet);
  }
}

function findInputInBlock(
  block: HTMLElement, patterns: RegExp[], kindHint: "text" | "textarea",
): (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) | null {
  const selector = kindHint === "textarea"
    ? "textarea"
    : "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea, select";
  const candidates = block.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const label = labelTextFor(el);
    const aria = el.getAttribute("aria-label") ?? ariaLabelledText(el);
    const placeholder = (el as HTMLInputElement).placeholder ?? "";
    const auto = el.getAttribute("data-automation-id") ?? "";
    const combined = `${label} ${aria} ${placeholder} ${auto}`;
    if (patterns.some((p) => p.test(combined))) return el;
  }
  return null;
}

function findCheckboxInBlock(block: HTMLElement, pattern: RegExp): HTMLInputElement | null {
  for (const el of block.querySelectorAll<HTMLInputElement>("input[type='checkbox']")) {
    if (!isVisible(el)) continue;
    const label = labelTextFor(el);
    const aria = el.getAttribute("aria-label") ?? ariaLabelledText(el);
    if (pattern.test(`${label} ${aria}`)) return el;
  }
  return null;
}

/** Fill a date range half (from or to). Workday uses month + year spinbutton pairs;
 * this also handles native month inputs and select/text combos by proximity. */
function fillWorkExpDate(
  block: HTMLElement, half: "from" | "to", month: string, year: string,
  report: FillReport, filledSet: Set<HTMLElement>,
): void {
  if (!month && !year) return;

  const headingRe = half === "from"
    ? /^\s*(from|start( date)?)\s*\*?\s*$/i
    : /^\s*(to|end( date)?)\s*\*?\s*$/i;
  const container = findDateContainer(block, headingRe);
  if (!container) return;

  const monthEl = findDateSubInput(container, /month/i);
  const yearEl = findDateSubInput(container, /year/i);

  if (month && monthEl && !filledSet.has(monthEl)) {
    const value = setDateSubInput(monthEl, month);
    if (value) {
      filledSet.add(monthEl);
      report.filled.push({
        fieldId: register(monthEl), question: `${half} month`,
        value, confidence: "high",
      });
      highlight(monthEl, "filled");
    }
  }
  if (year && yearEl && !filledSet.has(yearEl)) {
    if (setFieldValue(yearEl as HTMLInputElement, year)) {
      filledSet.add(yearEl);
      report.filled.push({
        fieldId: register(yearEl), question: `${half} year`,
        value: year, confidence: "high",
      });
      highlight(yearEl, "filled");
    }
  }
}

function findDateContainer(block: HTMLElement, headingRe: RegExp): HTMLElement | null {
  for (const el of block.querySelectorAll<HTMLElement>(
    "label, legend, [role='group'] > label, div, span, h3, h4, h5"
  )) {
    const t = (el.textContent ?? "").trim();
    if (t && t.length < 40 && headingRe.test(t)) {
      // Walk up to a parent that also contains month+year sub-inputs.
      let node: HTMLElement | null = el.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if (node.querySelector("input, select")) return node;
      }
    }
  }
  return null;
}

function findDateSubInput(container: HTMLElement, kindRe: RegExp): HTMLInputElement | HTMLSelectElement | null {
  for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
    if (!isVisible(el)) continue;
    const aria = el.getAttribute("aria-label") ?? ariaLabelledText(el);
    const placeholder = (el as HTMLInputElement).placeholder ?? "";
    const auto = el.getAttribute("data-automation-id") ?? "";
    if (kindRe.test(`${aria} ${placeholder} ${auto}`)) return el;
  }
  return null;
}

/** Workday month spinbuttons accept "01".."12" as raw text; native selects want
 * either "MM" or the month name. Try text first, fall back to the month label. */
function setDateSubInput(el: HTMLInputElement | HTMLSelectElement, month: string): string {
  if (el instanceof HTMLSelectElement) {
    if (setFieldValue(el, month)) return month;
    const names = ["January","February","March","April","May","June",
      "July","August","September","October","November","December"];
    const idx = parseInt(month, 10);
    if (idx >= 1 && idx <= 12 && setFieldValue(el, names[idx - 1])) return names[idx - 1];
    return "";
  }
  return setFieldValue(el, month) ? month : "";
}

async function fillPage(applicationId: string, ctx: FillContext): Promise<void> {
  fieldRegistry.clear();
  const report: FillReport = { filled: [], missing: [], warnings: [], resumeAttached: false };
  report.warnings.push(...detectSafetyStops());

  // login page: fill what is safe, then wait for the user to log in and
  // auto-resume (background re-triggers on navigation, watcher on SPA login)
  if (hasLoginForm()) armLoginWatch();

  const preFilled = new Set<HTMLElement>();
  await fillWorkExperienceBlocks(ctx, report, preFilled);

  const inputs = collectInputs();
  for (const el of inputs) {
    if (preFilled.has(el)) continue;
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
