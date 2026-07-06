// Options page: profile, country/visa profiles, resumes, saved answers,
// history + Excel export, encrypted backup, settings.

import * as XLSX from "xlsx";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { decorateFieldLabels } from "../lib/tooltip";
import {
  encryptJsonWithPassword, decryptJsonWithPassword, PasswordBox,
} from "../lib/crypto";
import * as db from "../lib/db";
import { aiMatch } from "../lib/matcher";
import {
  AI_PROVIDER_PRESETS, AiProvider, ApplicationRecord, ApplicationStatus, COUNTRIES,
  CountryProfile, ResumeMeta, UserProfile, emptyCountryProfile,
} from "../lib/types";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("options/pdf.worker.min.mjs");

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- unlock gate ----------

async function init(): Promise<void> {
  // legacy password vault still present -> data can't be read until the
  // one-time conversion in the popup runs
  if (await db.getCryptoMeta()) {
    $("locked-overlay").classList.remove("hidden");
    return;
  }
  $("content").classList.remove("hidden");
  setupTabs();
  await loadProfile();
  setupCountries();
  await loadCountry();
  populateResumeCountrySelect();
  await renderResumes();
  await renderAnswers();
  await renderHistory();
  await loadAiConfig();
  wireEvents();
  decorateFieldLabels(document);
}

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tabs button");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((b) => b.classList.toggle("active", b === btn));
      for (const section of document.querySelectorAll("section[id^=tab-]")) {
        section.classList.toggle("hidden", section.id !== `tab-${btn.dataset.tab}`);
      }
    });
  });
}

// ---------- profile ----------

async function loadProfile(): Promise<void> {
  const profile = await db.getProfile();
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-f]")) {
    const key = el.dataset.f as keyof UserProfile;
    el.value = String(profile[key] ?? "");
  }
}

async function saveProfileFromForm(): Promise<void> {
  const profile = await db.getProfile();
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-f]")) {
    const key = el.dataset.f as keyof UserProfile;
    (profile as unknown as Record<string, unknown>)[key] = el.value.trim();
  }
  await db.saveProfile(profile);
  flash("profile-saved", "Saved.");
}

// ---------- country profiles ----------

function setupCountries(): void {
  const sel = $("country-select") as HTMLSelectElement;
  sel.innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join("");
  sel.addEventListener("change", () => void loadCountry());
}

async function loadCountry(): Promise<void> {
  const code = ($("country-select") as HTMLSelectElement).value || COUNTRIES[0].code;
  const meta = COUNTRIES.find((c) => c.code === code)!;
  const cp = (await db.getCountryProfile(code)) ?? emptyCountryProfile(code, meta.name, meta.currency);
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-c]")) {
    const key = el.dataset.c as keyof CountryProfile;
    el.value = String(cp[key] ?? "");
  }
}

async function saveCountryFromForm(): Promise<void> {
  const code = ($("country-select") as HTMLSelectElement).value;
  const meta = COUNTRIES.find((c) => c.code === code)!;
  const cp = (await db.getCountryProfile(code)) ?? emptyCountryProfile(code, meta.name, meta.currency);
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-c]")) {
    const key = el.dataset.c as keyof CountryProfile;
    (cp as unknown as Record<string, unknown>)[key] = el.value.trim();
  }
  await db.saveCountryProfile(cp);
  flash("country-saved", "Saved.");
}

// ---------- resumes ----------

function populateResumeCountrySelect(): void {
  const sel = $("resume-countries") as HTMLSelectElement;
  sel.innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join("");
}

async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
  });
  try {
    const doc = await loadingTask.promise;
    let out = "";
    const pages = Math.min(doc.numPages, 12);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ") + "\n";
    }
    return out.replace(/\s+/g, " ").trim();
  } finally {
    await loadingTask.destroy();
  }
}

