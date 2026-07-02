// Background service worker: message router, application tracking,
// fill-context assembly, auto-lock, and post-login auto-resume. Holds no
// state outside chrome.storage.session so it survives MV3 worker restarts.

import { isUnlocked, lockVault, b64 } from "../lib/crypto";
import * as db from "../lib/db";
import {
  BgRequest, ContentCommand, FillContext, SidePanelModel, normalizeQuestion,
} from "../lib/messages";
import {
  ApplicationRecord, CountryProfile, FillReport, JobInfo, ResumeMeta, COUNTRIES,
} from "../lib/types";

const AUTOLOCK_ALARM = "fireapply-autolock";

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
}

function emptyTabState(): TabState {
  return { reports: {}, dismissedQuestions: [] };
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

// ---------- auto-lock ----------

async function resetAutoLock(): Promise<void> {
  const settings = await db.getSettings();
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  if (settings.autoLockMinutes > 0) {
    chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: settings.autoLockMinutes });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void lockVault();
});

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

/** Inject (idempotent) and start assist on a tab, with one retry. */
async function triggerAssist(tabId: number): Promise<string | null> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch {
    // fails on hosts without permission - matched portals already have the script
  }
  const cmd: ContentCommand = { type: "startAssist" };
  try {
    await chrome.tabs.sendMessage(tabId, cmd);
    return null;
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    try {
      await chrome.tabs.sendMessage(tabId, cmd);
      return null;
    } catch {
      return "Could not reach the page. Reload the tab and click Start Assist again.";
    }
  }
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

  // full navigation to a different URL invalidates old frame reports
  if (state.job && state.job.url !== job.url) {
    state.reports = {};
  }
  state.job = job;

  if (await isUnlocked()) {
    const existing = await db.listApplications();
    const dup = existing.find(
      (a) =>
        a.jobUrl === job.url ||
        (a.company && a.jobTitle &&
          a.company.toLowerCase() === job.company.toLowerCase() &&
          a.jobTitle.toLowerCase() === job.title.toLowerCase()),
    );

    if (dup && state.applicationId !== dup.id) {
      state.duplicateOf = { company: dup.company, jobTitle: dup.jobTitle, createdAt: dup.createdAt };
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

function countryName(code: string): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

type ApplicationRecordStatus = ApplicationRecord["status"];

async function updateStatus(applicationId: string, status: ApplicationRecordStatus, note?: string): Promise<void> {
  if (!applicationId || !(await isUnlocked())) return;
  const rec = await db.getApplication(applicationId);
  if (!rec) return;
  rec.status = status;
  if (note) rec.errorNotes = note;
  if (status === "Submitted Manually") {
    rec.submittedManually = true;
    rec.submissionDate = new Date().toISOString().slice(0, 10);
  }
  await db.saveApplication(rec);
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
      return { ok: true, unlocked: await isUnlocked() };

    case "activity":
      await resetAutoLock();
      return { ok: true };

    case "pageAnalyzed": {
      if (tabId === undefined) return { ok: false, error: "no tab" };
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
      if (!(await isUnlocked())) return { ok: false, error: "LOCKED" };
      await resetAutoLock();
      const ctx = await buildFillContext(msg.countryCode, msg.portal, msg.company);
      return { ok: true, ctx };
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
      const loginPending = report.warnings.some((w) => w.startsWith("Login"));
      const status: ApplicationRecordStatus = loginPending
        ? "Login Required"
        : report.missing.length > 0 ? "Missing Information" : "Filled";
      await updateStatus(msg.applicationId, status);
      if (msg.applicationId && (await isUnlocked())) {
        const rec = await db.getApplication(msg.applicationId);
        if (rec) {
          rec.missingFields = report.missing.map((m) => m.question).join("; ");
          const tabState = tabId !== undefined ? await getTabState(tabId) : undefined;
          if (tabState?.resumeName && report.resumeAttached) rec.resumeUsed = tabState.resumeName;
          await db.saveApplication(rec);
        }
      }
      notifyPanel();
      return { ok: true };
    }

    case "userAnswer": {
      if (!(await isUnlocked())) return { ok: false, error: "LOCKED" };
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
      await updateStatus(msg.applicationId, msg.status, msg.note);
      notifyPanel();
      return { ok: true };

    case "markSubmitted":
      await updateStatus(msg.applicationId, "Submitted Manually");
      notifyPanel();
      return { ok: true };

    case "startAssistOnActiveTab": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
        return { ok: false, error: "No applicable page in the active tab." };
      }
      const error = await triggerAssist(tab.id);
      return error ? { ok: false, error } : { ok: true };
    }

    case "getSidePanelModel": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const model: SidePanelModel = { unlocked: await isUnlocked(), missing: [] };
      if (tab?.id !== undefined) {
        const state = await getTabState(tab.id);
        model.job = state.job;
        model.report = mergedReport(state);
        model.missing = model.report?.missing ?? [];
        model.resumeName = state.resumeName;
        model.duplicateOf = state.duplicateOf;
        if (state.applicationId && model.unlocked) {
          model.application = await db.getApplication(state.applicationId);
        }
      }
      return { ok: true, model };
    }
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
