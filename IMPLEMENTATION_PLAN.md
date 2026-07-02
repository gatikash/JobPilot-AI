# FireApply — Implementation Plan

Personal Job Application Assistant: Chrome Extension (MV3) + Local Windows Helper App (.NET 8).
Based on PRD v1.0 (2026-07-02). No AI, no LinkedIn, no auto-submit, local-only encrypted storage.

---

## 1. Tech Stack

| Component | Choice | Reason |
|---|---|---|
| Extension | TypeScript + Vite + `@crxjs/vite-plugin` | Type safety for rule engine; HMR dev loop |
| Extension UI | Preact (popup, side panel, options) | Tiny bundle, React-like DX |
| Helper app | .NET 8, WPF | Windows-native UI, mature crypto, easy MSIX-free install |
| Helper DB | SQLite via `Microsoft.Data.Sqlite` + field-level AES-256-GCM | Avoids SQLCipher native-dep pain; encrypt sensitive columns only |
| Key derivation | PBKDF2-SHA256 (600k iters) or Argon2id (`Konscious.Security.Cryptography`) | Master password → key; salt stored beside DB |
| Excel writer | ClosedXML | Simple row upsert, no Excel install needed |
| Native messaging | stdio JSON, length-prefixed (Chrome standard) | Only bridge extension ↔ helper |
| Testing | Vitest (extension, HTML fixtures), xUnit (helper) | Rule engine and crypto need regression tests |

## 2. Repository Layout

```text
FireApply/
  extension/
    src/
      background/        # service worker: native port, workflow state
      content/           # field scanner, filler, highlighter, page analyzer
      sidepanel/
      popup/
      options/           # non-sensitive UI prefs only
      lib/
        nativeClient.ts  # port mgmt, reconnect, request/response correlation
        fieldMatcher.ts  # rule engine + confidence scoring
        countryDetector.ts
        portalDetector.ts
        adapters/        # greenhouse.ts, lever.ts, generic.ts, workday.ts
      manifest.config.ts
    fixtures/            # saved real HTML pages for tests
    tests/
  helper/
    src/
      FireApply.Helper/          # WPF app: unlock, profile editor, tracker settings
      FireApply.Helper.Core/     # crypto, SQLite repo, Excel writer, file service
      FireApply.Helper.Host/     # native messaging stdio host (console app)
    tests/
  install/
    register-host.ps1    # writes registry key + host manifest JSON
  docs/
    prd.md
    protocol.md          # native messaging message schemas
```

Note: helper UI app and native messaging host are separate processes. Chrome
launches the Host on demand; Host talks to the same SQLite DB. Unlock state
shared via an in-memory key handed over a local named pipe from the UI app to
the Host (key never touches disk).

## 3. Native Messaging Protocol

- Transport: `chrome.runtime.connectNative` long-lived port (keeps MV3 SW alive while active).
- Envelope: `{ id, type, payload }` request / `{ id, ok, payload | error }` response.
- Message types (from PRD §27.3): `unlockStatus`, `getProfile`, `getCountryProfile`,
  `getResumeForCountry`, `getFileMetadata`, `getFileChunk`, `createApplicationRecord`,
  `updateApplicationStatus`, `saveAnswer`, `getSavedAnswers`, `exportBackup`.
- **File transfer**: helper→Chrome messages capped at 1MB. `getFileChunk` returns
  base64 chunks ≤512KB; extension reassembles into `File` object. No localhost server.
- SW restart recovery: workflow state snapshot in `chrome.storage.session`
  (non-sensitive: current step, application ID, portal type only). On SW wake,
  reconnect port and rehydrate.

## 4. File Upload Mechanism (critical path)

1. Extension requests file via chunked native messages.
2. Build `File` → `DataTransfer` → assign `input.files` → dispatch `change` + `input` events.
3. Validate: check portal shows filename / preview node appears.
4. On failure: highlight field, show local path from helper, wait for manual
   selection (`change` listener), continue.

This is Spike S1 — validate before building anything else on top of it.

## 5. Field Matching Engine

- Signal collection per field: label (for/wrapping/aria-labelledby), placeholder,
  name, id, aria-label, autocomplete attr, nearby text, section heading,
  dropdown/radio/checkbox option text, required marker.
- Confidence per PRD §20.2:
  - **High** (auto-fill): exact dictionary match, `autocomplete` attr, portal-adapter
    selector, or user-saved mapping.
  - **Medium** (fill + visually flag for review): synonym/keyword-group match.
  - **Low** (never auto-fill, ask user): ambiguous, multiple candidates, or any
    visa/legal/salary/declaration field without exact match.
- Saved-answer precedence when scopes conflict: **exact question > company > portal > country > global**.
- Question normalization for SavedAnswer matching: lowercase → strip punctuation
  and required-markers (`*`) → collapse whitespace → strip leading numbering.
- Keyword dictionaries as versioned JSON data files, not code.

## 6. Phases

### Phase 0 — Spikes (do first, ~2-3 days)

- **S1 File upload**: DataTransfer trick against live Greenhouse + Lever job posting.
  Go/no-go for automatic resume upload; fallback flow regardless.
- **S2 Native messaging round trip**: minimal host (echo + 1MB chunk test),
  registry registration script, pinned extension ID via `key` in manifest.
- **S3 SW lifetime**: confirm port keeps SW alive through a multi-page form; test
  kill/restart rehydration.
