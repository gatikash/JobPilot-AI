// Side panel: live view of the current application, missing-field Q&A.

import { SidePanelModel } from "../lib/messages";
import { initStaticTips, makeTip } from "../lib/tooltip";
import { COUNTRIES, MissingField } from "../lib/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let current: SidePanelModel | null = null;
let tailoringCollapsed = false;

async function refresh(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: "getSidePanelModel" }).catch(() => undefined);
  if (!res?.ok) {
    $("panel-loading").classList.add("hidden");
    $("no-job").classList.remove("hidden");
    return;
  }
  current = res.model as SidePanelModel;
  render();
}

function render(): void {
  const m = current;
  if (!m) return;

  const loading = !!m.analyzing;
  $("panel-loading").classList.toggle("hidden", !loading);
  if (loading) {
    // hide all job data while a fresh analysis is pending: no stale content
    for (const id of ["no-job", "job-card", "match-card", "likely-applied", "fill-summary", "missing-section", "next-hint"]) {
      $(id).classList.add("hidden");
    }
    $("warnings").innerHTML = "";
    return;
  }

  const hasJob = !!m.job;
  $("no-job").classList.toggle("hidden", hasJob);
  $("job-card").classList.toggle("hidden", !hasJob);

  if (m.job) {
    $("j-title").textContent = m.job.title || "-";
    $("j-company").textContent = m.job.company || "-";
    $("j-location").textContent = m.job.location || "-";
    $("j-applicants").textContent = m.job.applicants || "-";
    $("j-country").textContent =
      COUNTRIES.find((c) => c.code === m.job!.countryCode)?.name ?? "Not detected";
    $("j-portal").textContent = m.job.portal;
    $("j-resume").textContent = m.resumeName ?? "None";
    const status = visibleStatus(m.application);
    $("j-status").textContent = status;
    $("j-status").className = `pill ${statusTone(status)}`;
  }

  renderMarkAppliedButton(m);

  renderMatch(m);

  renderLikelyApplied(m);

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

function renderMarkAppliedButton(m: SidePanelModel): void {
  const btn = $("btn-submitted") as HTMLButtonElement;
  if (!m.job) {
    btn.disabled = true;
    btn.textContent = "Mark as Applied";
    return;
  }
  const applied = isPipelineAppliedStatus(visibleStatus(m.application));
  btn.disabled = applied;
  btn.textContent = applied ? "Applied" : "Mark as Applied";
}

function renderLikelyApplied(m: SidePanelModel): void {
  const box = $("likely-applied");
  const alreadyApplied = isPipelineAppliedStatus(visibleStatus(m.application));
  const isLinkedIn = m.job?.portal === "linkedin";
  box.classList.toggle("hidden", !m.likelyApplied || alreadyApplied || isLinkedIn);
  box.innerHTML = "";
  if (!m.likelyApplied || alreadyApplied || isLinkedIn) return;

  const text = document.createElement("div");
  text.textContent = `This page looks submitted: ${m.likelyApplied.reason}`;
  const btn = document.createElement("button");
  btn.textContent = "Mark as Applied";
  btn.style.marginTop = "8px";
  btn.addEventListener("click", async () => {
    await markCurrentApplied(btn);
  });
  box.append(text, btn);
}

function visibleStatus(app: SidePanelModel["application"]): string {
  if (!app) return "Viewed";
  if (app.status === "Submitted Manually") return "Applied";
  if (["Saved", "Applied", "Shortlisted", "Interview Scheduled", "Rejected", "Offer"].includes(app.status)) {
    return app.status;
  }
  return app.submittedManually ? "Applied" : "Viewed";
}

function isPipelineAppliedStatus(status: string): boolean {
  return ["Applied", "Shortlisted", "Interview Scheduled", "Rejected", "Offer"].includes(status);
}

function statusTone(status: string): string {
  if (["Applied", "Shortlisted", "Interview Scheduled", "Offer"].includes(status)) return "ok";
  if (["Rejected", "Failed", "Skipped"].includes(status)) return "bad";
  if (status === "Viewed") return "";
  return "warn";
}

function renderMatch(m: SidePanelModel): void {
  const card = $("match-card");
  const hasJob = !!m.job?.title;
  card.classList.toggle("hidden", !hasJob);
  if (!hasJob) return;

  const overall = $("match-overall");
  const status = $("match-status");
  const profiles = $("match-profiles");
  const missing = $("match-missing");
  const recommend = $("match-recommend");
  const btn = $("btn-match") as HTMLButtonElement;
  const tailorBtn = $("btn-tailor") as HTMLButtonElement;

  btn.disabled = !!m.matchPending;
  btn.textContent = m.matchPending ? "Matching..." : (m.match ? "Re-match" : "Match this job");
  tailorBtn.disabled = !!m.tailoringPending;
  tailorBtn.textContent = m.tailoringPending ? "Tailoring..." : (m.tailoring ? "Refresh tailoring" : "Tailor resume");

  if (!m.match) {
    overall.textContent = m.matchPending ? "…" : "-";
    overall.className = "score-value";
    const ring = overall.closest<HTMLElement>(".score-ring");
    if (ring) {
      ring.style.background = "";
      ring.classList.toggle("is-loading", !!m.matchPending);
    }
    profiles.innerHTML = "";
    missing.innerHTML = "";
    recommend.textContent = "";
    status.innerHTML = m.matchPending
      ? `<span class="tailor-spinner" aria-hidden="true" style="margin-right:6px;vertical-align:-2px;"></span>Analysing match score, please wait…`
      : (m.aiConfigured
        ? "Click Match to score this job against your resumes."
        : "Tip: configure AI Matching in Settings for semantic scores. Without it you get a free keyword estimate.");
    renderTailoring(m);
    return;
  }

  const r = m.match;
  overall.textContent = `${r.overall}%`;
  const scoreClass = r.overall >= 65 ? "score-good" : r.overall >= 40 ? "score-warn" : "score-bad";
  const scoreColor = r.overall >= 65 ? "var(--green)" : r.overall >= 40 ? "var(--amber)" : "var(--red)";
  overall.className = `score-value ${scoreClass}`;
  const ring = overall.closest<HTMLElement>(".score-ring");
  if (ring) {
    ring.style.background =
      `radial-gradient(circle at center, #fff 0 55%, transparent 56%), conic-gradient(${scoreColor} 0 ${r.overall}%, #e5edf7 ${r.overall}% 100%)`;
    ring.classList.toggle("is-loading", !!m.matchPending);
  }

  if (m.matchPending) {
    status.innerHTML = `<span class="tailor-spinner" aria-hidden="true" style="margin-right:6px;vertical-align:-2px;"></span>Refining match score with AI…`;
  } else {
    status.textContent = r.source === "ai"
      ? `AI score (${r.model ?? "model"})`
      : "Keyword estimate" + (m.aiConfigured ? "" : " - add an AI key in Settings for smarter scoring");
  }
  if (r.error && !m.matchPending) status.textContent = r.error;

  profiles.innerHTML = "";
  for (const p of r.profiles) {
    const row = document.createElement("div");
    row.className = "match-row";
    const color = p.percent >= 65 ? "var(--green)" : p.percent >= 40 ? "var(--amber)" : "var(--red)";
    row.innerHTML = `
      <div class="mr-head"><span>${escapeHtml(p.name)}</span><b>${p.percent}%</b></div>
      <div class="match-bar"><div style="width:${p.percent}%; background:${color};"></div></div>
      ${p.reason ? `<div class="mr-reason">${escapeHtml(p.reason)}</div>` : ""}`;
    profiles.appendChild(row);
  }

  missing.innerHTML = r.missingKeywords.length
    ? `<div class="muted" style="margin-top:10px;"><b>Missing skills</b></div>
      <div class="chip-list">${r.missingKeywords
        .map((kw) => `<span class="skill-chip missing">${escapeHtml(kw)}</span>`)
        .join("")}</div>`
    : `<div class="chip-list"><span class="skill-chip">No obvious missing keywords</span></div>`;
  recommend.innerHTML = r.recommendedResume
    ? `<div class="recommend-card"><b>Recommended resume</b><br>${escapeHtml(r.recommendedResume)}</div>`
    : "";
  renderTailoring(m);
}

function renderTailoring(m: SidePanelModel): void {
  const panel = $("tailor-panel");
  panel.innerHTML = "";
  const pending = !!m.tailoringPending;
  const t = m.tailoring;
  panel.classList.toggle("hidden", !t && !pending);
  if (!t && !pending) return;

  const head = document.createElement("div");
  head.className = "tailor-head";

  const title = document.createElement("div");
  title.className = "tailor-title";
  if (pending) {
    const spinner = document.createElement("span");
    spinner.className = "tailor-spinner";
    spinner.setAttribute("aria-hidden", "true");
    title.appendChild(spinner);
  }

  const titleText = document.createElement("div");
  titleText.className = "tailor-title-text";
  if (pending) {
    titleText.innerHTML = `
      <b>Tailoring resume...</b><br>
      <span class="muted">${t ? "Refreshing the AI summary." : "Generating resume suggestions."}</span>`;
  } else if (t) {
    const source = t.source === "ai"
      ? `AI suggestions${t.model ? " (" + t.model + ")" : ""}`
      : "Keyword suggestions";
    titleText.innerHTML = `
      <b>${escapeHtml(source)}</b><br>
      <span class="muted">For ${escapeHtml(t.resumeName || "selected resume")}</span>`;
  }
  title.appendChild(titleText);
  head.appendChild(title);

  if (t) {
    const toggle = document.createElement("button");
    toggle.className = `tailor-toggle${tailoringCollapsed ? " collapsed" : ""}`;
    toggle.type = "button";
    toggle.title = tailoringCollapsed ? "Show tailored summary" : "Hide tailored summary";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!tailoringCollapsed));
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6"></path>
      </svg>`;
    toggle.addEventListener("click", () => {
      tailoringCollapsed = !tailoringCollapsed;
      renderTailoring(current ?? m);
    });
    head.appendChild(toggle);
  }

  panel.appendChild(head);

  if (pending && !t) {
    const loader = document.createElement("div");
    loader.className = "tailor-loader-row";
    loader.textContent = "Building a tailored resume summary from this job and your selected resume.";
    panel.appendChild(loader);
    return;
  }

  if (!t || tailoringCollapsed) return;

  const content = document.createElement("div");
  content.className = "tailor-content";
  content.innerHTML = `
    ${pending ? `<div class="summary-strip">Updating AI suggestions...</div>` : ""}
    ${t.error ? `<div class="warning-box">${escapeHtml(t.error)}</div>` : ""}
    ${t.summary ? `<p style="font-size:13px; margin:6px 0;">${escapeHtml(t.summary)}</p>` : ""}
    ${renderList("Keywords to add", t.keywordsToAdd)}
    ${renderList("Bullet ideas", t.suggestedBullets)}
    ${renderList("Notes", t.notes)}
  `;
  panel.appendChild(content);
}

function renderList(title: string, items: string[]): string {
  if (!items.length) return "";
  return `<div style="margin-top:8px;"><b style="font-size:12px;">${escapeHtml(title)}</b><ul style="margin:4px 0 0 18px; padding:0;">${
    items.map((item) => `<li style="font-size:12px; margin:3px 0;">${escapeHtml(item)}</li>`).join("")
  }</ul></div>`;
}

function canDraftQuestion(question: string): boolean {
  return !/\b(authorized to work|sponsorship|visa|work permit|salary|compensation|date of birth|nationality|citizenship|gender|race|ethnicity|disability|veteran|criminal|conviction|religion|sexual orientation)\b/i
    .test(question);
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
  dismiss.textContent = "x";
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
  let setValue: (value: string) => void;

  if ((field.kind === "select" || field.kind === "radio") && field.options?.length) {
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">Choose...</option>` +
      field.options.map((o) => `<option>${escapeHtml(o)}</option>`).join("");
    wrap.appendChild(sel);
    getValue = () => sel.value;
    setValue = () => undefined;
  } else if (field.kind === "textarea") {
    const ta = document.createElement("textarea");
    ta.rows = 3;
    wrap.appendChild(ta);
    getValue = () => ta.value;
    setValue = (value: string) => { ta.value = value; };
  } else if (field.kind === "checkbox") {
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">Choose...</option><option>Yes</option><option>No</option>`;
    wrap.appendChild(sel);
    getValue = () => sel.value;
    setValue = () => undefined;
  } else {
    const input = document.createElement("input");
    input.type = field.kind === "date" ? "date" : "text";
    wrap.appendChild(input);
    getValue = () => input.value;
    setValue = (value: string) => { input.value = value; };
  }

  const canDraft = (field.kind === "text" || field.kind === "textarea") && canDraftQuestion(field.question);
  if (canDraft) {
    const draftBtn = document.createElement("button");
    draftBtn.className = "secondary";
    draftBtn.textContent = "Draft answer";
    draftBtn.style.marginBottom = "6px";
    const draftMsg = document.createElement("div");
    draftMsg.className = "muted";
    draftBtn.addEventListener("click", async () => {
      draftBtn.disabled = true;
      draftMsg.textContent = "Drafting...";
      const res = await chrome.runtime.sendMessage({
        type: "draftAnswer",
        applicationId: current?.application?.id ?? "",
        question: field.question,
      }).catch(() => undefined);
      if (res?.ok && res.draft?.answer) {
        setValue(res.draft.answer);
        draftMsg.textContent = res.draft.error ?? `${res.draft.source === "ai" ? "AI" : "Local"} draft inserted. Review before filling.`;
      } else {
        draftMsg.textContent = res?.error ?? "Could not draft an answer.";
      }
      draftBtn.disabled = false;
    });
    wrap.append(draftBtn, draftMsg);
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

$("btn-match").addEventListener("click", async () => {
  ($("btn-match") as HTMLButtonElement).disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "requestMatch", force: true }).catch(() => undefined);
  if (res && !res.ok && res.error) {
    $("match-status").textContent = res.error;
  }
  await refresh();
});

