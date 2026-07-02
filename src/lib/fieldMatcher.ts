// Rule-based field matching with confidence levels (PRD section 20).
// A field's collected signals (label, placeholder, name, id, aria, nearby
// text) are matched against keyword dictionaries. Sensitive categories
// (visa, legal, salary, EEO) are never auto-filled on partial matches.

import { Confidence } from "./types";

export interface FieldSignals {
  label: string;
  placeholder: string;
  name: string;
  id: string;
  aria: string;
  nearby: string;
  autocomplete: string;
}

export interface MatchResult {
  key: string;        // canonical field key into FillContext.profileValues
  confidence: Confidence;
  sensitive: boolean;
}

interface Rule {
  key: string;
  /** exact phrases: any equal (normalized) label/aria -> high confidence */
  exact: string[];
  /** keyword groups: all words in a group must appear in combined signals -> medium */
  groups: string[][];
  /** HTML autocomplete tokens giving high confidence */
  autocomplete?: string[];
  sensitive?: boolean;
}

const RULES: Rule[] = [
  { key: "firstName", exact: ["first name", "given name", "forename", "vorname"], groups: [["first", "name"]], autocomplete: ["given-name"] },
  { key: "middleName", exact: ["middle name"], groups: [["middle", "name"]], autocomplete: ["additional-name"] },
  { key: "lastName", exact: ["last name", "surname", "family name", "nachname"], groups: [["last", "name"], ["family", "name"]], autocomplete: ["family-name"] },
  { key: "fullName", exact: ["full name", "name", "your name", "complete name"], groups: [["full", "name"]], autocomplete: ["name"] },
  { key: "email", exact: ["email", "email address", "e mail", "e mail address", "work email"], groups: [["email"]], autocomplete: ["email"] },
  { key: "phone", exact: ["phone", "phone number", "mobile", "mobile number", "telephone", "contact number", "cell phone"], groups: [["phone"], ["mobile"]], autocomplete: ["tel", "tel-national"] },
  { key: "address", exact: ["address", "street address", "address line 1", "current address"], groups: [["street", "address"]], autocomplete: ["street-address", "address-line1"] },
  { key: "city", exact: ["city", "town", "current city"], groups: [["city"]], autocomplete: ["address-level2"] },
  { key: "state", exact: ["state", "province", "region", "state province"], groups: [["state"], ["province"]], autocomplete: ["address-level1"] },
  { key: "postalCode", exact: ["postal code", "zip", "zip code", "zip postal code", "pincode", "pin code", "postcode"], groups: [["postal"], ["zip"]], autocomplete: ["postal-code"] },
  { key: "country", exact: ["country", "country region", "country of residence", "current location country"], groups: [["country"]], autocomplete: ["country", "country-name"] },
  { key: "nationality", exact: ["nationality", "citizenship"], groups: [["nationality"], ["citizenship"]] },
  { key: "dateOfBirth", exact: ["date of birth", "birth date", "dob"], groups: [["birth", "date"]], autocomplete: ["bday"], sensitive: true },
  { key: "gender", exact: ["gender", "sex"], groups: [], sensitive: true },
  { key: "linkedinUrl", exact: ["linkedin", "linkedin profile", "linkedin url", "linkedin profile url"], groups: [["linkedin"]] },
  { key: "githubUrl", exact: ["github", "github url", "github profile"], groups: [["github"]] },
  { key: "portfolioUrl", exact: ["portfolio", "portfolio url", "portfolio website", "work samples"], groups: [["portfolio"]] },
  { key: "personalWebsite", exact: ["website", "personal website", "web site", "other website", "blog"], groups: [["personal", "website"]], autocomplete: ["url"] },
  { key: "currentTitle", exact: ["current title", "current job title", "job title", "current role", "current position", "designation"], groups: [["current", "title"], ["current", "role"], ["designation"]], autocomplete: ["organization-title"] },
  { key: "currentEmployer", exact: ["current company", "current employer", "company", "employer", "current organization", "organization"], groups: [["current", "company"], ["current", "employer"]], autocomplete: ["organization"] },
  { key: "totalExperience", exact: ["total experience", "years of experience", "experience in years", "total years of experience", "work experience years"], groups: [["years", "experience"]] },
  { key: "relevantExperience", exact: ["relevant experience", "relevant years of experience"], groups: [["relevant", "experience"]] },
  { key: "primarySkills", exact: ["skills", "primary skills", "key skills", "technical skills"], groups: [["skills"]] },
  { key: "highestDegree", exact: ["highest degree", "highest education", "education level", "highest qualification"], groups: [["highest", "degree"], ["highest", "education"]] },
  { key: "university", exact: ["university", "school", "college", "institution", "school name"], groups: [["university"], ["college"]] },
  { key: "fieldOfStudy", exact: ["field of study", "major", "discipline", "specialization"], groups: [["field", "study"], ["major"]] },
  { key: "graduationYear", exact: ["graduation year", "year of graduation", "end year"], groups: [["graduation", "year"]] },
  { key: "gpa", exact: ["gpa", "grade point average", "percentage", "cgpa"], groups: [["gpa"], ["cgpa"]] },
  { key: "coverLetterText", exact: ["cover letter", "covering letter", "why do you want to work here", "message to hiring team"], groups: [["cover", "letter"]] },
  // country-profile driven (sensitive category: never medium-confidence fill)
  { key: "noticePeriod", exact: ["notice period", "notice period in days", "current notice period", "when can you start", "earliest start date", "availability to start"], groups: [["notice", "period"]], sensitive: true },
  { key: "expectedSalary", exact: ["expected salary", "salary expectation", "salary expectations", "expected ctc", "expected compensation", "desired salary", "expected annual salary", "salary requirements"], groups: [["expected", "salary"], ["desired", "salary"], ["salary", "expectation"], ["expected", "ctc"]], sensitive: true },
  { key: "currentSalary", exact: ["current salary", "current ctc", "current compensation", "current annual salary"], groups: [["current", "salary"], ["current", "ctc"]], sensitive: true },
  { key: "authorizedToWork", exact: [
      "are you legally authorized to work in this country",
      "are you authorized to work",
      "are you legally authorized to work",
      "do you have the right to work",
      "work authorization",
      "are you eligible to work in this country",
    ], groups: [["authorized", "work"], ["right", "work"], ["eligible", "work"]], sensitive: true },
  { key: "needsSponsorship", exact: [
      "do you require sponsorship",
      "will you require sponsorship",
      "do you now or in the future require sponsorship",
      "do you require visa sponsorship",
      "will you now or in the future require sponsorship for employment visa status",
      "visa sponsorship",
    ], groups: [["require", "sponsorship"], ["need", "sponsorship"], ["visa", "sponsorship"]], sensitive: true },
  { key: "willingToRelocate", exact: ["are you willing to relocate", "willing to relocate", "open to relocation"], groups: [["willing", "relocate"], ["open", "relocation"]], sensitive: true },
  { key: "visaType", exact: ["visa type", "current visa status", "visa status", "immigration status"], groups: [["visa", "status"]], sensitive: true },
];

