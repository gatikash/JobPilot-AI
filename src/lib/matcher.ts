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

/** Local matching reads the whole resume (or close to it) — the small
 * MAX_PROFILE_CHARS cap exists only to bound AI prompt size, and truncating
 * the resume text locally silently drops skills sections near the end. */
const MAX_LOCAL_PROFILE_CHARS = 20_000;

/** Light normalization so trivial inflections don't count as misses:
 * strips surrounding dots and singularizes simple plurals ("APIs" -> "api",
 * "containers" -> "container"). Deliberately not a real stemmer — aggressive
 * stemming corrupts tech tokens like "aws" or "less". */
function normalizeToken(word: string): string {
  const t = word.replace(/^[./]+|[./]+$/g, "");
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function isStopOrNoise(normalized: string): boolean {
  // Sets store surface forms ("years", "skills"); check the re-pluralized
  // form too so normalized tokens still hit them.
  return (
    STOPWORDS.has(normalized) || STOPWORDS.has(normalized + "s") ||
    KEYWORD_NOISE.has(normalized) || KEYWORD_NOISE.has(normalized + "s")
  );
}

function meaningfulTokens(text: string): string[] {
  // "/" kept so compound tokens like "ci/cd" survive as one term on both the
  // JD and resume side instead of splitting into sub-3-char fragments.
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}+#./]/gu, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((w) => w.length > 2 && !isStopOrNoise(w));
}

/** Terms shorter than this or purely numeric are dropped from the "missing
 * keyword" chip list so we don't surface noise like "10" or "an". */
const KEYWORD_MIN_LEN = 3;

/** Common resume/JD boilerplate that should not be surfaced as a missing skill
 * even when the resume happens not to contain it. Kept separate from STOPWORDS
 * (which controls tokenization) so match scores are unaffected. */
const KEYWORD_NOISE = new Set(
  ("email phone address linkedin github portfolio website country state city zip " +
   "resume cv cover letter apply application applicant candidate job role position " +
   "team teams company companies opportunity role role- role-based benefits perks " +
   "insurance dental vision equity bonus salary compensation location remote hybrid " +
   "onsite office full time part contract permanent responsibilities requirements " +
   "qualifications background education degree diploma university college school year " +
   "years month months day days week weeks hour hours minute minutes " +
   "must should may might would could well ability skills skill knowledge understanding " +
   "strong excellent proven demonstrated preferred required minimum maximum plus etc " +
   "including includes include example examples various multiple across within throughout " +
   "will provide provided provides help helps helping ensure ensures ensuring build builds " +
   "building make makes making create creates creating design designs designing develop " +
   "develops developing work working works using use uses used join joining our your their " +
   "need needs needed want wants wanted looking seek seeking manage manages managing managed " +
   "lead leads leading deliver delivers delivering support supports supporting maintain " +
   "maintains maintaining scale scaling senior junior entry mid level staff principal " +
   "ideal candidate someone else also very highly great good best world class culture " +
   "mission vision values every everyone employees people person")
    .split(/\s+/),
);

/** Heuristic: tech terms tend to carry digits, symbols, inner caps, or be
 * all-caps acronyms ("PostgreSQL", "CI/CD", "AWS", "C++"). Used to rank
 * missing-keyword chips ahead of plain prose words. */