async function addResume(): Promise<void> {
  const nameInput = $("resume-name") as HTMLInputElement;
  const fileInput = $("resume-file") as HTMLInputElement;
  const msg = $("resume-msg");
  msg.textContent = "";

  const file = fileInput.files?.[0];
  if (!file) { msg.textContent = "Choose a file."; return; }
  const name = nameInput.value.trim() || file.name;

  let extractedText = "";
  const data = await file.arrayBuffer();
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    msg.textContent = "Extracting text from PDF…";
    try {
      // slice(0): pdf.js transfers its buffer to the worker, so keep our copy
      extractedText = await extractPdfText(data.slice(0));
    } catch {
      msg.textContent = "Could not read PDF text - paste it manually below after adding.";
    }
  }

  const countries = [...($("resume-countries") as HTMLSelectElement).selectedOptions].map((o) => o.value);
  const meta: ResumeMeta = {
    id: crypto.randomUUID(),
    name,
    fileName: file.name,
    fileType: file.type || "application/pdf",
    size: file.size,
    countryCodes: countries,
    role: ($("resume-role") as HTMLInputElement).value.trim(),
    isDefault: ($("resume-default") as HTMLInputElement).checked,
    extractedText,
    updatedAt: Date.now(),
  };

  if (meta.isDefault) {
    for (const r of await db.listResumes()) {
      if (r.isDefault) { r.isDefault = false; await db.updateResumeMeta(r); }
    }
  }

  await db.saveResume(meta, data);
  nameInput.value = "";
  fileInput.value = "";
  ($("resume-role") as HTMLInputElement).value = "";
  ($("resume-default") as HTMLInputElement).checked = false;
  flash("resume-msg", "Resume added.");
  await renderResumes();
}

async function renderResumes(): Promise<void> {
  const list = $("resume-list");
  const resumes = await db.listResumes();
  list.innerHTML = resumes.length ? "" : `<p class="muted">No resumes yet.</p>`;
  for (const r of resumes) {
    const row = document.createElement("div");
    row.className = "list-item";
    const countries = r.countryCodes.length
      ? r.countryCodes.map((c) => COUNTRIES.find((x) => x.code === c)?.name ?? c).join(", ")
      : "General fallback";
    const textState = (r.extractedText ?? "").trim().length > 40
      ? `${(r.extractedText ?? "").length} chars of match text`
      : `<span style="color:var(--amber)">no match text - paste below for AI matching</span>`;
    const info = document.createElement("div");
    info.style.flex = "1";
    info.innerHTML = `<b>${escapeHtml(r.name)}</b>${r.isDefault ? ' <span class="pill ok">default</span>' : ""}<br>
      <span class="muted">${escapeHtml(r.fileName)} · ${(r.size / 1024).toFixed(0)} KB · ${escapeHtml(countries)}${r.role ? " · " + escapeHtml(r.role) : ""} · ${textState}</span>`;

    const details = document.createElement("details");
    details.style.marginTop = "6px";
    const summary = document.createElement("summary");
    summary.className = "muted";
    summary.style.cursor = "pointer";
    summary.textContent = "View / edit match text";
    const ta = document.createElement("textarea");
    ta.rows = 5;
    ta.value = r.extractedText ?? "";
    ta.placeholder = "Paste the resume's text (skills, experience) here. Used only for job matching.";
    const saveTxt = document.createElement("button");
    saveTxt.className = "secondary";
    saveTxt.style.marginTop = "6px";
    saveTxt.textContent = "Save text";
    saveTxt.addEventListener("click", async () => {
      r.extractedText = ta.value.trim();
      await db.updateResumeMeta(r);
      await renderResumes();
    });
    details.append(summary, ta, saveTxt);
    info.appendChild(details);

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await db.deleteResume(r.id);
      await renderResumes();
    });
    row.append(info, del);
    list.appendChild(row);
  }
}

// ---------- AI matching config ----------

async function loadAiConfig(): Promise<void> {
  const cfg = await db.getAiConfig();
  ($("ai-provider") as HTMLSelectElement).value = cfg.provider;
  ($("ai-baseurl") as HTMLInputElement).value = cfg.baseUrl;
  ($("ai-key") as HTMLInputElement).value = cfg.apiKey;
  ($("ai-model") as HTMLInputElement).value = cfg.model;
  ($("ai-enabled") as HTMLInputElement).checked = cfg.enabled;
  ($("ai-auto") as HTMLInputElement).checked = cfg.autoMatch;
}

function readAiForm() {
  return {
    enabled: ($("ai-enabled") as HTMLInputElement).checked,
    autoMatch: ($("ai-auto") as HTMLInputElement).checked,
    provider: ($("ai-provider") as HTMLSelectElement).value as AiProvider,
    baseUrl: ($("ai-baseurl") as HTMLInputElement).value.trim().replace(/\/+$/, ""),
    apiKey: ($("ai-key") as HTMLInputElement).value.trim(),
    model: ($("ai-model") as HTMLInputElement).value.trim(),
    updatedAt: Date.now(),
  };
}