// Fields whose questions are legal/EEO territory - never auto-answer at all
// unless there is an exact user-saved answer (handled by savedAnswer path).
const EEO_MARKERS = [
  "race", "ethnicity", "veteran", "disability", "protected veteran",
  "criminal", "conviction", "background check", "equal opportunity",
  "religion", "sexual orientation",
];

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\*\s*$/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word phrase containment: "city" is not inside "electricity". */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (!haystack || !phrase) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

export function isEeoQuestion(signalsText: string): boolean {
  const t = normalize(signalsText);
  return EEO_MARKERS.some((m) => t.includes(m));
}

export function matchField(signals: FieldSignals): MatchResult | null {
  const label = normalize(signals.label);
  const aria = normalize(signals.aria);
  const placeholder = normalize(signals.placeholder);
  const nameId = normalize(`${signals.name} ${signals.id}`.replace(/[_\-.[\]]/g, " "));
  const combined = normalize(
    `${signals.label} ${signals.placeholder} ${signals.name} ${signals.id} ${signals.aria} ${signals.nearby}`
      .replace(/[_\-.[\]]/g, " "));

  if (isEeoQuestion(combined)) return null;

  const ac = signals.autocomplete.toLowerCase().trim();

  let best: MatchResult | null = null;
  for (const rule of RULES) {
    // high: autocomplete token
    if (ac && rule.autocomplete?.includes(ac)) {
      return { key: rule.key, confidence: "high", sensitive: !!rule.sensitive };
    }
    // high: exact label/aria/placeholder match
    if (rule.exact.some((e) => label === e || aria === e || placeholder === e)) {
      return { key: rule.key, confidence: "high", sensitive: !!rule.sensitive };
    }
    // high: exact phrase appears in name/id (portals often use e.g. first_name)
    if (rule.exact.some((e) => e.split(" ").length > 1 && containsPhrase(nameId, e))) {
      return { key: rule.key, confidence: "high", sensitive: !!rule.sensitive };
    }
    // medium: label contains an exact phrase as whole words
    // ("Your first name" matches; "electricity" must NOT match "city")
    if (!best && rule.exact.some((e) => containsPhrase(label, e) || containsPhrase(aria, e))) {
      best = { key: rule.key, confidence: "medium", sensitive: !!rule.sensitive };
      continue;
    }
    // medium: keyword group hit across all signals (whole words only, so
    // "city" never matches "electricity" or "capacity")
    if (!best) {
      const words = new Set(combined.split(" "));
      if (rule.groups.some((g) => g.every((w) => words.has(w)))) {
        best = { key: rule.key, confidence: "medium", sensitive: !!rule.sensitive };
      }
    }
  }
  return best;
}

