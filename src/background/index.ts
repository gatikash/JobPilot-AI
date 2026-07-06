// Background service worker: message router, application tracking,
// fill-context assembly, job matching, and post-login auto-resume. Holds no
// state outside chrome.storage.session so it survives MV3 worker restarts.

import { b64 } from "../lib/crypto";
import * as db from "../lib/db";
import {
  aiDraftAnswer, aiMatch, aiTailorResume, localDraftAnswer, localMatch,
  localTailorResume, MatchProfile,
} from "../lib/matcher";
import {
  BgRequest, ContentCommand, FillContext, SidePanelModel, normalizeQuestion,
} from "../lib/messages";
import {
  ApplicationRecord, CountryProfile, DraftAnswerResult, FillReport, JobInfo,
  LikelyAppliedSignal, MatchResult, ResumeMeta, ResumeTailoringResult, COUNTRIES,
} from "../lib/types";

interface TabState {
  job?: JobInfo;
  applicationId?: string;
  /** fill reports per frameId; replaced (not appended) on every re-run */
  reports: Record<string, FillReport>;
  /** normalized questions the user dismissed for this application */
  dismissedQuestions: string[];
  /** re-run assist automatically after the next completed navigation */
  pendingAssist?: boolean;
  duplicateOf?: { company: string; jobTitle: string; createdAt: number };
  resumeName?: string;
  /** an AI match call is in flight for this tab's job */
  matchPending?: boolean;
  /** resume tailoring generation is in flight for this tab's job */
  tailoringPending?: boolean;
  /** last editable AI/local answer draft generated for a missing question */
  lastDraft?: DraftAnswerResult;
  /** strong but user-confirmed-only submission signal from the page */
  likelyApplied?: LikelyAppliedSignal;
}

function emptyTabState(): TabState {
  return { reports: {}, dismissedQuestions: [] };
}

function canDraftAnswer(question: string): boolean {
  return !/\b(authorized to work|sponsorship|visa|work permit|salary|compensation|date of birth|nationality|citizenship|gender|race|ethnicity|disability|veteran|criminal|conviction|religion|sexual orientation)\b/i
    .test(question);
}

/** False only while a legacy password-protected vault awaits one-time migration. */
async function vaultReady(): Promise<boolean> {
  return !(await db.getCryptoMeta());
}

async function getTabState(tabId: number): Promise<TabState> {
  const key = `tab:${tabId}`;
  const obj = await chrome.storage.session.get(key);
  const state = obj[key] as TabState | undefined;
  return state ? { ...emptyTabState(), ...state } : emptyTabState();
}

async function setTabState(tabId: number, state: TabState): Promise<void> {
  await chrome.storage.session.set({ [`tab:${tabId}`]: state });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`tab:${tabId}`);
});

// ---------- merged fill report ----------

function mergedReport(state: TabState): FillReport | undefined {
  const frames = Object.values(state.reports);
  if (frames.length === 0) return undefined;
  const out: FillReport = { filled: [], missing: [], warnings: [], resumeAttached: false };
  for (const r of frames) {
    out.filled.push(...r.filled);
    out.missing.push(...r.missing);
    out.warnings.push(...r.warnings);
    out.resumeAttached = out.resumeAttached || r.resumeAttached;
  }
  out.warnings = [...new Set(out.warnings)];
  const dismissed = new Set(state.dismissedQuestions);
  out.missing = out.missing.filter((m) => !dismissed.has(normalizeQuestion(m.question)));
  return out;
}

// ---------- job matching ----------

async function getCachedMatch(jobUrl: string): Promise<MatchResult | undefined> {
  const key = `match:${jobUrl}`;
  const obj = await chrome.storage.session.get(key);
  return obj[key] as MatchResult | undefined;
}

async function setCachedMatch(result: MatchResult): Promise<void> {
  await chrome.storage.session.set({ [`match:${result.jobUrl}`]: result });
}

async function getCachedTailoring(jobUrl: string): Promise<ResumeTailoringResult | undefined> {
  const key = `tailor:${jobUrl}`;
  const obj = await chrome.storage.session.get(key);
  return obj[key] as ResumeTailoringResult | undefined;
}

async function setCachedTailoring(result: ResumeTailoringResult): Promise<void> {
  await chrome.storage.session.set({ [`tailor:${result.jobUrl}`]: result });
}

