// Shared data model. Mirrors PRD section 26 with extension-specific additions.

export interface UserProfile {
  firstName: string;
  middleName: string;
  lastName: string;
  fullName: string;
  email: string;
  alternateEmail: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  nationality: string;
  currentResidenceCountry: string;
  dateOfBirth: string;
  gender: string;
  // professional
  currentTitle: string;
  currentEmployer: string;
  totalExperience: string;
  relevantExperience: string;
  primarySkills: string;
  secondarySkills: string;
  currentSalary: string;
  // education
  highestDegree: string;
  degreeName: string;
  university: string;
  fieldOfStudy: string;
  graduationYear: string;
  gpa: string;
  // links
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  personalWebsite: string;
  otherProfileUrl: string;
  // free-form extras
  coverLetterText: string;
  updatedAt: number;
}

export interface CountryProfile {
  countryCode: string; // ISO-2, e.g. "SG"
  countryName: string;
  authorizedToWork: "yes" | "no" | "";
  needsSponsorship: "yes" | "no" | "";
  visaType: string;
  workPermitType: string;
  willingToRelocate: "yes" | "no" | "";
  noticePeriod: string;
  expectedSalary: string;
  salaryCurrency: string;
  salaryAnswerFormat:
    | "exact-annual"
    | "exact-monthly"
    | "range"
    | "negotiable"
    | "ask"
    | "";
  preferredCities: string;
  remotePreference: "yes" | "no" | "";
  notes: string;
  updatedAt: number;
}

export interface ResumeMeta {
  id: string;
  name: string;
  fileName: string;
  fileType: string; // mime
  size: number;
  countryCodes: string[]; // mapped countries; empty = fallback/general
  role: string;
  isDefault: boolean;
  /** plain text extracted from the PDF (or pasted by the user) for AI matching */
  extractedText: string;
  updatedAt: number;
}

export type AnswerScope = "once" | "global" | "country" | "portal" | "company" | "exact";

export interface SavedAnswer {
  id: string;
  questionRaw: string;
  questionNormalized: string;
  answer: string;
  scope: Exclude<AnswerScope, "once">;
  countryCode?: string;
  portal?: string;
  company?: string;
  updatedAt: number;
}

export type ApplicationStatus =
  | "Viewed"
  | "Saved"
  | "Applied"
  | "Shortlisted"
  | "Interview Scheduled"
  | "Rejected"
  | "Offer"
  | "Started"
  | "Login Required"
  | "Waiting for User"
  | "Missing Information"
  | "Filled"
  | "Ready for Next"
  | "Ready for Review"
  | "Ready for Submit"
  | "Submitted Manually"
  | "Failed"
  | "Skipped"
  | "Duplicate Found";