/**
 * Pick the best <select>/radio option for a value. Whole-word comparison so
 * "India" never selects "Indiana". Returns the option index or -1.
 */
export function pickOption(options: string[], value: string): number {
  const target = normalize(value);
  if (!target) return -1;
  // pass 1: exact match
  for (let i = 0; i < options.length; i++) {
    if (normalize(options[i]) === target) return i;
  }
  // pass 2: whole-word subset in either direction
  // ("United States" matches "United States of America";
  //  "Yes" matches "Yes, I am authorized")
  const targetWords = target.split(" ");
  const targetSet = new Set(targetWords);
  for (let i = 0; i < options.length; i++) {
    const o = normalize(options[i]);
    if (!o) continue;
    const optionWords = o.split(" ");
    const optionSet = new Set(optionWords);
    const targetInOption = targetWords.every((w) => optionSet.has(w));
    const optionInTarget = optionWords.every((w) => targetSet.has(w));
    if (targetInOption || optionInTarget) return i;
  }
  return -1;
}

/**
 * Validate that a value is sane for the input it is about to enter.
 * Blocks nonsense like text in number fields or a name in an email field.
 */
export function valueFits(value: string, inputType: string, maxLength = -1): boolean {
  if (maxLength > 0 && value.length > maxLength) return false;
  switch (inputType) {
    case "email": return /^\S+@\S+\.\S+$/.test(value);
    case "tel": return /^[+()\d][\d\s\-().]{5,19}$/.test(value.trim());
    case "url": return /^https?:\/\/\S+$/i.test(value.trim());
    case "number": return /^-?\d+([.,]\d+)?$/.test(value.trim());
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    case "week": case "month": case "time": return false; // never guess these
    default: return true;
  }
}

/** True when this input looks like a resume upload field. */
export function isResumeUpload(signals: FieldSignals): boolean {
  const t = normalize(
    `${signals.label} ${signals.name} ${signals.id} ${signals.aria} ${signals.nearby}`);
  if (t.includes("cover letter")) return false;
  return t.includes("resume") || t.includes("cv") || t.includes("curriculum vitae");
}
