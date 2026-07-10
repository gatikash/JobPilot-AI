// Job-vs-profile matching. Two engines:
// 1. localMatch  - instant keyword-overlap estimate, offline, free.
// 2. aiMatch     - calls the user's own AI endpoint (OpenAI-compatible or
//                  Anthropic) with a strict-JSON scoring prompt.
// Both return the same MatchResult shape so the UI doesn't care which ran.

import {
  AiConfig, DraftAnswerResult, MatchResult, ProfileMatch, ResumeTailoringResult,
} from "./types";

export interface MatchProfile {
  name: string;
  text: string; // extracted resume text / skills summary
}

const MAX_JD_CHARS = 7000;
const MAX_PROFILE_CHARS = 3500;
const REQUEST_TIMEOUT_MS = 60_000;

type ChatMessage = { role: "system" | "user"; content: string };
type JsonObject = Record<string, unknown>;

// ---------- local keyword estimate ----------

const STOPWORDS = new Set(
  ("the and for with you your will are our this that have has from can able to of in on a an as at be is or by we " +
   "they it their who what all more than other into out up work team job role company us new using use used skills " +
   "experience years responsibilities requirements qualifications about")
    .split(" "),
);

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}+#.]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function localMatch(
  jobUrl: string, jobText: string, profiles: MatchProfile[],
): MatchResult {
  const jd = tokens(jobText.slice(0, MAX_JD_CHARS));
  const results: ProfileMatch[] = profiles.map((p) => {
    const pt = tokens(p.text.slice(0, MAX_PROFILE_CHARS));
    if (pt.size === 0 || jd.size === 0) {
      return { name: p.name, percent: 0, reason: "No text to compare." };
    }
    let hits = 0;
    for (const w of jd) if (pt.has(w)) hits++;
    // overlap relative to JD vocabulary, scaled to a friendlier range
    const percent = Math.min(95, Math.round((hits / jd.size) * 220));
    return { name: p.name, percent, reason: `${hits} matching terms (keyword estimate).` };
  });
  results.sort((a, b) => b.percent - a.percent);
  const best = results[0];
  return {
    jobUrl,
    overall: best?.percent ?? 0,
    profiles: results,
    missingKeywords: [],
    recommendedResume: best && best.percent > 0 ? best.name : "",
    source: "local",
    createdAt: Date.now(),
  };
}

// ---------- AI match ----------

function buildPrompt(jobText: string, profiles: MatchProfile[]): string {
  const profilesJson = profiles.map((p) => ({
    name: p.name,
    text: p.text.slice(0, MAX_PROFILE_CHARS),
  }));
  return [
    "You are a strict job-fit scorer. Compare the JOB DESCRIPTION against each CANDIDATE PROFILE.",
    "Score how well each profile's skills and experience match the job's requirements (0-100).",
    "Be realistic: 80+ only for strong direct matches, 40-60 for partial/transferable matches, below 30 for weak fits.",
    "",
    "Respond with ONLY valid JSON, no markdown fences, exactly this shape:",
    '{"overall": <0-100 best profile score>, "profiles": [{"name": "<profile name>", "percent": <0-100>, "reason": "<one short sentence>"}], "missingKeywords": ["<up to 8 important job requirements missing from the best profile>"], "recommendedResume": "<name of best profile, or empty string if all are poor fits>"}',
    "",
    "JOB DESCRIPTION:",
    jobText.slice(0, MAX_JD_CHARS),
    "",
    "CANDIDATE PROFILES:",
    JSON.stringify(profilesJson),
  ].join("\n");
}

function buildMessages(jobText: string, profiles: MatchProfile[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: "You score job fit. Return only valid JSON, with no markdown or explanatory prose.",
    },
    { role: "user", content: buildPrompt(jobText, profiles) },
  ];
}