export interface ApplicationRecord {
  id: string;
  jobTitle: string;
  company: string;
  jobCountry: string;
  jobLocation: string;
  portal: string;
  jobUrl: string;
  status: ApplicationStatus;
  currentStep: string;
  resumeUsed: string;
  missingFields: string;
  duplicateWarning: boolean;
  errorNotes: string;
  submittedManually: boolean;
  submissionDate: string;
  followUpDate: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export type Portal =
  | "greenhouse"
  | "lever"
  | "workday"
  | "indeed"
  | "naukri"
  | "linkedin"
  | "generic";

export interface JobInfo {
  title: string;
  company: string;
  location: string;
  /** public job-page applicant count when the portal exposes it */
  applicants?: string;
  countryCode: string; // "" when undetected
  portal: Portal;
  url: string;
  /** job description text (truncated), used for AI matching */
  description?: string;
}

// ---- AI matching ----

export type AiProvider = "openrouter" | "openai" | "anthropic" | "custom";

export interface AiConfig {
  enabled: boolean;
  autoMatch: boolean;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  updatedAt: number;
}

export function defaultAiConfig(): AiConfig {
  return {
    enabled: false,
    autoMatch: true,
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    model: "google/gemini-2.0-flash-lite-001",
    updatedAt: 0,
  };
}

export const AI_PROVIDER_PRESETS: Record<AiProvider, { baseUrl: string; modelHint: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", modelHint: "google/gemini-2.0-flash-lite-001" },
  openai: { baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com", modelHint: "claude-haiku-4-5-20251001" },
  custom: { baseUrl: "", modelHint: "model-name" },
};

export interface ProfileMatch {
  name: string;      // resume/profile name
  percent: number;   // 0-100
  reason: string;    // one-line explanation
}

export interface MatchResult {
  jobUrl: string;
  overall: number;             // 0-100
  profiles: ProfileMatch[];
  missingKeywords: string[];
  recommendedResume: string;
  source: "ai" | "local";      // local = keyword estimate fallback
  model?: string;
  error?: string;
  createdAt: number;
}

export interface DraftAnswerResult {
  question: string;
  answer: string;
  source: "ai" | "local";
  model?: string;
  error?: string;
  createdAt: number;
}

export interface ResumeTailoringResult {
  jobUrl: string;
  resumeName: string;
  summary: string;
  keywordsToAdd: string[];
  suggestedBullets: string[];
  notes: string[];
  source: "ai" | "local";
  model?: string;
  error?: string;
  createdAt: number;
}

export type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "date";

export type Confidence = "high" | "medium" | "low";

/** A field found on the page that we could not fill and need the user for. */
export interface MissingField {
  fieldId: string; // content-script-assigned id
  question: string;
  kind: FieldKind;
  options?: string[]; // for select / radio
  required: boolean;
}

export interface FillReport {
  filled: { fieldId: string; question: string; value: string; confidence: Confidence }[];
  missing: MissingField[];
  warnings: string[];
  resumeAttached: boolean;
}

export interface LikelyAppliedSignal {
  reason: string;
  url: string;
  detectedAt: number;
}

/** Non-sensitive workflow snapshot kept in chrome.storage.session. */
export interface SessionState {
  applicationId?: string;
  tabId?: number;
  portal?: Portal;
}

export const COUNTRIES: { code: string; name: string; currency: string; keywords: string[] }[] = [
  { code: "IN", name: "India", currency: "INR", keywords: ["india", "bengaluru", "bangalore", "mumbai", "pune", "hyderabad", "chennai", "gurgaon", "gurugram", "noida", "delhi"] },
  { code: "SG", name: "Singapore", currency: "SGD", keywords: ["singapore", ", sg"] },
  { code: "DE", name: "Germany", currency: "EUR", keywords: ["germany", "deutschland", "berlin", "munich", "münchen", "frankfurt", "hamburg", "cologne", "stuttgart"] },
  { code: "AE", name: "United Arab Emirates", currency: "AED", keywords: ["united arab emirates", "uae", "dubai", "abu dhabi", "sharjah"] },
  { code: "IE", name: "Ireland", currency: "EUR", keywords: ["ireland", "dublin", "cork", "galway"] },
  { code: "GB", name: "United Kingdom", currency: "GBP", keywords: ["united kingdom", "england", "scotland", "london", "manchester", "edinburgh", ", uk"] },
  { code: "CA", name: "Canada", currency: "CAD", keywords: ["canada", "toronto", "vancouver", "montreal", "ottawa", "calgary"] },
  { code: "US", name: "United States", currency: "USD", keywords: ["united states", "usa", "u.s.", "new york", "california", "san francisco", "seattle", "austin", "boston", "chicago", "remote - us", "remote, us"] },
  { code: "AU", name: "Australia", currency: "AUD", keywords: ["australia", "sydney", "melbourne", "brisbane", "perth"] },
  { code: "NL", name: "Netherlands", currency: "EUR", keywords: ["netherlands", "amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"] },
];

export function emptyProfile(): UserProfile {
  return {
    firstName: "", middleName: "", lastName: "", fullName: "", email: "",
    alternateEmail: "", phone: "", whatsapp: "", address: "", city: "",
    state: "", country: "", postalCode: "", nationality: "",
    currentResidenceCountry: "", dateOfBirth: "", gender: "",
    currentTitle: "", currentEmployer: "", totalExperience: "",
    relevantExperience: "", primarySkills: "", secondarySkills: "",
    currentSalary: "",
    highestDegree: "", degreeName: "", university: "", fieldOfStudy: "",
    graduationYear: "", gpa: "",
    linkedinUrl: "", githubUrl: "", portfolioUrl: "", personalWebsite: "",
    otherProfileUrl: "", coverLetterText: "",
    updatedAt: 0,
  };
}

export function emptyCountryProfile(code: string, name: string, currency: string): CountryProfile {
  return {
    countryCode: code, countryName: name,
    authorizedToWork: "", needsSponsorship: "", visaType: "", workPermitType: "",
    willingToRelocate: "", noticePeriod: "", expectedSalary: "",
    salaryCurrency: currency, salaryAnswerFormat: "", preferredCities: "",
    remotePreference: "", notes: "", updatedAt: 0,
  };
}