$("btn-tailor").addEventListener("click", async () => {
  ($("btn-tailor") as HTMLButtonElement).disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "requestTailoring", force: true }).catch(() => undefined);
  if (res && !res.ok && res.error) {
    $("match-status").textContent = res.error;
  }
  await refresh();
});

$("btn-save-later").addEventListener("click", async () => {
  const btn = $("btn-save-later") as HTMLButtonElement;
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "saveJobForLater" }).catch(() => undefined);
  btn.textContent = res?.ok ? "Saved" : "Could not save";
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Save for later";
  }, 1600);
  await refresh();
});

$("btn-analyze-profile").addEventListener("click", async () => {
  const btn = $("btn-analyze-profile") as HTMLButtonElement;
  const original = btn.textContent || "Analyze profile";
  btn.disabled = true;
  btn.textContent = "Analyzing...";
  const res = await chrome.runtime.sendMessage({ type: "analyzeActiveJob" })
    .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  await refresh();
  const summary = $("fill-summary");
  summary.classList.remove("hidden");
  if (res?.ok) {
    const warnings = Array.isArray(res.warnings) ? res.warnings.filter(Boolean) : [];
    summary.textContent = warnings.length
      ? `Analysis complete. ${warnings.join(" ")}`
      : "Analysis complete. Match score is updated below.";
  } else {
    summary.textContent = res?.error ?? "Could not analyze this page.";
  }
  btn.disabled = false;
  btn.textContent = original;
});

