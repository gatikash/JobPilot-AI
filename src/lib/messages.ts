// Message contracts between content scripts, background, and UI pages.

import {
  ApplicationRecord, ApplicationStatus, DraftAnswerResult, FillReport, JobInfo,
  LikelyAppliedSignal, MatchResult, MissingField, AnswerScope, ResumeTailoringResult,
  WorkExperienceEntry,
} from "./types";

/** Data bundle the content script needs to fill a page. Sent by background. */
export interface FillContext {
  profileValues: Record<string, string>; // canonical field id -> value
  countryCode: string;
  savedAnswers: { questionNormalized: string; answer: string; rank: number }[];
  resume?: { name: string; fileName: string; mime: string; dataB64: string };
  workExperience: WorkExperienceEntry[];
}

// content/UI -> background
export type BgRequest =
  | { type: "pageAnalyzed"; job: JobInfo }
  /** SPA navigation started; jobChanged = URL clearly points at another job */
  | { type: "pageChanging"; jobChanged?: boolean }
  | { type: "getFillContext"; countryCode: string; portal: string; company: string }
  | { type: "fillReport"; applicationId: string; report: FillReport }
  | { type: "likelyApplied"; signal: LikelyAppliedSignal }
  | { type: "userAnswer"; applicationId: string; fieldId: string; question: string; answer: string; scope: AnswerScope; countryCode: string; portal: string; company: string }
  | { type: "statusUpdate"; applicationId: string; status: ApplicationStatus; note?: string }
  | { type: "getUnlockState" }
  | { type: "activity" } // resets auto-lock timer
  | { type: "startAssistOnActiveTab" }
  /** analyze the active job and run matching/tailoring without filling form fields */
  | { type: "analyzeActiveJob" }
  /** force a fresh analysis of the active tab against its current URL
   * (used when the side panel is opened so it never shows a stale job) */
  | { type: "resyncActiveTab" }
  | { type: "getSidePanelModel" }
  | { type: "markSubmitted"; applicationId?: string }
  | { type: "dismissField"; applicationId: string; fieldId: string; question: string }
  | { type: "setPendingAssist" }
  /** run job-vs-profile matching; auto (from content) or forced (side panel button) */
  | { type: "requestMatch"; force?: boolean }
  /** generate an editable answer draft for a missing application question */
  | { type: "draftAnswer"; applicationId: string; question: string }
  /** generate resume tailoring suggestions for the active job/resume */
  | { type: "requestTailoring"; force?: boolean }
  /** save/bookmark the active job without starting a fill pass */
  | { type: "saveJobForLater" }
  /** content script asks whether the side panel is currently open;
   * used to gate automatic re-fills on modal mutations */
  | { type: "isSidePanelOpen" };

// background -> content
export type ContentCommand =
  | { type: "startAssist" }
  | { type: "analyzePage" }
  /** return the page's visible text for AI-based job extraction */
  | { type: "getPageText" }
  | { type: "fillWithContext"; applicationId: string; ctx: FillContext }
  | { type: "fillSingleField"; fieldId: string; answer: string }
  | { type: "unhighlightField"; fieldId: string }
  | { type: "resumeAssist" };

/** Model for the side panel UI, assembled by background. */
export interface SidePanelModel {
  unlocked: boolean;
  job?: JobInfo;
  application?: ApplicationRecord;
  resumeName?: string;
  report?: FillReport;
  missing: MissingField[];
  duplicateOf?: { company: string; jobTitle: string; createdAt: number };
  match?: MatchResult;
  matchPending?: boolean;
  tailoring?: ResumeTailoringResult;
  tailoringPending?: boolean;
  lastDraft?: DraftAnswerResult;
  likelyApplied?: LikelyAppliedSignal;
  aiConfigured?: boolean;
  /** page navigated; a fresh job analysis has not arrived yet */
  analyzing?: boolean;
}

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/\s*\*\s*$/g, "")          // trailing required marker
    .replace(/^\s*\d+[.)]\s*/g, "")     // leading numbering
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // punctuation
    .replace(/\s+/g, " ")
    .trim();
}