async function saveAiSettings(): Promise<void> {
  const cfg = readAiForm();
  const msg = $("ai-msg");
  if (cfg.enabled && (!cfg.baseUrl || !cfg.apiKey || !cfg.model)) {
    msg.textContent = "Base URL, API key, and model are required to enable.";
    return;
  }
  if (cfg.baseUrl) {
    // the service worker needs cross-origin permission for this host
    try {
      const origin = new URL(cfg.baseUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted && cfg.enabled) {
        msg.textContent = "Permission for that host was declined - AI calls will fail.";
      }
    } catch {
      msg.textContent = "Base URL is not a valid URL.";
      return;
    }
  }
  await db.saveAiConfig(cfg);
  flash("ai-msg", "Saved.");
}

async function testAiConnection(): Promise<void> {
  const msg = $("ai-msg");
  msg.textContent = "Testing…";
  const cfg = readAiForm();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    msg.textContent = "Fill base URL, API key, and model first.";
    return;
  }
  try {
    const origin = new URL(cfg.baseUrl).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) { msg.textContent = "Host permission declined - cannot call the API."; return; }
    const result = await aiMatch(
      cfg, "test://job",
      "Job: Software Developer. Requirements: programming experience.",
      [{ name: "Test profile", text: "Software developer with programming experience." }],
    );
    msg.textContent = `Works! Test match returned ${result.overall}%. Remember to Save.`;
  } catch (e) {
    msg.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- saved answers ----------

async function renderAnswers(): Promise<void> {
  const list = $("answer-list");
  const answers = await db.listSavedAnswers();
  list.innerHTML = answers.length ? "" : `<p class="muted">No saved answers yet. They appear as you apply.</p>`;
  for (const a of answers.sort((x, y) => y.updatedAt - x.updatedAt)) {
    const row = document.createElement("div");
    row.className = "list-item";
    const scopeDetail = a.countryCode || a.portal || a.company || "";
    const info = document.createElement("div");
    info.innerHTML = `<b>${escapeHtml(a.questionRaw)}</b><br>
      <span class="muted">${escapeHtml(a.answer)} · <span class="pill">${a.scope}${scopeDetail ? ": " + escapeHtml(scopeDetail) : ""}</span></span>`;
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await db.deleteAnswer(a.id);
      await renderAnswers();
    });
    row.append(info, del);
    list.appendChild(row);
  }
}

// ---------- history + Excel export ----------

const HISTORY_STATUSES: ApplicationStatus[] = [
  "Saved",
  "Applied",
  "Shortlisted",
  "Interview Scheduled",
  "Rejected",
  "Offer",
];

type HistoryView = "board" | "grid";
let historyView: HistoryView = "board";
let historyRefreshTimer: number | undefined;

async function renderHistory(): Promise<void> {
  const apps = (await db.listApplications()).filter(isHistoryVisible);
  renderHistoryBoard(apps);
  renderHistoryGrid(apps);
  applyHistoryView();
}