function parseModelJson(raw: string): {
  overall: number;
  profiles: ProfileMatch[];
  missingKeywords: string[];
  recommendedResume: string;
} {
  // strip markdown fences / surrounding prose if a model misbehaves
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return JSON.");
  const data = JSON.parse(raw.slice(start, end + 1));
  const clamp = (n: unknown): number =>
    Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  return {
    overall: clamp(data.overall),
    profiles: Array.isArray(data.profiles)
      ? data.profiles.map((p: Record<string, unknown>) => ({
          name: String(p.name ?? ""),
          percent: clamp(p.percent),
          reason: String(p.reason ?? "").slice(0, 200),
        }))
      : [],
    missingKeywords: Array.isArray(data.missingKeywords)
      ? data.missingKeywords.slice(0, 8).map((k: unknown) => String(k).slice(0, 60))
      : [],
    recommendedResume: String(data.recommendedResume ?? ""),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return JSON.");
  const data = JSON.parse(raw.slice(start, end + 1));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Model JSON was not an object.");
  }
  return data as Record<string, unknown>;
}

function appendPath(base: URL, suffix: string): string {
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}${suffix}`;
  return base.toString();
}

// Fixed OpenAI-compatible endpoint per https://ai.google.dev/gemini-api/docs/openai
const GOOGLE_CHAT_COMPLETIONS_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GOOGLE_DEFAULT_MODEL = "gemini-3.1-flash-lite";

function chatCompletionsUrl(cfg: AiConfig): string {
  // Google's endpoint is documented and fixed; only the API key is needed.
  if (cfg.provider === "google") return GOOGLE_CHAT_COMPLETIONS_URL;

  const raw = cfg.baseUrl.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("AI base URL is empty.");

  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return url.toString();

  // Make common user input forgiving: "https://openrouter.ai" is enough.
  if (cfg.provider === "openrouter" && url.origin === "https://openrouter.ai" && !path.includes("/api/v1")) {
    return appendPath(url, "/api/v1/chat/completions");
  }

  // Likewise, allow "https://api.openai.com" in addition to ".../v1".
  if (cfg.provider === "openai" && url.origin === "https://api.openai.com" && path === "") {
    return appendPath(url, "/v1/chat/completions");
  }

  return appendPath(url, "/chat/completions");
}

function anthropicMessagesUrl(cfg: AiConfig): string {
  const raw = cfg.baseUrl.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("AI base URL is empty.");

  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/messages")) return url.toString();
  if (url.origin === "https://api.anthropic.com" && path === "") {
    return appendPath(url, "/v1/messages");
  }
  return appendPath(url, "/v1/messages");
}

function openAiCompatibleHeaders(cfg: AiConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/gatikash/FireApply";
    headers["X-OpenRouter-Title"] = "JobPilot AI";
  }
  return headers;
}

async function postJson(url: string, headers: Record<string, string>, body: JsonObject): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${errorMessage(text)}`);
    }
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("API request timed out.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(body: string): string {
  if (!body) return "empty error response";
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? body;
    return String(msg).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function extractChatText(data: unknown): string {
  const root = data as { choices?: unknown[] };
  const choice = root.choices?.[0] as { message?: { content?: unknown; refusal?: unknown }; text?: unknown } | undefined;
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { text?: unknown; content?: unknown };
          return typeof p.text === "string" ? p.text : typeof p.content === "string" ? p.content : "";
        }
        return "";
      })
      .join("");
    if (text) return text;
  }
  if (typeof choice?.text === "string") return choice.text;
  if (choice?.message?.refusal) throw new Error(`Model refused: ${String(choice.message.refusal).slice(0, 200)}`);
  throw new Error("Unexpected API response shape.");
}

function shouldRetryWithoutStrictJson(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /\b(response_format|json|schema|max_completion_tokens|reasoning_effort|temperature)\b/i.test(e.message);
}