function looksTechnical(raw: string): boolean {
  return /[0-9+#./]/.test(raw) || /[A-Z]/.test(raw.slice(1));
}

function computeMissingKeywords(jdText: string, resumeText: string): string[] {
  // Token-set membership instead of substring search: `includes("java")`
  // false-matched inside "javascript", and plural/singular drift produced
  // bogus "missing" chips. Both sides now compare normalized tokens.
  const resumeTokens = new Set(
    meaningfulTokens(resumeText.slice(0, MAX_LOCAL_PROFILE_CHARS)),
  );
  const counts = new Map<string, { raw: string; count: number }>();

  // Preserve the on-page casing when we surface candidates.
  const wordRe = /[A-Za-z][A-Za-z0-9+#./-]{2,}/g;
  for (const match of jdText.slice(0, MAX_JD_CHARS).matchAll(wordRe)) {
    const raw = match[0].replace(/[./-]+$/, "");
    const key = normalizeToken(raw.toLowerCase());
    if (key.length < KEYWORD_MIN_LEN) continue;
    if (isStopOrNoise(key)) continue;
    if (resumeTokens.has(key)) continue;
    const cur = counts.get(key);
    if (cur) {
      cur.count++;
      // Prefer a technical-looking surface form over a sentence-start one.
      if (!looksTechnical(cur.raw) && looksTechnical(raw)) cur.raw = raw;
    } else {
      counts.set(key, { raw, count: 1 });
    }
  }

  // Rank: technical-looking terms first, then by how often the JD repeats
  // them — repetition is the JD's own signal of importance.
  return [...counts.values()]
    .sort((a, b) =>
      (Number(looksTechnical(b.raw)) - Number(looksTechnical(a.raw))) ||
      (b.count - a.count))
    .slice(0, 12)
    .map((c) => c.raw);
}

export function localMatch(
  jobUrl: string, jobText: string, profiles: MatchProfile[],
): MatchResult {
  // Weight each JD term by how often the JD repeats it (capped so one
  // hammered word can't dominate) — repeated terms are the JD's own signal
  // of what the role is actually about.
  const weights = new Map<string, number>();
  for (const t of meaningfulTokens(jobText.slice(0, MAX_JD_CHARS))) {
    weights.set(t, Math.min(4, (weights.get(t) ?? 0) + 1));
  }
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;

  const results: ProfileMatch[] = profiles.map((p) => {
    const pt = new Set(meaningfulTokens(p.text.slice(0, MAX_LOCAL_PROFILE_CHARS)));
    if (pt.size === 0 || totalWeight === 0) {
      return { name: p.name, percent: 0, reason: "No text to compare." };
    }
    let hits = 0;
    let hitWeight = 0;
    for (const [t, w] of weights) {
      if (pt.has(t)) {
        hits++;
        hitWeight += w;
      }
    }
    // sqrt curve: JDs contain plenty of vocabulary no resume will ever echo,
    // so raw coverage tops out well below 1.0 even for strong fits. The curve
    // spreads the useful 0.1-0.6 coverage band across a friendly 30-80 range
    // while staying monotonic.
    const percent = Math.min(96, Math.round(Math.sqrt(hitWeight / totalWeight) * 100));
    return {
      name: p.name,
      percent,
      reason: `${hits} of ${weights.size} JD terms matched (weighted keyword estimate).`,
    };
  });
  results.sort((a, b) => b.percent - a.percent);
  const best = results[0];
  const bestProfile = profiles.find((p) => p.name === best?.name);
  const missingKeywords = best && bestProfile
    ? computeMissingKeywords(jobText, bestProfile.text)
    : [];
  return {
    jobUrl,
    overall: best?.percent ?? 0,
    profiles: results,
    missingKeywords,
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
  const nameList = profiles.map((p) => `"${p.name}"`).join(", ");
  return [
    "You are a strict, evidence-based job-fit scorer. Follow these steps internally:",
    "1. Extract the JOB DESCRIPTION's hard requirements: core tools/technologies, methodologies,",
    "   domain areas, years of experience, seniority level, and any degree/certification asks.",
    "2. For each CANDIDATE PROFILE, check each requirement against the profile text. Count",
    "   direct hits (explicit mention), transferable hits (closely related tools/skills), and",
    "   clear gaps (requirement never referenced).",
    "3. Score 0-100. Anchors: 80+ = strong direct match on most core requirements. 60-79 =",
    "   solid fit with a few transferable gaps. 40-59 = partial or transferable. Below 30 =",
    "   weak. Do not inflate scores when core hard requirements are missing.",
    "",
    "For missingKeywords: list the CONCRETE hard requirements missing from the best profile",
    "(e.g. 'Kubernetes', 'PostgreSQL', '5+ years of backend', 'FedRAMP'). Do NOT include vague",
    "words like 'communication', 'teamwork', 'passion', 'ownership', or generic verbs.",
    "Use the JD's exact wording where it fits. Cap at 10 items.",
    "",
    "For recommendedResume: return the exact profile name from this list, or empty string:",
    `[${nameList}]`,
    "",
    "Respond with ONLY valid JSON, no markdown fences, exactly this shape:",
    '{"overall": <0-100 best profile score>, "profiles": [{"name": "<profile name>", "percent": <0-100>, "reason": "<one short sentence naming the strongest hits and biggest gap>"}], "missingKeywords": ["<up to 10 concrete missing hard requirements>"], "recommendedResume": "<exact profile name, or empty string>"}',
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
      ? data.missingKeywords.slice(0, 10)
          .map((k: unknown) => String(k).trim().slice(0, 80))
          .filter((k: string) => k.length > 0)
      : [],
    recommendedResume: String(data.recommendedResume ?? "").trim(),
  };
}

/** Model may return `recommendedResume` with slight casing / punctuation
 * differences from the real profile names — snap it to the closest actual
 * name so the panel does not render a hallucinated recommendation. */
function snapRecommendedResume(candidate: string, profiles: MatchProfile[]): string {
  if (!candidate) return "";
  const names = profiles.map((p) => p.name);
  if (names.includes(candidate)) return candidate;
  const lower = candidate.toLowerCase().trim();
  const exact = names.find((n) => n.toLowerCase().trim() === lower);
  if (exact) return exact;
  const partial = names.find((n) => {
    const nl = n.toLowerCase();
    return nl.includes(lower) || lower.includes(nl);
  });
  return partial ?? "";
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
    headers["HTTP-Referer"] = "https://github.com/gatikash/JobPilot-AI";
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
    max_completion_tokens: 1400,
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
    fallbackBody.max_tokens = 1400;
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
      max_tokens: 1400,
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
    recommendedResume: snapRecommendedResume(parsed.recommendedResume, profiles),
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

/** Extract sentences that read like responsibility/requirement lines. Used by
 * the local tailoring fallback to seed JD-anchored bullet templates so the
 * side panel is not stuck showing pure boilerplate advice. */
function extractRequirementSentences(jobText: string): string[] {
  const clean = jobText.replace(/\s+/g, " ").trim();
  // Split on sentence boundaries and bullet-like markers (•, -, *, • at start).
  const parts = clean.split(/(?:[.!?](?:\s+|$))|(?:\s[•●▪◦*·-]\s+)/g);
  const rankRe = /\b(responsibilit|requirement|experience|proficien|familiar|knowledge|skill|expert|design|develop|build|deliver|own|lead|manage|collaborat|drive|scale|optimiz|implement|architect|deploy|integrat|analyz|automat)/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = raw.trim();
    if (s.length < 25 || s.length > 220) continue;
    if (!rankRe.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.replace(/^[-•●▪◦*·\s]+/, ""));
    if (out.length >= 6) break;
  }
  return out;
}

export function localTailorResume(
  jobUrl: string, jobText: string, profile: MatchProfile,
): ResumeTailoringResult {
  const missing = computeMissingKeywords(jobText, profile.text).slice(0, 10);
  const requirementLines = extractRequirementSentences(jobText);

  // Seed bullets from the JD's own requirement lines so the user gets concrete
  // starting points, not generic advice. The AI path returns richer bullets;
  // this is the offline / fallback experience.
  const jdBullets = requirementLines.slice(0, 4).map((line) => {
    return `Rewrite an existing bullet to reflect this JD line: "${line}"`;
  });
  const skillBullets = missing.slice(0, 3).map((kw) => {
    return `Add a bullet that demonstrates ${kw}: what you built with it, the outcome, and any metric.`;
  });
  const genericBullets = [
    "Move your two strongest role-relevant bullets to the top of the most recent experience block.",
    "Rewrite one bullet per role in X (action) / Y (metric) / Z (tool) format using the JD's terminology.",
  ];
  const suggestedBullets = [...skillBullets, ...jdBullets, ...genericBullets].slice(0, 6);

  const summary = requirementLines.length
    ? `Local tailoring: matched against ${requirementLines.length} JD lines. Add missing keywords only where they reflect real work you can defend.`
    : "Keyword-based tailoring suggestions. Configure AI Matching for stronger semantic rewrite guidance.";

  return {
    jobUrl,
    resumeName: profile.name,
    summary,
    keywordsToAdd: missing,
    suggestedBullets,
    notes: [
      "Never add a keyword you cannot defend in an interview.",
      "Reuse the employer's exact terminology when it accurately matches your background — ATS systems key on wording.",
      "Keep the tailored version diff-reviewable before uploading it to an application.",
    ],
    source: "local",
    createdAt: Date.now(),
  };
}

export interface AiFieldInput {
  idx: number;
  label: string;
  placeholder: string;
  aria: string;
  nearby: string;
  name: string;
  inputType: string;
  required: boolean;
  options: string[];
}

/** Ask the AI to map ambiguous form fields to canonical profile keys.
 * Only used after the deterministic keyword matcher has failed. Model is
 * instructed to answer null for anything legal / EEO / visa / salary /
 * demographic so those never get autofilled from an AI guess. */
export async function aiMapFields(
  cfg: AiConfig, fields: AiFieldInput[], profileKeys: string[],
): Promise<Record<number, string>> {
  if (fields.length === 0 || profileKeys.length === 0) return {};
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You map job-application form fields to canonical profile keys. Return only valid JSON.",
    },
    {
      role: "user",
      content: [
        "For each FIELD, pick the SINGLE best canonical key from AVAILABLE_KEYS,",
        "or null when no key clearly matches the field.",
        "A mapping must be a direct semantic match between the field and the key.",
        "Never use a populated primary value as a substitute for a distinct blank slot.",
        "For example: alternate email is not email, middle name is not first name,",
        "and Address Line 2 or 3 is not Address Line 1 / address.",
        "Map address only to an unnumbered street-address field or Address Line 1.",
        "Use inputType, required, and options as context; required does not lower",
        "the confidence threshold. Return null rather than making a best-effort guess.",
        "Do not invent keys that are not in AVAILABLE_KEYS.",
        "Return null for legal, visa, sponsorship, salary, EEO, gender, race,",
        "disability, veteran, criminal, religion, or sexual orientation questions.",
        "Return null for the resume upload input (a real file input).",
        'Return JSON exactly like: {"mappings":[{"idx":0,"key":"email"},{"idx":1,"key":null}]}',
        "",
        "AVAILABLE_KEYS:",
        profileKeys.join(", "),
        "",
        "FIELDS:",
        JSON.stringify(fields).slice(0, 8000),
      ].join("\n"),
    },
  ];
  const data = parseJsonObject(await callModel(cfg, messages));
  const out: Record<number, string> = {};
  const arr = Array.isArray(data.mappings) ? data.mappings : [];
  const allowed = new Set(profileKeys);
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const idx = rec.idx;
    const key = rec.key;
    if (typeof idx === "number" && typeof key === "string" && allowed.has(key)) {
      out[idx] = key;
    }
  }
  return out;
}