async function buildMatchProfiles(): Promise<MatchProfile[]> {
  const resumes = await db.listResumes();
  const profiles: MatchProfile[] = resumes
    .filter((r) => (r.extractedText ?? "").trim().length > 40)
    .map((r) => ({ name: r.name, text: r.extractedText }));
  if (profiles.length === 0) {
    // fall back to the saved profile's skills so matching still works
    const p = await db.getProfile();
    const text = [p.currentTitle, p.primarySkills, p.secondarySkills, p.totalExperience && `${p.totalExperience} years experience`]
      .filter(Boolean).join(". ");
    if (text.trim()) profiles.push({ name: "My profile", text });
  }
  return profiles;
}

async function buildCandidateFacts(countryCode: string): Promise<string> {
  const p = await db.getProfile();
  const cp = countryCode ? await db.getCountryProfile(countryCode) : undefined;
  const resumes = await db.listResumes();
  const resume = selectResume(resumes, countryCode);
  return [
    `Name: ${p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ")}`,
    `Current title: ${p.currentTitle}`,
    `Current employer: ${p.currentEmployer}`,
    `Experience: ${p.totalExperience} total, ${p.relevantExperience} relevant`,
    `Primary skills: ${p.primarySkills}`,
    `Secondary skills: ${p.secondarySkills}`,
    `Education: ${[p.highestDegree, p.degreeName, p.fieldOfStudy, p.university, p.graduationYear].filter(Boolean).join(", ")}`,
    `Links: ${[p.linkedinUrl, p.githubUrl, p.portfolioUrl, p.personalWebsite].filter(Boolean).join(", ")}`,
    cp ? `Country answers: authorized=${cp.authorizedToWork || "blank"}, sponsorship=${cp.needsSponsorship || "blank"}, notice=${cp.noticePeriod || "blank"}, relocation=${cp.willingToRelocate || "blank"}` : "",
    resume?.extractedText ? `Resume text: ${resume.extractedText}` : "",
  ].filter(Boolean).join("\n");
}

async function selectedMatchProfile(countryCode: string): Promise<MatchProfile | undefined> {
  const resumes = await db.listResumes();
  const selected = selectResume(resumes, countryCode);
  if (selected && (selected.extractedText ?? "").trim().length > 40) {
    return { name: selected.name, text: selected.extractedText };
  }
  const profiles = await buildMatchProfiles();
  return profiles[0];
}

async function runMatch(tabId: number, force: boolean): Promise<unknown> {
  if (await db.getCryptoMeta()) {
    return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
  }
  const state = await getTabState(tabId);
  const job = state.job;
  if (!job?.title || !job.description) {
    return { ok: false, error: "No job description detected on this page yet." };
  }

  if (!force) {
    const cached = await getCachedMatch(job.url);
    if (cached) { notifyPanel(); return { ok: true, cached: true }; }
  }

  const profiles = await buildMatchProfiles();
  if (profiles.length === 0) {
    return { ok: false, error: "No resume text or skills found. Add resumes or fill your profile skills first." };
  }

  const jobText = `${job.title}\n${job.company}\n${job.description}`;

  // instant local estimate first so the panel shows something immediately
  const local = localMatch(job.url, jobText, profiles);
  await setCachedMatch(local);
  notifyPanel();

  const cfg = await db.getAiConfig();
  if (cfg.enabled && cfg.apiKey && cfg.model && (force || cfg.autoMatch)) {
    state.matchPending = true;
    await setTabState(tabId, state);
    notifyPanel();
    try {
      const result = await aiMatch(cfg, job.url, jobText, profiles);
      await setCachedMatch(result);
    } catch (e) {
      local.error = `AI match failed: ${e instanceof Error ? e.message : String(e)} (showing keyword estimate)`;
      await setCachedMatch(local);
    } finally {
      const s = await getTabState(tabId);
      s.matchPending = false;
      await setTabState(tabId, s);
      notifyPanel();
    }
  }
  return { ok: true };
}