async function callOpenAiCompatible(cfg: AiConfig, messages: ChatMessage[]): Promise<string> {
  const url = chatCompletionsUrl(cfg);
  const headers = openAiCompatibleHeaders(cfg);
  const model = cfg.model.trim() || (cfg.provider === "google" ? GOOGLE_DEFAULT_MODEL : cfg.model);
  const baseBody: JsonObject = {
    model,
    messages,
    temperature: 0,
    max_completion_tokens: 900,
    response_format: { type: "json_object" },
  };
  if (cfg.provider === "google" && model === GOOGLE_DEFAULT_MODEL) {
    baseBody.reasoning_effort = "minimal";
  }

  try {
    return extractChatText(await postJson(url, headers, baseBody));
  } catch (e) {
    if (!shouldRetryWithoutStrictJson(e)) throw e;
    // Some OpenAI-compatible providers reject JSON mode or newer token params.
    const fallbackBody = { ...baseBody };
    delete fallbackBody.response_format;
    delete fallbackBody.max_completion_tokens;
    delete fallbackBody.reasoning_effort;
    fallbackBody.max_tokens = 900;
    return extractChatText(await postJson(url, headers, fallbackBody));
  }
}

async function callAnthropic(cfg: AiConfig, messages: ChatMessage[]): Promise<string> {
  const url = anthropicMessagesUrl(cfg);
  const data = await postJson(
    url,
    {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model: cfg.model,
      max_tokens: 900,
      temperature: 0,
      system: messages.find((m) => m.role === "system")?.content,
      messages: messages.filter((m) => m.role !== "system"),
    },
  );
  const text = (data as { content?: { text?: unknown }[] }).content?.[0]?.text;
  if (typeof text !== "string") throw new Error("Unexpected API response shape.");
  return text;
}

async function callModel(cfg: AiConfig, messages: ChatMessage[]): Promise<string> {
  return cfg.provider === "anthropic"
    ? callAnthropic(cfg, messages)
    : callOpenAiCompatible(cfg, messages);
}

export async function aiMatch(
  cfg: AiConfig, jobUrl: string, jobText: string, profiles: MatchProfile[],
): Promise<MatchResult> {
  const messages = buildMessages(jobText, profiles);
  const raw = await callModel(cfg, messages);
  const parsed = parseModelJson(raw);
  return {
    jobUrl,
    ...parsed,
    source: "ai",
    model: cfg.model,
    createdAt: Date.now(),
  };
}

export interface ExtractedJob {
  title: string;
  company: string;
  location: string;
  description: string;
}

/** Ask the model to pull job details out of raw page text when DOM scraping
 * found nothing usable. */
export async function aiExtractJob(cfg: AiConfig, pageText: string): Promise<ExtractedJob> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You extract job-posting details from raw web page text. Return only valid JSON.",
    },
    {
      role: "user",
      content: [
        "Extract the job posting details from this page text.",
        "If the page is not a job posting, return empty strings.",
        "Do not invent details that are not present in the text.",
        'Return JSON exactly like: {"title":"...","company":"...","location":"...","description":"..."}',
        "description = the job's responsibilities/requirements text, condensed to at most 400 words.",
        "",
        "PAGE TEXT:",
        pageText.slice(0, MAX_JD_CHARS * 2),
      ].join("\n"),
    },
  ];
  const data = parseJsonObject(await callModel(cfg, messages));
  const str = (key: string, max: number): string => String(data[key] ?? "").trim().slice(0, max);
  return {
    title: str("title", 200),
    company: str("company", 200),
    location: str("location", 200),
    description: str("description", MAX_JD_CHARS),
  };
}

export function localDraftAnswer(question: string, jobText: string, profileText: string): DraftAnswerResult {
  const skills = [...tokens(profileText)]
    .filter((w) => tokens(jobText).has(w))
    .slice(0, 8);
  const skillPhrase = skills.length ? ` My relevant experience includes ${skills.join(", ")}.` : "";
  return {
    question,
    answer: `I am interested in this role because it aligns with my background and the requirements described in the job posting.${skillPhrase} I would bring relevant experience, a practical working style, and a strong focus on delivering useful outcomes for the team.`,
    source: "local",
    createdAt: Date.now(),
  };
}

