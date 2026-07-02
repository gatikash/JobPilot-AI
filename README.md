# 🔥 FireApply — Personal Job Application Assistant

A private Chrome extension (Manifest V3) that speeds up job applications:
it reads the job page, detects the country, picks your country-specific resume,
fills known fields from your locally encrypted profile, and asks you for
anything missing. **No AI, no cloud, no auto-submit** — you always click
Next/Submit yourself.

## Features

- **Country-aware**: detects the job's country and uses that country's resume,
  salary expectation, notice period, and visa/sponsorship answers.
- **10 country profiles built in**: India, Singapore, Germany, UAE, Ireland,
  UK, Canada, USA, Australia, Netherlands.
- **Encrypted local vault**: everything (profile, resumes, saved answers,
  history) is AES-256-GCM encrypted in the extension's own storage, protected
  by a master password. Nothing ever leaves your machine.
- **Resume auto-attach**: uploads the right resume into the form's file field
  where the portal allows it, with manual fallback guidance when it doesn't.
- **Missing-field Q&A**: anything it can't fill safely appears in the side
  panel; your answers can be remembered (per exact question, company, portal,
  country, or globally) and are reused on future applications. Dismiss any
  question with ✕ if you'd rather handle it yourself.
- **Login-aware**: pauses on login pages, lets you (and Chrome's password
  manager) handle credentials, then automatically resumes filling after login.
- **Safety first**: never clicks buttons, never submits, stops on CAPTCHA/OTP,
  and never auto-answers visa, legal, or equal-opportunity questions without
  your explicit saved answer.
- **Application tracker**: local history with statuses, duplicate-application
  warnings, and one-click export to an Excel (.xlsx) tracker.
- **Encrypted backups**: export/import your whole setup as a password-protected
  file.

Supported portals: **Greenhouse, Lever, Workday (basic assist), and generic
company career pages**. LinkedIn is intentionally not supported.

---

## Setup — step by step

### 1. Prerequisites

| Requirement | Notes |
|---|---|
| Google Chrome 114+ | Edge/Brave also work (Chromium-based) |
| Node.js 18+ and npm | Only needed to build once — [download here](https://nodejs.org) |
| Git | To clone this repository |

Check your versions:

```bash
node --version   # should print v18 or higher
npm --version
```

### 2. Clone and build

```bash
git clone https://github.com/gatikash/FireApply.git
cd FireApply
npm install
npm run build
```

This creates a `dist/` folder — that folder **is** the extension.

### 3. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `dist/` folder inside the cloned repository
5. The 🔥 FireApply icon appears in your toolbar (pin it via the puzzle-piece
   menu for quick access)

### 4. First-time configuration

1. **Create your vault** — click the FireApply icon and set a master password
   (minimum 8 characters).
   ⚠️ *There is no password recovery. If you forget it, your stored data is
   unrecoverable and you must start over.*
2. The settings page opens automatically. Work through the tabs:
   - **Profile** — name, contact details, address, experience, education,
     LinkedIn/GitHub links, and an optional default cover letter. Hover the
     ⓘ icon next to any field to see why job portals ask for it.
   - **Countries & Visa** — for each country you apply to, set: are you
     authorized to work there, do you need sponsorship, notice period,
     expected salary + currency, and relocation preference. *FireApply never
     guesses visa answers — anything you leave blank becomes a question in
     the side panel instead.*
   - **Resumes** — upload one or more resumes (PDF/DOCX) and map each to
     countries (e.g. "Germany Resume" → Germany; one general resume as the
     default fallback). Files are stored encrypted inside the extension.
3. Done. Settings can be changed any time via the popup → **Profile & settings**.

### 5. Applying to a job

1. Open a job posting (Greenhouse, Lever, Workday, or any company career page).
2. Click the FireApply icon → **Start Assist on this page**.
3. The side panel opens showing: detected job, company, country, chosen
   resume, and live status.
4. FireApply fills what it knows:
   - 🟢 green outline = filled with high confidence
   - 🟡 amber outline = filled, worth a glance
   - 🔴 red outline = needs your input (listed in the side panel)
5. Answer the "Needs your input" questions in the side panel (or dismiss with
   ✕). Choose how each answer is remembered for next time.
6. If a login page appears: log in yourself (let Chrome save the password) —
   FireApply resumes filling automatically after login.
7. Review the page, then click **Next / Submit yourself** — the extension
   never does this for you.
8. After submitting, click **Mark submitted** in the side panel to log it.
9. Moving to another form step? Click **Scan & fill this page** to fill the
   new step.

### 6. Tracking and backups

- **History tab** (settings page): every application with its status.
- **Export Excel tracker**: downloads `ApplicationTracker-<date>.xlsx`.
- **Backup & Settings tab**: export an encrypted `.pja` backup file; restore
  it on a new machine with the same master password. Also set the auto-lock
  timeout here.

---

## Updating

```bash
git pull
npm install
npm run build
```

Then go to `chrome://extensions` and click the ↻ reload icon on FireApply.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach the page" when starting assist | Reload the browser tab, then click Start Assist again |
| Fields fill but vanish immediately | The site's framework rejected the value — enter that field manually |
| Resume didn't attach | Some portals block programmatic uploads; FireApply highlights the field and shows which file to pick manually |
| Country shows "Not detected" | Use the side panel — country-specific questions will be asked instead of auto-filled |
| Vault locked unexpectedly | Auto-lock kicked in — unlock via the popup; adjust the timeout in Backup & Settings |
| Extension stopped working after `git pull` | Rebuild (`npm run build`) and reload the extension |

## Security model

- Master password → PBKDF2-SHA256 (310k iterations) → AES-256-GCM key.
- All data encrypted at rest in the extension's IndexedDB; the key lives only
  in session memory and is wiped when Chrome closes or the vault auto-locks.
- Content scripts can never read the vault key or the database directly.
- No network calls, no analytics, no cloud — everything is local.
- The extension never reads Chrome's saved passwords, never fills password
  fields, never bypasses CAPTCHA/OTP, and never submits an application.

## Development

```text
src/
  background/   service worker: message router, tracking, fill-context, auto-resume
  content/      page analyzer, field scanner/filler (runs in all frames)
  lib/          crypto, IndexedDB, field matcher, detectors, tooltips, message types
  popup/        vault unlock + assist trigger
  sidepanel/    live assistant view + missing-field Q&A
  options/      profile, countries, resumes, answers, history, backup
```

- `npm run build` — bundle to `dist/` (esbuild)
- `npm run typecheck` — TypeScript strict check
- `npm run icons` — regenerate icons

## Disclaimer

Personal-use tool. Always review every field before submitting an
application — you are responsible for the accuracy of what you submit.
Respect each job portal's terms of service.