function renderHistoryGrid(apps: ApplicationRecord[]): void {
  const tbody = document.querySelector<HTMLTableSectionElement>("#history-table tbody")!;
  tbody.innerHTML = "";
  for (const app of apps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(app.createdAt).toLocaleDateString()}</td>
      <td>${escapeHtml(app.company)}</td>
      <td>${escapeHtml(app.jobTitle)}</td>
      <td>${escapeHtml(app.jobCountry)}</td>
      <td>${escapeHtml(app.portal)}</td>
      <td>${app.jobUrl ? `<a class="job-link" href="${escapeHtml(app.jobUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(app.jobUrl)}">Go to URL</a>` : "-"}</td>`;
    const statusTd = document.createElement("td");
    statusTd.appendChild(statusSelect(app));
    const td = document.createElement("td");
    td.appendChild(historyDeleteButton(app.id));
    tr.appendChild(statusTd);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function renderHistoryBoard(apps: ApplicationRecord[]): void {
  const board = $("history-board");
  board.innerHTML = "";
  for (const status of HISTORY_STATUSES) {
    const columnApps = apps.filter((app) => historyStatus(app) === status);
    const col = document.createElement("div");
    col.className = `history-column history-column-${statusSlug(status)}`;
    col.innerHTML = `
      <div class="history-column-head">
        <span>${escapeHtml(status)}</span>
        <span class="history-count">${columnApps.length}</span>
      </div>`;
    if (columnApps.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "No jobs";
      col.appendChild(empty);
    } else {
      for (const app of columnApps) col.appendChild(historyBoardCard(app));
    }
    board.appendChild(col);
  }
}

function historyBoardCard(app: ApplicationRecord): HTMLElement {
  const card = document.createElement("div");
  card.className = `history-card status-${statusSlug(historyStatus(app))}`;

  const title = document.createElement("div");
  title.className = "history-card-title";
  title.textContent = app.jobTitle || "Untitled role";

  const company = document.createElement("div");
  company.className = "history-card-company";
  company.textContent = app.company || "Unknown company";

  const meta = document.createElement("div");
  meta.className = "history-card-meta";
  meta.innerHTML = `
    <span class="pill">${escapeHtml(new Date(app.createdAt).toLocaleDateString())}</span>
    <span class="pill">${escapeHtml(app.portal || "generic")}</span>
    ${app.jobCountry ? `<span class="pill">${escapeHtml(app.jobCountry)}</span>` : ""}`;

  const actions = document.createElement("div");
  actions.className = "history-card-actions";
  if (app.jobUrl) {
    const link = document.createElement("a");
    link.className = "job-link";
    link.href = app.jobUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = app.jobUrl;
    link.textContent = "Go to URL";
    actions.appendChild(link);
  } else {
    const missing = document.createElement("span");
    missing.className = "muted";
    missing.textContent = "No URL";
    actions.appendChild(missing);
  }

  actions.appendChild(historyDeleteButton(app.id));

  card.append(title, company, meta, statusSelect(app), actions);
  return card;
}

function historyDeleteButton(id: string): HTMLButtonElement {
  const del = document.createElement("button");
  del.className = "history-delete";
  del.type = "button";
  del.title = "Delete record";
  del.setAttribute("aria-label", "Delete history record");
  del.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M6 6l1 15h10l1-15"></path>
      <path d="M10 10v7"></path>
      <path d="M14 10v7"></path>
    </svg>`;
  del.addEventListener("click", () => void deleteHistoryRecord(id));
  return del;
}

function statusSlug(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function deleteHistoryRecord(id: string): Promise<void> {
  await db.deleteApplication(id);
  await renderHistory();
}

function isApplied(app: ApplicationRecord): boolean {
  return !["Viewed", "Saved"].includes(historyStatus(app));
}

function isHistoryVisible(app: ApplicationRecord): boolean {
  return historyStatus(app) !== "Viewed";
}

function historyStatus(app: ApplicationRecord): ApplicationStatus {
  if (app.status === "Submitted Manually") return "Applied";
  if (HISTORY_STATUSES.includes(app.status)) return app.status;
  return app.submittedManually ? "Applied" : "Viewed";
}

function statusSelect(app: ApplicationRecord): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "history-status";
  sel.title = "Update application status";
  sel.innerHTML = HISTORY_STATUSES
    .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
    .join("");
  sel.value = historyStatus(app);
  sel.addEventListener("change", async () => {
    const next = sel.value as ApplicationStatus;
    const rec = await db.getApplication(app.id);
    if (!rec) return;
    rec.status = next;
    rec.submittedManually = next !== "Saved";
    if (next !== "Saved" && !rec.submissionDate) {
      rec.submissionDate = new Date().toISOString().slice(0, 10);
    }
    if (next === "Saved") {
      rec.submittedManually = false;
      rec.submissionDate = "";
    }
    await db.saveApplication(rec);
    await renderHistory();
  });
  return sel;
}

function setHistoryView(view: HistoryView): void {
  historyView = view;
  applyHistoryView();
}

function applyHistoryView(): void {
  $("history-board").classList.toggle("hidden", historyView !== "board");
  $("history-grid").classList.toggle("hidden", historyView !== "grid");
  $("btn-history-board").classList.toggle("active", historyView === "board");
  $("btn-history-grid").classList.toggle("active", historyView === "grid");
}

function scheduleHistoryRefresh(): void {
  if ($("content").classList.contains("hidden")) return;
  window.clearTimeout(historyRefreshTimer);
  historyRefreshTimer = window.setTimeout(() => {
    void renderHistory().catch(() => undefined);
  }, 250);
}