async function runTailoring(tabId: number, force: boolean): Promise<unknown> {
  if (await db.getCryptoMeta()) {
    return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
  }
  const state = await getTabState(tabId);
  const job = state.job;
  if (!job?.title || !job.description) {
    return { ok: false, error: "No job description detected on this page yet." };
  }

  if (!force) {
    const cached = await getCachedTailoring(job.url);
    if (cached) { notifyPanel(); return { ok: true, cached: true }; }
  }

  const profile = await selectedMatchProfile(job.countryCode);
  if (!profile) {
    return { ok: false, error: "No resume text or profile skills found. Add resume match text first." };
  }
  const jobText = `${job.title}\n${job.company}\n${job.description}`;

  const local = localTailorResume(job.url, jobText, profile);
  await setCachedTailoring(local);
  notifyPanel();

  const cfg = await db.getAiConfig();
  if (cfg.enabled && cfg.apiKey && cfg.model) {
    state.tailoringPending = true;
    await setTabState(tabId, state);
    notifyPanel();
    try {
      const result = await aiTailorResume(cfg, job.url, jobText, profile);
      await setCachedTailoring(result);
    } catch (e) {
      local.error = `AI tailoring failed: ${e instanceof Error ? e.message : String(e)} (showing keyword suggestions)`;
      await setCachedTailoring(local);
    } finally {
      const s = await getTabState(tabId);
      s.tailoringPending = false;
      await setTabState(tabId, s);
      notifyPanel();
    }
  }
  return { ok: true };
}

async function draftAnswer(tabId: number, question: string): Promise<unknown> {
  if (await db.getCryptoMeta()) {
    return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
  }
  if (!canDraftAnswer(question)) {
    return { ok: false, error: "JobPilot AI does not draft legal, visa, salary, or EEO answers. Enter those yourself." };
  }
  const state = await getTabState(tabId);
  const job = state.job;
  if (!job?.title || !job.description) {
    return { ok: false, error: "No job description detected on this page yet." };
  }

  const jobText = `${job.title}\n${job.company}\n${job.description}`;
  const facts = await buildCandidateFacts(job.countryCode);
  let draft = localDraftAnswer(question, jobText, facts);
  const cfg = await db.getAiConfig();
  if (cfg.enabled && cfg.apiKey && cfg.model) {
    try {
      draft = await aiDraftAnswer(cfg, question, jobText, facts);
      if (!draft.answer) throw new Error("Model returned an empty answer.");
    } catch (e) {
      draft = localDraftAnswer(question, jobText, facts);
      draft.error = `AI draft failed: ${e instanceof Error ? e.message : String(e)} (showing local draft)`;
    }
  }
  state.lastDraft = draft;
  await setTabState(tabId, state);
  notifyPanel();
  return { ok: true, draft };
}

// ---------- post-login auto-resume ----------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  void (async () => {
    const state = await getTabState(tabId);
    if (!state.pendingAssist) return;
    state.pendingAssist = false;
    state.reports = {}; // navigation invalidated old frame reports
    await setTabState(tabId, state);
    // give the page a moment to render its form
    setTimeout(() => void triggerAssist(tabId), 1500);
  })();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PageAnalysisResult = { error?: string; job?: JobInfo; applicationId?: string };

async function injectContentScript(tabId: number): Promise<string | null> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    // Matched portals may already have the content script from manifest
    // injection; the later message send is the source of truth.
    const topFrameError = e instanceof Error ? e.message : String(e);
    try {
      await chrome.tabs.sendMessage(tabId, { type: "analyzePage" } satisfies ContentCommand, { frameId: 0 });
      return null;
    } catch {
      return topFrameError;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch {
    // Some pages contain cross-origin or restricted frames. The top frame still
    // handles job analysis and normal forms, so frame injection is best effort.
  }

  return null;
}

async function sendStartAssist(tabId: number, topFrameOnly = false): Promise<PageAnalysisResult> {
  const cmd: ContentCommand = { type: "startAssist" };
  const send = (): Promise<PageAnalysisResult> => topFrameOnly
    ? chrome.tabs.sendMessage(tabId, cmd, { frameId: 0 }) as Promise<PageAnalysisResult>
    : chrome.tabs.sendMessage(tabId, cmd) as Promise<PageAnalysisResult>;
  try {
    return await send();
  } catch {
    await delay(800);
    try {
      return await send();
    } catch {
      return { error: "Could not reach the page. Reload the tab and click Start Assist again." };
    }
  }
}