export async function aiTailorResume(
  cfg: AiConfig, jobUrl: string, jobText: string, profile: MatchProfile,
): Promise<ResumeTailoringResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a senior resume coach. You give practical, truthful, JD-anchored resume-tailoring guidance. Return only valid JSON.",
    },
    {
      role: "user",
      content: [
        "Compare the JOB DESCRIPTION against the CANDIDATE RESUME and produce tailoring guidance.",
        "",
        "HARD RULES:",
        "- Do not invent employers, dates, degrees, certifications, tools, or metrics not implied by the resume.",
        "- Anchor every bullet to an experience already present in the resume. Rewrite existing evidence,",
        "  do not fabricate new roles or projects.",
        "- Each bullet must be a full rewrite the user could drop into the resume, NOT advice like 'add a bullet about X'.",
        "- Prefer the XYZ format: '<Action verb> <what/how>, <quantified outcome>, using <JD tool/skill>'.",
        "- Use exact JD terminology where it accurately reflects the candidate's real work (ATS keys on wording).",
        "- Include a metric or a concrete artifact in at least 4 of the 6 bullets when the resume gives one; if the",
        "  resume has no numbers for a particular claim, leave the metric out rather than inventing.",
        "",
        "FIELDS:",
        "- summary (<=600 chars): one paragraph describing how to reshape the resume for this JD, naming the top",
        "  2-3 areas to emphasise and 1-2 to de-emphasise. Do not restate the JD.",
        "- keywordsToAdd: up to 10 concrete hard skills / tools / methodologies from the JD absent from the resume",
        "  or under-represented in it. No soft skills, no vague verbs.",
        "- suggestedBullets: up to 6 fully-written resume bullets, each 15-40 words, in XYZ format where possible,",
        "  each mapped to a real experience in the resume.",
        "- notes: up to 4 short strategic notes (headline tweaks, section reordering, red flags).",
        "",
        "Return JSON exactly like:",
        '{"summary":"...","keywordsToAdd":["..."],"suggestedBullets":["..."],"notes":["..."]}',
        "",
        "JOB DESCRIPTION:",
        jobText.slice(0, MAX_JD_CHARS),
        "",
        "CANDIDATE RESUME:",
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
    keywordsToAdd: list("keywordsToAdd", 10).map((v) => v.slice(0, 80)),
    suggestedBullets: list("suggestedBullets", 6).map((v) => v.slice(0, 300)),
    notes: list("notes", 4).map((v) => v.slice(0, 220)),
    source: "ai",
    model: cfg.model,
    createdAt: Date.now(),
  };
}