async function exportXlsx(): Promise<void> {
  const apps = (await db.listApplications()).filter(isHistoryVisible);
  // Column set per PRD section 10.3
  const rows = apps.map((a) => ({
    "Application ID": a.id,
    "Date Created": new Date(a.createdAt).toISOString().slice(0, 10),
    "Last Updated": new Date(a.updatedAt).toISOString().slice(0, 10),
    "Company": a.company,
    "Job Title": a.jobTitle,
    "Job Country": a.jobCountry,
    "Job Location": a.jobLocation,
    "Portal": a.portal,
    "Job URL": a.jobUrl,
    "Current Status": historyStatus(a),
    "Current Step": a.currentStep,
    "Missing Fields": a.missingFields,
    "Applied": isApplied(a) ? "Yes" : "No",
    "Submission Date": a.submissionDate,
    "Duplicate Warning": a.duplicateWarning ? "Yes" : "No",
    "Error Notes": a.errorNotes,
    "Follow-up Date": a.followUpDate,
    "Notes": a.notes,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Applications");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `ApplicationTracker-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ---------- backup ----------

async function exportBackup(): Promise<void> {
  const password = prompt(
    "Set a password for this backup file.\nYou will need it to restore the backup (e.g. on another machine).");
  if (!password) { flash("backup-msg", "Export cancelled - a backup password is required."); return; }
  const payload = await db.buildBackup();
  const box = await encryptJsonWithPassword(payload, password);
  downloadBlob(new Blob([JSON.stringify(box)], { type: "application/octet-stream" }),
    `jobpilot-ai-backup-${new Date().toISOString().slice(0, 10)}.pja`);
  flash("backup-msg", "Backup exported.");
}

async function importBackup(file: File): Promise<void> {
  try {
    const box = JSON.parse(await file.text()) as PasswordBox;
    if (!box.saltB64) {
      flash("backup-msg", "This backup is from an old version and cannot be imported.");
      return;
    }
    const password = prompt("Enter the password for this backup file.");
    if (!password) return;
    const payload = await decryptJsonWithPassword<db.BackupPayload>(box, password);
    if (payload.version !== 1) throw new Error("Unsupported backup version.");
    await db.restoreBackup(payload);
    flash("backup-msg", "Backup restored.");
    await loadProfile();
    await renderResumes();
    await renderAnswers();
    await renderHistory();
  } catch {
    flash("backup-msg", "Import failed: wrong password or corrupted file.");
  }
}

// ---------- wipe ----------

async function wipeAll(): Promise<void> {
  if (!confirm("Delete ALL JobPilot AI data (profile, resumes, answers, history)? This cannot be undone.")) return;
  indexedDB.deleteDatabase("fireapply");
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  location.reload();
}

// ---------- helpers ----------

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function flash(id: string, text: string): void {
  const el = $(id);
  el.textContent = text;
  setTimeout(() => { el.textContent = ""; }, 3000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function wireEvents(): void {
  $("btn-save-profile").addEventListener("click", () => void saveProfileFromForm());
  $("btn-save-country").addEventListener("click", () => void saveCountryFromForm());
  $("btn-add-resume").addEventListener("click", () => void addResume());
  $("btn-export-xlsx").addEventListener("click", () => void exportXlsx());
  $("btn-history-board").addEventListener("click", () => setHistoryView("board"));
  $("btn-history-grid").addEventListener("click", () => setHistoryView("grid"));
  $("btn-export-backup").addEventListener("click", () => void exportBackup());
  $("btn-import-backup").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", () => {
    const file = ($("import-file") as HTMLInputElement).files?.[0];
    if (file) void importBackup(file);
  });
  $("btn-wipe").addEventListener("click", () => void wipeAll());
  $("btn-save-ai").addEventListener("click", () => void saveAiSettings());
  $("btn-test-ai").addEventListener("click", () => void testAiConnection());
  $("ai-provider").addEventListener("change", () => {
    const preset = AI_PROVIDER_PRESETS[($("ai-provider") as HTMLSelectElement).value as AiProvider];
    ($("ai-baseurl") as HTMLInputElement).value = preset.baseUrl;
    ($("ai-model") as HTMLInputElement).placeholder = preset.modelHint;
    if (!($("ai-model") as HTMLInputElement).value) {
      ($("ai-model") as HTMLInputElement).value = preset.modelHint;
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "panelRefresh") scheduleHistoryRefresh();
});

void init();
