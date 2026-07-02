// Options page: profile, country/visa profiles, resumes, saved answers,
// history + Excel export, encrypted backup, settings.

import * as XLSX from "xlsx";
import { decorateFieldLabels } from "../lib/tooltip";
import { encryptJson, decryptJson, getSessionKey, isUnlocked, EncryptedBox } from "../lib/crypto";
import * as db from "../lib/db";
import {
  COUNTRIES, CountryProfile, ResumeMeta, UserProfile, emptyCountryProfile,
} from "../lib/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- unlock gate ----------

async function init(): Promise<void> {
  if (!(await isUnlocked())) {
    $("locked-overlay").classList.remove("hidden");
    return;
  }
  $("content").classList.remove("hidden");
  await chrome.runtime.sendMessage({ type: "activity" }).catch(() => undefined);
  setupTabs();
  await loadProfile();
  setupCountries();
  await loadCountry();
  populateResumeCountrySelect();
  await renderResumes();
  await renderAnswers();
  await renderHistory();
  await loadSettings();
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

async function addResume(): Promise<void> {
  const nameInput = $("resume-name") as HTMLInputElement;
  const fileInput = $("resume-file") as HTMLInputElement;
  const msg = $("resume-msg");
  msg.textContent = "";

  const file = fileInput.files?.[0];
  if (!file) { msg.textContent = "Choose a file."; return; }
  const name = nameInput.value.trim() || file.name;

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
    updatedAt: Date.now(),
  };

  if (meta.isDefault) {
    for (const r of await db.listResumes()) {
      if (r.isDefault) { r.isDefault = false; await db.updateResumeMeta(r); }
    }
  }

  await db.saveResume(meta, await file.arrayBuffer());
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
    const info = document.createElement("div");
    info.innerHTML = `<b>${escapeHtml(r.name)}</b>${r.isDefault ? ' <span class="pill ok">default</span>' : ""}<br>
      <span class="muted">${escapeHtml(r.fileName)} · ${(r.size / 1024).toFixed(0)} KB · ${escapeHtml(countries)}${r.role ? " · " + escapeHtml(r.role) : ""}</span>`;
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

async function renderHistory(): Promise<void> {
  const tbody = document.querySelector<HTMLTableSectionElement>("#history-table tbody")!;
  tbody.innerHTML = "";
  for (const app of await db.listApplications()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(app.createdAt).toLocaleDateString()}</td>
      <td>${escapeHtml(app.company)}</td>
      <td>${escapeHtml(app.jobTitle)}</td>
      <td>${escapeHtml(app.jobCountry)}</td>
      <td>${escapeHtml(app.portal)}</td>
      <td><span class="pill${app.status === "Submitted Manually" ? " ok" : ""}">${escapeHtml(app.status)}</span></td>
      <td>${escapeHtml(app.resumeUsed)}</td>`;
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "✕";
    del.title = "Delete record";
    del.addEventListener("click", async () => {
      await db.deleteApplication(app.id);
      await renderHistory();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function exportXlsx(): Promise<void> {
  const apps = await db.listApplications();
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
    "Current Status": a.status,
    "Current Step": a.currentStep,
    "Resume Used": a.resumeUsed,
    "Missing Fields": a.missingFields,
    "Submitted Manually": a.submittedManually ? "Yes" : "No",
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
  const key = await getSessionKey();
  if (!key) return;
  const payload = await db.buildBackup();
  const box = await encryptJson(payload, key);
  downloadBlob(new Blob([JSON.stringify(box)], { type: "application/octet-stream" }),
    `fireapply-backup-${new Date().toISOString().slice(0, 10)}.pja`);
  flash("backup-msg", "Backup exported.");
}

async function importBackup(file: File): Promise<void> {
  const key = await getSessionKey();
  if (!key) return;
  try {
    const box = JSON.parse(await file.text()) as EncryptedBox;
    const payload = await decryptJson<db.BackupPayload>(box, key);
    if (payload.version !== 1) throw new Error("Unsupported backup version.");
    await db.restoreBackup(payload);
    flash("backup-msg", "Backup restored.");
    await loadProfile();
    await renderResumes();
    await renderAnswers();
    await renderHistory();
  } catch {
    flash("backup-msg", "Import failed: wrong password vault or corrupted file.");
  }
}

// ---------- settings / wipe ----------

async function loadSettings(): Promise<void> {
  const s = await db.getSettings();
  ($("autolock") as HTMLInputElement).value = String(s.autoLockMinutes);
}

async function saveSettings(): Promise<void> {
  const minutes = Math.max(0, Number(($("autolock") as HTMLInputElement).value) || 0);
  await db.setSettings({ autoLockMinutes: minutes });
  await chrome.runtime.sendMessage({ type: "activity" }).catch(() => undefined);
  flash("settings-msg", "Saved.");
}

async function wipeAll(): Promise<void> {
  if (!confirm("Delete ALL FireApply data (profile, resumes, answers, history)? This cannot be undone.")) return;
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
  $("btn-export-backup").addEventListener("click", () => void exportBackup());
  $("btn-import-backup").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", () => {
    const file = ($("import-file") as HTMLInputElement).files?.[0];
    if (file) void importBackup(file);
  });
  $("btn-save-settings").addEventListener("click", () => void saveSettings());
  $("btn-wipe").addEventListener("click", () => void wipeAll());
}

void init();