- **S4 Iframe reach**: content script with `all_frames: true` on a company page
  embedding Greenhouse iframe; confirm field access + parent/child messaging.

### Phase 1 — Secure Local Foundation (helper-heavy)

1. Helper Core: master password setup, PBKDF2/Argon2id KDF, AES-256-GCM field
   encryption, auto-lock timer.
2. SQLite schema: UserProfile, CountryProfile, ResumeProfile, SavedAnswer,
   ApplicationRecord (PRD §26).
3. WPF UI: unlock screen, profile editor, country profile editor (visa/salary
   per PRD §15-16), resume path manager (verify file exists, type, size).
4. Excel writer: ClosedXML upsert by Application ID, 25 columns (PRD §10.3),
   lock detection → queue table in SQLite → retry + manual "Retry Excel Sync".
5. Encrypted backup export/import (`.pja.enc`).
6. Native messaging Host process + named-pipe key handover from UI app.
7. `install/register-host.ps1`.

**Exit criteria**: unlock, edit profile, see Excel row written from a test message, restore backup.

### Phase 2 — Extension Shell + Page Analyzer

1. Extension scaffold: manifest (permissions: `activeTab`, `scripting`,
   `nativeMessaging`, `storage`, `sidePanel`; host permissions only for
   greenhouse.io / lever.co initially), popup, side panel.
2. `nativeClient.ts`: connect, reconnect, request correlation, unlock-status banner.
3. Portal detector (URL + DOM heuristics) and country detector (location text,
   title, URL TLD, structured data `JobPosting` JSON-LD when present; ambiguous → ask user).
4. Job extraction: title, company, location → `createApplicationRecord` → Excel row.
5. Resume selection: country mapping → show in side panel → user confirms.

**Exit criteria**: open a Greenhouse job, side panel shows portal/country/resume, Excel row appears.

### Phase 3 — Generic Form Assistant

1. Field scanner (incl. iframes; shadow-DOM piercing walker for later Workday).
2. Field matcher + confidence engine + dictionaries.
3. Filler: set value, dispatch `input`/`change`/`blur` (React/Vue-compatible
   native setter trick), verify value stuck.
4. Missing-info flow: highlight, side-panel question, save-scope choice (PRD §21.1),
   fill, continue.
5. Status updates → helper → Excel.

**Exit criteria**: on a generic form, known fields filled, unknowns prompted, answers saved and re-used on second visit.

### Phase 4 — File Upload Assistant

Productionize S1: chunked fetch, attach, validate, manual fallback flow,
sensitive-document approval gate (passport/visa never auto).

### Phase 5 — Portal Adapters + Workflow Engine

1. Workflow cycle (PRD §23): analyze → fill → prompt → wait for page change
   (MutationObserver + URL watch) → repeat; safety stops (PRD §24) as a
   blocking checklist evaluated before every fill pass.
2. Greenhouse adapter (selectors, custom questions, EEO section = always ask).
3. Lever adapter.
4. Login/signup pause flow with "Resume Assistant" button.
5. Workday basic assist: tenant detection, shadow-DOM traversal, per-step fill,
   pause on unknowns. Expect iteration; save mappings over time.
6. Duplicate detection: URL exact, company+title, ATS job ID.

**Exit criteria** = PRD §31 acceptance list.

### Phase 6 — Tracking Improvements

Follow-up reminders, dashboard in helper, CSV export, filters, Indeed/Naukri adapters.

## 7. Security Decisions

- Master password entered **only** in helper WPF window; extension never sees it.
- Key handover UI-app → Host via named pipe with per-session token; key held in
  memory only, zeroed on lock.
- Chrome storage: setup flags, UI prefs, session workflow snapshot — nothing sensitive.
- Sensitive docs (passport/visa/permit): per-application explicit approval dialog.
- Backup files AES-GCM encrypted with key derived from master password.
- Later: optional DPAPI wrap of the KDF salt/verifier (PRD §9.3).

## 8. Test Strategy

- Extension: Vitest + jsdom against `fixtures/` (saved real Greenhouse/Lever/
  Workday HTML). Every field-matcher rule change runs fixture suite —
  catches adapter breakage when portals redesign.
- Helper: xUnit for crypto round-trip, repo CRUD, Excel lock/queue/retry.
- Manual E2E checklist per portal before calling a phase done.
- Adapter health signal: if adapter fills < expected field count, side panel
  warns "portal may have changed".

## 9. Risks (carry-over from PRD §32 + new)

| Risk | Mitigation |
|---|---|
| DataTransfer upload rejected by some portals | S1 spike first; manual fallback always available |
| Native messaging 1MB limit | Chunked protocol (§3) |
| MV3 SW eviction mid-flow | Session snapshot + rehydrate (S3) |
| Workday shadow DOM / per-tenant variance | Basic assist only; piercing walker; saved mappings |
| Portal redesign breaks selectors | Fixture tests + fill-count health warning |
| Excel lock | SQLite queue + retry (Phase 1) |

## 10. Build Order Summary

S1→S4 spikes → Phase 1 (helper) → Phase 2 (shell+analyzer) → Phase 3 (form
assistant) → Phase 4 (upload) → Phase 5 (adapters+workflow) → Phase 6 (tracking).

Rough effort (solo, part-time): spikes 2-3 days; Phase 1 ~1-2 weeks; Phase 2 ~1 week;
Phase 3 ~1-2 weeks; Phase 4 ~2-4 days; Phase 5 ~2-3 weeks (Workday is the long tail);
Phase 6 incremental.
