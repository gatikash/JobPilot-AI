// Popup: page status, assist trigger, and one-time legacy-vault migration.

import { unlockLegacyVault } from "../lib/crypto";
import { getCryptoMeta, migrateFromLegacyVault } from "../lib/db";
import { SidePanelModel } from "../lib/messages";
import { initStaticTips } from "../lib/tooltip";
import { COUNTRIES } from "../lib/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function show(view: "migrate" | "main"): void {
  $("migrate-view").classList.toggle("hidden", view !== "migrate");
  $("main-view").classList.toggle("hidden", view !== "main");
}

async function refresh(): Promise<void> {
  // legacy password-protected vault present -> one-time conversion needed
  const legacy = await getCryptoMeta();
  if (legacy) return show("migrate");
  show("main");

  const res = await chrome.runtime.sendMessage({ type: "getSidePanelModel" }).catch(() => undefined);
  const model: SidePanelModel | undefined = res?.model;
  if (model?.job) {
    $("st-portal").textContent = model.job.portal;
    $("st-country").textContent =
      COUNTRIES.find((c) => c.code === model.job!.countryCode)?.name ?? "Not detected";
    $("st-resume").textContent = model.resumeName ?? "None selected";
  }
}

$("btn-migrate").addEventListener("click", async () => {
  const err = $("migrate-error");
  err.textContent = "";
  const meta = await getCryptoMeta();
  if (!meta) { await refresh(); return; }
  const pass = ($("migrate-pass") as HTMLInputElement).value;
  const oldKey = await unlockLegacyVault(pass, meta);
  if (!oldKey) { err.textContent = "Wrong password."; return; }
  ($("btn-migrate") as HTMLButtonElement).disabled = true;
  err.textContent = "";
  try {
    await migrateFromLegacyVault(oldKey);
    await refresh();
  } catch (e) {
    err.textContent = `Migration failed: ${e instanceof Error ? e.message : String(e)}`;
    ($("btn-migrate") as HTMLButtonElement).disabled = false;
  }
});

$("btn-migrate-reset").addEventListener("click", async () => {
  if (!confirm("Delete ALL JobPilot AI data (profile, resumes, answers, history)? This cannot be undone.")) return;
  indexedDB.deleteDatabase("fireapply");
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await refresh();
});

$("btn-assist").addEventListener("click", async () => {
  $("assist-error").textContent = "";
  const btn = $("btn-assist") as HTMLButtonElement;
  const original = btn.textContent || "Start Assist on this page";
  btn.disabled = true;
  btn.textContent = "Scanning...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  }
  const res = await chrome.runtime.sendMessage({ type: "startAssistOnActiveTab" })
    .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!res?.ok) {
    $("assist-error").textContent = res?.error ?? "Could not start assist.";
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  window.close();
});

$("btn-panel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  }
  window.close();
});

$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

initStaticTips();
void refresh();