async function sendAnalyzePage(tabId: number): Promise<PageAnalysisResult> {
  const cmd: ContentCommand = { type: "analyzePage" };
  try {
    return await chrome.tabs.sendMessage(tabId, cmd, { frameId: 0 }) as { job?: JobInfo; applicationId?: string };
  } catch {
    await delay(800);
    try {
      return await chrome.tabs.sendMessage(tabId, cmd, { frameId: 0 }) as { job?: JobInfo; applicationId?: string };
    } catch {
      return { error: "Could not analyze this page. Reload the tab and try again." };
    }
  }
}

async function analyzeTopFrameWithRetries(tabId: number, attempts = 4, delayMs = 900): Promise<PageAnalysisResult> {
  let last: PageAnalysisResult = {};
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await delay(delayMs);
    last = await sendAnalyzePage(tabId);
    if (last.error) continue;
    if (last.job?.title?.trim()) return last;
  }
  return last;
}

/** Inject (idempotent), start assist on a tab, and verify a fresh scan landed. */
async function triggerAssist(tabId: number, topFrameOnly = false): Promise<string | null> {
  const state = await getTabState(tabId);
  state.reports = {};
  state.likelyApplied = undefined;
  await setTabState(tabId, state);
  notifyPanel();

  const injectionError = await injectContentScript(tabId);
  const start = await sendStartAssist(tabId, topFrameOnly);
  if (start.error) {
    return injectionError
      ? `${start.error} (${injectionError})`
      : start.error;
  }
  if (start.job?.title) {
    await upsertApplication(start.job, tabId);
  }

  await delay(500);
  let refreshed = await getTabState(tabId);
  if (topFrameOnly && !refreshed.job?.title) {
    const analysis = await analyzeTopFrameWithRetries(tabId);
    if (analysis.job?.title) {
      await upsertApplication(analysis.job, tabId);
      refreshed = await getTabState(tabId);
    }
  }
  const report = mergedReport(refreshed);
  if (!refreshed.job?.title && !report) {
    return "The page was reached, but no job details or fillable fields were detected yet. Wait for the page to finish loading, then click Scan & fill again.";
  }
  if (topFrameOnly && refreshed.job?.title) {
    await runMatch(tabId, true);
    await runTailoring(tabId, true);
  }
  notifyPanel();
  return null;
}

async function analyzeActiveJob(): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    return { ok: false, error: "No applicable page in the active tab." };
  }

  const state = await getTabState(tab.id);
  state.likelyApplied = undefined;
  await setTabState(tab.id, state);
  notifyPanel();

  const injectionError = await injectContentScript(tab.id);
  const analysis = await analyzeTopFrameWithRetries(tab.id);
  if (analysis.error) {
    return {
      ok: false,
      error: injectionError ? `${analysis.error} (${injectionError})` : analysis.error,
    };
  }

  const analyzedJob = analysis.job;
  if (analyzedJob?.title) {
    await upsertApplication(analyzedJob, tab.id);
  }

  await delay(300);
  const refreshed = await getTabState(tab.id);
  const job = analyzedJob?.title ? analyzedJob : refreshed.job;
  if (!job?.title) {
    return {
      ok: false,
      error: "The page was reached, but no job details were detected yet. Wait for the page to finish loading, then analyze again.",
    };
  }

  const results = [
    await runMatch(tab.id, true),
    await runTailoring(tab.id, true),
  ];
  const warnings = results
    .filter((r): r is { ok?: boolean; error?: string } => typeof r === "object" && r !== null)
    .filter((r) => r.ok === false && !!r.error)
    .map((r) => r.error);
  notifyPanel();
  return { ok: true, warnings };
}

// ---------- fill context assembly ----------

function yesNo(v: string): string {
  return v === "yes" ? "Yes" : v === "no" ? "No" : "";
}