export async function aiDraftAnswer(
  cfg: AiConfig, question: string, jobText: string, profileText: string,
): Promise<DraftAnswerResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You draft concise job-application answers. Return only valid JSON.",
    },
    {
      role: "user",
      content: [
        "Draft an honest first-person answer for this job application question.",
        "Use only the candidate facts provided. Do not invent employers, degrees, tools, dates, certifications, citizenship, visa status, salary, disability, veteran, race, religion, or other legal/EEO facts.",
        "Keep it specific, professional, and under 120 words.",
        'Return JSON exactly like: {"answer":"..."}',
        "",
        "QUESTION:",
        question,
        "",
        "JOB:",
        jobText.slice(0, MAX_JD_CHARS),
        "",
        "CANDIDATE FACTS:",
        profileText.slice(0, MAX_PROFILE_CHARS),
      ].join("\n"),
    },
  ];
  const data = parseJsonObject(await callModel(cfg, messages));
  return {
    question,
    answer: String(data.answer ?? "").trim().slice(0, 1400),
    source: "ai",
    model: cfg.model,
    createdAt: Date.now(),
  };
}

export function localTailorResume(
  jobUrl: string, jobText: string, profile: MatchProfile,
): ResumeTailoringResult {
  const jd = tokens(jobText);
  const resume = tokens(profile.text);
  const missing = [...jd]
    .filter((w) => !resume.has(w))
    .filter((w) => !/^\d+$/.test(w))
    .slice(0, 12);
  return {
    jobUrl,
    resumeName: profile.name,
    summary: "Keyword-based tailoring suggestions. Configure AI Matching for stronger semantic rewrite guidance.",
    keywordsToAdd: missing,
    suggestedBullets: [
      "Add 2-3 measurable bullets that mirror the job's core responsibilities using your real experience.",
      "Move the most relevant tools, domains, and outcomes into the top third of the resume.",
      "Use the employer's terminology where it accurately matches your background.",
    ],
    notes: [
      "Do not add keywords you cannot defend in an interview.",
      "Keep the tailored version reviewable before uploading it to an application.",
    ],
    source: "local",
    createdAt: Date.now(),
  };
}

export async function aiTailorResume(
  cfg: AiConfig, jobUrl: string, jobText: string, profile: MatchProfile,
): Promise<ResumeTailoringResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You give practical resume-tailoring guidance. Return only valid JSON.",
    },
    {
      role: "user",
      content: [
        "Compare the job description with this resume/profile text.",
        "Suggest only truthful edits: do not invent experience, employers, dates, degrees, certifications, or tools.",
        "Return JSON exactly like:",
        '{"summary":"...","keywordsToAdd":["..."],"suggestedBullets":["..."],"notes":["..."]}',
        "Use up to 10 keywords, up to 6 bullet suggestions, and up to 4 notes.",
        "",
        "JOB DESCRIPTION:",
        jobText.slice(0, MAX_JD_CHARS),
        "",
        "RESUME / PROFILE:",
        profile.text.slice(0, MAX_PROFILE_CHARS),
      ].join("\n"),
    },
  ];
  const data = parseJsonObject(await callModel(cfg, messages));
  const list = (key: string, max: number): string[] =>
    Array.isArray(data[key])
      ? data[key].slice(0, max).map((v) => String(v).trim()).filter(Boolean)
      : [];
  return {
    jobUrl,
    resumeName: profile.name,
    summary: String(data.summary ?? "").trim().slice(0, 600),
    keywordsToAdd: list("keywordsToAdd", 10),
    suggestedBullets: list("suggestedBullets", 6).map((v) => v.slice(0, 300)),
    notes: list("notes", 4).map((v) => v.slice(0, 220)),
    source: "ai",
    model: cfg.model,
    createdAt: Date.now(),
  };
}
