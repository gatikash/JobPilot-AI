// Message contracts between content scripts, background, and UI pages.

import {
  ApplicationRecord, ApplicationStatus, FillReport, JobInfo, MissingField,
  AnswerScope,
} from "./types";

/** Data bundle the content script needs to fill a page. Sent by background. */
export interface FillContext {
  profileValues: Record<string, string>; // canonical field id -> value
  countryCode: string;
  savedAnswers: { questionNormalized: string; answer: string; rank: number }[];
  resume?: { name: string; fileName: string; mime: string; dataB64: string };
}

// content/UI -> background
export type BgRequest =
  | { type: "pageAnalyzed"; job: JobInfo }
  | { type: "getFillContext"; countryCode: string; portal: string; company: string }
  | { type: "fillReport"; applicationId: string; report: FillReport }
  | { type: "userAnswer"; applicationId: string; fieldId: string; question: string; answer: string; scope: AnswerScope; countryCode: string; portal: string; company: string }
  | { type: "statusUpdate"; applicationId: string; status: ApplicationStatus; note?: string }
  | { type: "getUnlockState" }
  | { type: "activity" } // resets auto-lock timer
  | { type: "startAssistOnActiveTab" }
  | { type: "getSidePanelModel" }
  | { type: "markSubmitted"; applicationId: string }
  | { type: "dismissField"; applicationId: string; fieldId: string; question: string }
  | { type: "setPendingAssist" };

// background -> content
export type ContentCommand =
  | { type: "startAssist" }
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