async function buildFillContext(
  countryCode: string, portal: string, company: string,
): Promise<FillContext> {
  const profile = await db.getProfile();
  const cp: CountryProfile | undefined = countryCode
    ? await db.getCountryProfile(countryCode)
    : undefined;

  const values: Record<string, string> = {
    firstName: profile.firstName,
    middleName: profile.middleName,
    lastName: profile.lastName,
    fullName: profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(" "),
    email: profile.email,
    phone: profile.phone,
    address: profile.address,
    city: profile.city,
    state: profile.state,
    postalCode: profile.postalCode,
    country: profile.country,
    nationality: profile.nationality,
    dateOfBirth: profile.dateOfBirth,
    gender: profile.gender,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    portfolioUrl: profile.portfolioUrl,
    personalWebsite: profile.personalWebsite || profile.portfolioUrl,
    currentTitle: profile.currentTitle,
    currentEmployer: profile.currentEmployer,
    totalExperience: profile.totalExperience,
    relevantExperience: profile.relevantExperience,
    primarySkills: profile.primarySkills,
    highestDegree: profile.highestDegree,
    university: profile.university,
    fieldOfStudy: profile.fieldOfStudy,
    graduationYear: profile.graduationYear,
    gpa: profile.gpa,
    coverLetterText: profile.coverLetterText,
    currentSalary: profile.currentSalary,
    // country-specific (empty when no profile -> matcher will surface as missing)
    noticePeriod: cp?.noticePeriod ?? "",
    expectedSalary: cp ? formatSalary(cp) : "",
    authorizedToWork: yesNo(cp?.authorizedToWork ?? ""),
    needsSponsorship: yesNo(cp?.needsSponsorship ?? ""),
    willingToRelocate: yesNo(cp?.willingToRelocate ?? ""),
    visaType: cp?.visaType ?? "",
  };

  // saved answers, ranked: exact question > company > portal > country > global
  const answers = await db.listSavedAnswers();
  const ranked: FillContext["savedAnswers"] = [];
  for (const a of answers) {
    let rank = -1;
    switch (a.scope) {
      case "exact": rank = 5; break;
      case "company": if (a.company && company.toLowerCase().includes(a.company.toLowerCase())) rank = 4; break;
      case "portal": if (a.portal === portal) rank = 3; break;
      case "country": if (a.countryCode === countryCode) rank = 2; break;
      case "global": rank = 1; break;
    }
    if (rank > 0) {
      ranked.push({ questionNormalized: a.questionNormalized, answer: a.answer, rank });
    }
  }
  ranked.sort((x, y) => y.rank - x.rank);

  const ctx: FillContext = { profileValues: values, countryCode, savedAnswers: ranked };

  // resume selection: country match > default > single resume
  const resumes = await db.listResumes();
  const selected = selectResume(resumes, countryCode);
  if (selected) {
    const data = await db.getResumeData(selected.id);
    if (data) {
      ctx.resume = {
        name: selected.name,
        fileName: selected.fileName,
        mime: selected.fileType || "application/pdf",
        dataB64: b64(data),
      };
    }
  }
  return ctx;
}

function formatSalary(cp: CountryProfile): string {
  if (!cp.expectedSalary) {
    if (cp.salaryAnswerFormat === "negotiable") return "Negotiable";
    return "";
  }
  switch (cp.salaryAnswerFormat) {
    case "negotiable": return "Negotiable";
    case "ask": return "";
    default: return cp.expectedSalary;
  }
}

export function selectResume(resumes: ResumeMeta[], countryCode: string): ResumeMeta | undefined {
  if (countryCode) {
    const byCountry = resumes.find((r) => r.countryCodes.includes(countryCode));
    if (byCountry) return byCountry;
  }
  return resumes.find((r) => r.isDefault) ?? (resumes.length === 1 ? resumes[0] : undefined);
}

// ---------- application tracking ----------

