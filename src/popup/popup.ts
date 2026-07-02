// Popup: vault setup/unlock, page status, assist trigger.

import { createVault, unlockVault, lockVault, isUnlocked } from "../lib/crypto";
import { initStaticTips } from "../lib/tooltip";
import { getCryptoMeta, setCryptoMeta } from "../lib/db";
import { SidePanelModel } from "../lib/messages";
import { COUNTRIES } from "../lib/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function show(view: "setup" | "lock" | "main"): void {
  $("setup-view").classList.toggle("hidden", view !== "setup");
  $("lock-view").classList.toggle("hidden", view !== "lock");
  $("main-view").classList.toggle("hidden", view !== "main");
}

async function refresh(): Promise<void> {
  const meta = await getCryptoMeta();
  if (!meta) return show("setup");
  if (!(await isUnlocked())) return show("lock");
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

$("btn-create").addEventListener("click", async () => {
  const p1 = ($("setup-pass") as HTMLInputElement).value;
  const p2 = ($("setup-pass2") as HTMLInputElement).value;
  const err = $("setup-error");
  err.textContent = "";
  if (p1.length < 8) { err.textContent = "Use at least 8 characters."; return; }
  if (p1 !== p2) { err.textContent = "Passwords do not match."; return; }
  const meta = await createVault(p1);
  await setCryptoMeta(meta);
  await chrome.runtime.sendMessage({ type: "activity" }).catch(() => undefined);
  await refresh();
  chrome.runtime.openOptionsPage();
});

$("btn-unlock").addEventListener("click", async () => {
  const pass = ($("unlock-pass") as HTMLInputElement).value;
  const err = $("unlock-error");
  err.textContent = "";
  const meta = await getCryptoMeta();
  if (!meta) return;
  if (await unlockVault(pass, meta)) {
    await chrome.runtime.sendMessage({ type: "activity" }).catch(() => undefined);
    await refresh();
  } else {
    err.textContent = "Wrong password.";
  }
});

$("unlock-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-unlock").click();
});

$("btn-assist").addEventListener("click", async () => {
  $("assist-error").textContent = "";
  const res = await chrome.runtime.sendMessage({ type: "startAssistOnActiveTab" }).catch(() => undefined);
  if (!res?.ok) {
    $("assist-error").textContent = res?.error ?? "Could not start assist.";
    return;
  }
  // open the side panel so the user sees progress + missing fields
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
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

$("btn-lock").addEventListener("click", async () => {
  await lockVault();
  await refresh();
});

initStaticTips();
void refresh();