$("btn-rerun").addEventListener("click", async () => {
  const btn = $("btn-rerun") as HTMLButtonElement;
  const original = btn.textContent || "Scan & fill";
  btn.disabled = true;
  btn.textContent = "Scanning...";
  const res = await chrome.runtime.sendMessage({ type: "startAssistOnActiveTab" })
    .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  const error = !res?.ok ? (res?.error ?? "Could not scan this page.") : "";
  await refresh();
  if (!res?.ok) {
    const summary = $("fill-summary");
    summary.classList.remove("hidden");
    summary.textContent = error;
  }
  btn.disabled = false;
  btn.textContent = original;
});

$("btn-submitted").addEventListener("click", async () => {
  await markCurrentApplied($("btn-submitted") as HTMLButtonElement);
});

async function markCurrentApplied(btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent || "Mark as Applied";
  btn.disabled = true;
  btn.textContent = "Marking...";
  const res = await chrome.runtime.sendMessage({
    type: "markSubmitted",
    applicationId: current?.application?.id,
  }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));

  if (res?.ok) {
    btn.textContent = "Applied";
    await refresh();
    return;
  }

  btn.textContent = res?.error ?? "Could not mark";
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = original;
  }, 2200);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "panelRefresh") void refresh();
});

// refresh when the user switches tabs
chrome.tabs.onActivated.addListener(() => void refresh());

// Long-lived port so the background service worker can tell when the side
// panel closes. When the panel is closed the port disconnects; the content
// script uses that signal to stop autofilling on modal mutations.
const keepAlivePort = chrome.runtime.connect({ name: "sidepanel" });
// Keep the reference alive across the module lifetime; nothing to send.
void keepAlivePort;

initStaticTips();
void refresh();
