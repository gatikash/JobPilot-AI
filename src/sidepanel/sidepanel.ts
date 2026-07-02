// Side panel: live view of the current application, missing-field Q&A.

import { SidePanelModel } from "../lib/messages";
import { initStaticTips, makeTip } from "../lib/tooltip";
import { COUNTRIES, MissingField } from "../lib/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let current: SidePanelModel | null = null;

async function refresh(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: "getSidePanelModel" }).catch(() => undefined);
  if (!res?.ok) return;
  current = res.model as SidePanelModel;
  render();
}

function render(): void {
  const m = current;
  if (!m) return;

  $("locked-note").classList.toggle("hidden", m.unlocked);

  const hasJob = !!m.job;
  $("no-job").classList.toggle("hidden", hasJob);
  $("job-card").classList.toggle("hidden", !hasJob);

  if (m.job) {
    $("j-title").textContent = m.job.title || "-";
    $("j-company").textContent = m.job.company || "-";
    $("j-location").textContent = m.job.location || "-";
    $("j-country").textContent =
      COUNTRIES.find((c) => c.code === m.job!.countryCode)?.name ?? "Not detected";
    $("j-portal").textContent = m.job.portal;
    $("j-resume").textContent = m.resumeName ?? "None";
    $("j-status").textContent = m.application?.status ?? "Viewed";
  }

  const dup = $("dup-warning");
  if (m.duplicateOf) {
    dup.classList.remove("hidden");
    dup.textContent = `You may have already applied: ${m.duplicateOf.jobTitle} at ${m.duplicateOf.company} (${new Date(m.duplicateOf.createdAt).toLocaleDateString()}). Review before continuing.`;
  } else {
    dup.classList.add("hidden");
  }

  const warnings = $("warnings");
  warnings.innerHTML = "";
  for (const w of m.report?.warnings ?? []) {
    const div = document.createElement("div");
    div.className = "warning-box";
    div.textContent = w;
    warnings.appendChild(div);
  }

  const summary = $("fill-summary");
  if (m.report) {
    summary.classList.remove("hidden");
    summary.textContent = `${m.report.filled.length} field(s) filled` +
      (m.report.resumeAttached ? ", resume attached" : "") + ".";
  } else {
    summary.classList.add("hidden");
  }

  const missingSection = $("missing-section");
  const list = $("missing-list");
  list.innerHTML = "";
  if (m.missing.length > 0) {
    missingSection.classList.remove("hidden");
    for (const field of m.missing) list.appendChild(missingItem(field));
  } else {
    missingSection.classList.add("hidden");
  }

  $("next-hint").classList.toggle(
    "hidden",
    !(m.report && m.missing.length === 0 && (m.report.warnings.length === 0)),
  );
}

function missingItem(field: MissingField): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "missing-item";

  const qRow = document.createElement("div");
  qRow.className = "q-row";
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = field.question + (field.required ? " *" : "");
  const dismiss = document.createElement("button");
  dismiss.className = "dismiss";
  dismiss.textContent = "✕";
  dismiss.title = "Dismiss - I'll handle this field myself. It won't be asked again for this application.";
  dismiss.addEventListener("click", async () => {
    dismiss.disabled = true;
    await chrome.runtime.sendMessage({
      type: "dismissField",
      applicationId: current?.application?.id ?? "",
      fieldId: field.fieldId,
      question: field.question,
    }).catch(() => undefined);
    await refresh();
  });
  qRow.append(q, dismiss);
  wrap.appendChild(qRow);

  let getValue: () => string;

  if ((field.kind === "select" || field.kind === "radio") && field.options?.length) {
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">Choose...</option>` +
      field.options.map((o) => `<option>${escapeHtml(o)}</option>`).join("");
    wrap.appendChild(sel);
    getValue = () => sel.value;
  } else if (field.kind === "textarea") {
    const ta = document.createElement("textarea");
    ta.rows = 3;
    wrap.appendChild(ta);
    getValue = () => ta.value;
  } else if (field.kind === "checkbox") {
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">Choose...</option><option>Yes</option><option>No</option>`;
    wrap.appendChild(sel);
    getValue = () => sel.value;
  } else {
    const input = document.createElement("input");
    input.type = field.kind === "date" ? "date" : "text";
    wrap.appendChild(input);
    getValue = () => input.value;
  }

  const saveRow = document.createElement("div");
  saveRow.className = "save-row";
  const scope = document.createElement("select");
  scope.innerHTML = `
    <option value="once">Use once only</option>
    <option value="exact" selected>Save for this exact question</option>
    <option value="global">Save globally</option>
    <option value="country">Save for this country</option>
    <option value="portal">Save for this portal</option>
    <option value="company">Save for this company</option>`;
  const btn = document.createElement("button");
  btn.textContent = "Fill";
  saveRow.append(
    scope,
    makeTip(
      "How this answer is remembered. Once = fill now, forget after. Exact question = reuse whenever this same question appears (recommended). Global / country / portal / company = reuse for any similar question within that scope. Precedence when several match: exact > company > portal > country > global.",
    ),
    btn,
  );
  wrap.appendChild(saveRow);

  btn.addEventListener("click", async () => {
    const answer = getValue().trim();
    if (!answer) return;
    btn.disabled = true;
    await chrome.runtime.sendMessage({
      type: "userAnswer",
      applicationId: current?.application?.id ?? "",
      fieldId: field.fieldId,
      question: field.question,
      answer,
      scope: scope.value,
      countryCode: current?.job?.countryCode ?? "",
      portal: current?.job?.portal ?? "",
      company: current?.job?.company ?? "",
    }).catch(() => undefined);
    await refresh();
  });

  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

$("btn-rerun").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "startAssistOnActiveTab" }).catch(() => undefined);
  setTimeout(() => void refresh(), 1500);
});

$("btn-submitted").addEventListener("click", async () => {
  if (!current?.application?.id) return;
  await chrome.runtime.sendMessage({
    type: "markSubmitted",
    applicationId: current.application.id,
  }).catch(() => undefined);
  await refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "panelRefresh") void refresh();
});

// refresh when the user switches tabs
chrome.tabs.onActivated.addListener(() => void refresh());

initStaticTips();
void refresh();