async function upsertApplication(job: JobInfo, tabId: number): Promise<TabState> {
  const state = await getTabState(tabId);

  // SPAs like LinkedIn swap jobs inside one tab. When the logical job changes,
  // the tab must point at a new application record instead of reusing the old one.
  if (state.job && isDifferentJob(state.job, job)) {
    state.reports = {};
    state.dismissedQuestions = [];
    state.duplicateOf = undefined;
    state.applicationId = undefined;
    state.resumeName = undefined;
    state.likelyApplied = undefined;
  }
  state.job = job;

  if (await vaultReady()) {
    const existing = await db.listApplications();
    const dup = existing.find((a) => sameApplicationJob(a, job));

    if (dup && state.applicationId !== dup.id) {
      state.duplicateOf = { company: dup.company, jobTitle: dup.jobTitle, createdAt: dup.createdAt };
      if (!dup.jobUrl && job.url) {
        dup.jobUrl = job.url;
        await db.saveApplication(dup);
      }
    }

    if (!state.applicationId) {
      const rec: ApplicationRecord = dup ?? {
        id: crypto.randomUUID(),
        jobTitle: job.title,
        company: job.company,
        jobCountry: countryName(job.countryCode),
        jobLocation: job.location,
        portal: job.portal,
        jobUrl: job.url,
        status: "Viewed",
        currentStep: "",
        resumeUsed: "",
        missingFields: "",
        duplicateWarning: !!dup,
        errorNotes: "",
        submittedManually: false,
        submissionDate: "",
        followUpDate: "",
        notes: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (!dup) await db.saveApplication(rec);
      state.applicationId = rec.id;
    }

    const resumes = await db.listResumes();
    state.resumeName = selectResume(resumes, job.countryCode)?.name;
  }

  await setTabState(tabId, state);
  return state;
}

function isDifferentJob(prev: JobInfo, next: JobInfo): boolean {
  const prevKey = jobIdentity(prev);
  const nextKey = jobIdentity(next);
  if (prevKey && nextKey) return prevKey !== nextKey;

  const prevTitle = normalizeIdentityPart(prev.title);
  const nextTitle = normalizeIdentityPart(next.title);
  const prevCompany = normalizeIdentityPart(prev.company);
  const nextCompany = normalizeIdentityPart(next.company);
  return !!(
    prev.url !== next.url ||
    (prevTitle && nextTitle && prevTitle !== nextTitle) ||
    (prevCompany && nextCompany && prevCompany !== nextCompany)
  );
}

function sameApplicationJob(app: ApplicationRecord, job: JobInfo): boolean {
  if (app.jobUrl && app.jobUrl === job.url) return true;

  if (job.portal === "linkedin") {
    const appId = linkedInJobId(app.jobUrl);
    const jobId = linkedInJobId(job.url);
    return !!appId && !!jobId && appId === jobId;
  }

  return !!(
    app.company && app.jobTitle &&
    app.company.toLowerCase() === job.company.toLowerCase() &&
    app.jobTitle.toLowerCase() === job.title.toLowerCase()
  );
}

function jobIdentity(job: JobInfo): string {
  if (job.portal === "linkedin") {
    const id = linkedInJobId(job.url);
    if (id) return `linkedin:${id}`;
  }
  if (job.url) return `url:${job.url}`;
  const title = normalizeIdentityPart(job.title);
  const company = normalizeIdentityPart(job.company);
  return title || company ? `${job.portal}:${company}:${title}` : "";
}

function linkedInJobId(url: string): string {
  try {
    const u = new URL(url);
    return u.searchParams.get("currentJobId") ?? u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ?? "";
  } catch {
    return url.match(/[?&]currentJobId=(\d+)/)?.[1] ?? url.match(/\/jobs\/view\/(\d+)/)?.[1] ?? "";
  }
}

function normalizeIdentityPart(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function countryName(code: string): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

type ApplicationRecordStatus = ApplicationRecord["status"];

async function updateStatus(applicationId: string, status: ApplicationRecordStatus, note?: string): Promise<ApplicationRecord | undefined> {
  if (!applicationId || !(await vaultReady())) return undefined;
  const rec = await db.getApplication(applicationId);
  if (!rec) return undefined;
  rec.status = status;
  if (note) rec.errorNotes = note;
  if (status === "Saved" || status === "Viewed") {
    rec.submittedManually = false;
    rec.submissionDate = "";
  } else if (["Applied", "Shortlisted", "Interview Scheduled", "Rejected", "Offer", "Submitted Manually"].includes(status)) {
    rec.submittedManually = true;
    if (!rec.submissionDate) rec.submissionDate = new Date().toISOString().slice(0, 10);
  }
  await db.saveApplication(rec);
  return rec;
}

async function markApplied(applicationId: string | undefined, tabId: number | undefined): Promise<unknown> {
  if (!(await vaultReady())) {
    return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
  }

  let resolvedId = applicationId;
  const targetTab = tabId ?? (resolvedId ? await findTabForApplication(resolvedId) : undefined) ?? await activeTabId();

  if (targetTab !== undefined) {
    await chrome.tabs.sendMessage(targetTab, { type: "analyzePage" } satisfies ContentCommand, { frameId: 0 }).catch(() => undefined);
    const refreshed = await getTabState(targetTab);
    if (refreshed.applicationId) resolvedId = refreshed.applicationId;
  }

  if (!resolvedId && targetTab !== undefined) {
    const state = await getTabState(targetTab);
    if (state.applicationId) {
      resolvedId = state.applicationId;
    } else if (state.job) {
      const next = await upsertApplication(state.job, targetTab);
      resolvedId = next.applicationId;
    }
  }

  if (!resolvedId) {
    return { ok: false, error: "No tracked job found. Click Scan & fill or Save for later first." };
  }

  const rec = await updateStatus(resolvedId, "Applied");
  if (!rec) {
    return { ok: false, error: "Could not update this application in history." };
  }

  if (targetTab !== undefined) {
    const state = await getTabState(targetTab);
    state.applicationId = rec.id;
    await setTabState(targetTab, state);
  }

  notifyPanel();
  return { ok: true, application: rec };
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  void handle(msg, sender).then(sendResponse).catch((e: unknown) => {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  });
  return true; // async response
});

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;

  switch (msg.type) {
    case "getUnlockState":
      return { ok: true, unlocked: await vaultReady() };

    case "activity":
      return { ok: true }; // auto-lock removed; kept for message compatibility

    case "pageAnalyzed": {
      if (tabId === undefined) return { ok: false, error: "no tab" };
      if (isEmptyJobSignal(msg.job)) {
        const prev = await getTabState(tabId);
        return { ok: true, applicationId: prev.applicationId, ignored: true };
      }
      const prev = await getTabState(tabId);
      // Prefer richer analysis (frames without job info should not clobber)
      if (prev.job?.title && !msg.job.title && prev.job.url === msg.job.url) {
        return { ok: true, applicationId: prev.applicationId, ignored: true };
      }
      const state = await upsertApplication(msg.job, tabId);
      notifyPanel();
      return { ok: true, applicationId: state.applicationId, duplicateOf: state.duplicateOf };
    }

    case "getFillContext": {
      if (await db.getCryptoMeta()) {
        return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
      }
      const ctx = await buildFillContext(msg.countryCode, msg.portal, msg.company);
      return { ok: true, ctx };
    }

    case "requestMatch": {
      const target = tabId ?? (await activeTabId());
      if (target === undefined) return { ok: false, error: "No active tab." };
      // auto requests (from content) respect the autoMatch setting; the side
      // panel button always forces a fresh run
      return runMatch(target, msg.force ?? false);
    }

    case "requestTailoring": {
      const target = tabId ?? (await activeTabId());
      if (target === undefined) return { ok: false, error: "No active tab." };
      return runTailoring(target, msg.force ?? false);
    }

    case "draftAnswer": {
      const target = tabId ?? (await findTabForApplication(msg.applicationId)) ?? (await activeTabId());
      if (target === undefined) return { ok: false, error: "No active tab." };
      return draftAnswer(target, msg.question);
    }

    case "setPendingAssist": {
      if (tabId !== undefined) {
        const state = await getTabState(tabId);
        state.pendingAssist = true;
        await setTabState(tabId, state);
      }
      return { ok: true };
    }

    case "fillReport": {
      let merged: FillReport | undefined;
      if (tabId !== undefined) {
        const state = await getTabState(tabId);
        state.reports[String(frameId)] = msg.report; // replace, never append
        merged = mergedReport(state);
        await setTabState(tabId, state);
      }
      const report = merged ?? msg.report;
      if (msg.applicationId && (await vaultReady())) {
        const rec = await db.getApplication(msg.applicationId);
        if (rec) {
          rec.missingFields = report.missing.map((m) => m.question).join("; ");
          await db.saveApplication(rec);
        }
      }
      notifyPanel();
      return { ok: true };
    }

    case "likelyApplied": {
      if (tabId !== undefined) {
        const state = await getTabState(tabId);
        state.likelyApplied = msg.signal;
        await setTabState(tabId, state);
        notifyPanel();
      }
      return { ok: true };
    }

    case "userAnswer": {
      if (!(await vaultReady())) return { ok: false, error: "One-time update needed: open the JobPilot AI popup to convert your data first." };
      if (msg.scope !== "once") {
        await db.saveAnswer({
          id: crypto.randomUUID(),
          questionRaw: msg.question,
          questionNormalized: normalizeQuestion(msg.question),
          answer: msg.answer,
          scope: msg.scope,
          countryCode: msg.scope === "country" ? msg.countryCode : undefined,
          portal: msg.scope === "portal" ? msg.portal : undefined,
          company: msg.scope === "company" ? msg.company : undefined,
          updatedAt: Date.now(),
        });
      }
      const targetTab = await findTabForApplication(msg.applicationId) ?? (await activeTabId());
      if (targetTab !== undefined) {
        const cmd: ContentCommand = { type: "fillSingleField", fieldId: msg.fieldId, answer: msg.answer };
        await chrome.tabs.sendMessage(targetTab, cmd).catch(() => undefined);
        const state = await getTabState(targetTab);
        for (const r of Object.values(state.reports)) {
          r.missing = r.missing.filter((m) => m.fieldId !== msg.fieldId);
        }
        await setTabState(targetTab, state);
      }
      notifyPanel();
      return { ok: true };
    }

    case "dismissField": {
      const targetTab = await findTabForApplication(msg.applicationId) ?? (await activeTabId());
      if (targetTab !== undefined) {
        const state = await getTabState(targetTab);
        const norm = normalizeQuestion(msg.question);
        if (!state.dismissedQuestions.includes(norm)) state.dismissedQuestions.push(norm);
        for (const r of Object.values(state.reports)) {
          r.missing = r.missing.filter((m) => m.fieldId !== msg.fieldId);
        }
        await setTabState(targetTab, state);
        const cmd: ContentCommand = { type: "unhighlightField", fieldId: msg.fieldId };
        await chrome.tabs.sendMessage(targetTab, cmd).catch(() => undefined);
      }
      notifyPanel();
      return { ok: true };
    }

    case "statusUpdate":
      if (!(await updateStatus(msg.applicationId, msg.status, msg.note))) {
        return { ok: false, error: "Could not update this application in history." };
      }
      notifyPanel();
      return { ok: true };

    case "markSubmitted":
      return markApplied(msg.applicationId, tabId);

    case "saveJobForLater": {
      const target = tabId ?? (await activeTabId());
      if (target === undefined) return { ok: false, error: "No active tab." };
      const state = await getTabState(target);
      if (!state.job) return { ok: false, error: "No job detected on this tab yet." };
      const next = await upsertApplication(state.job, target);
      if (!next.applicationId) return { ok: false, error: "Could not save this job." };
      const rec = await db.getApplication(next.applicationId);
      if (rec?.status === "Viewed" || rec?.status === "Saved") {
        await updateStatus(next.applicationId, "Saved");
      }
      notifyPanel();
      return { ok: true };
    }

    case "startAssistOnActiveTab": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
        return { ok: false, error: "No applicable page in the active tab." };
      }
      const error = await triggerAssist(tab.id, isLinkedInUrl(tab.url));
      return error ? { ok: false, error } : { ok: true };
    }

    case "analyzeActiveJob":
      return analyzeActiveJob();

    case "getSidePanelModel": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const model: SidePanelModel = { unlocked: await vaultReady(), missing: [] };
      if (tab?.id !== undefined) {
        const state = await getTabState(tab.id);
        model.job = state.job;
        model.report = mergedReport(state);
        model.missing = model.report?.missing ?? [];
        model.resumeName = state.resumeName;
        model.duplicateOf = state.duplicateOf;
        model.matchPending = state.matchPending;
        model.tailoringPending = state.tailoringPending;
        model.lastDraft = state.lastDraft;
        model.likelyApplied = state.likelyApplied;
        if (state.job?.url) {
          model.match = await getCachedMatch(state.job.url);
          model.tailoring = await getCachedTailoring(state.job.url);
        }
        if (model.unlocked) {
          if (state.applicationId) {
            model.application = await db.getApplication(state.applicationId);
          }
          try {
            const cfg = await db.getAiConfig();
            model.aiConfigured = cfg.enabled && !!cfg.apiKey && !!cfg.model;
          } catch { model.aiConfigured = false; }
        }
      }
      return { ok: true, model };
    }
  }
}

function isEmptyJobSignal(job: JobInfo): boolean {
  return !(job.title ?? "").trim() && !(job.description ?? "").trim();
}

function isLinkedInUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("linkedin.com");
  } catch {
    return /(^|\/\/)([^/]+\.)?linkedin\.com\//i.test(url);
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function findTabForApplication(applicationId: string): Promise<number | undefined> {
  if (!applicationId) return undefined;
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("tab:") && (value as TabState).applicationId === applicationId) {
      return Number(key.slice(4));
    }
  }
  return undefined;
}

function notifyPanel(): void {
  chrome.runtime.sendMessage({ type: "panelRefresh" }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});
