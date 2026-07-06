// Help text for every user-facing field: what it is and why job portals
// ask for it. Rendered as an info-icon tooltip next to the field label.

export const FIELD_HELP: Record<string, string> = {
  // ---- profile: personal ----
  firstName: "Your legal first name, as on official documents. Nearly every application requires it for identification and background checks.",
  middleName: "Optional. Some portals, mainly US, have a separate middle-name box. Leave blank if you don't use one.",
  lastName: "Legal surname / family name. Required everywhere; for visa-sponsored roles it must match your passport.",
  email: "Primary contact email. Recruiters send interview invites and offers here. Use one you check daily.",
  alternateEmail: "Backup email a few portals ask for. Used only if your primary address bounces.",
  phone: "Include the country code, e.g. +91, +65. Foreign recruiters cannot call a local-format number.",
  whatsapp: "Some overseas recruiters, especially UAE, India, and Singapore, prefer WhatsApp for quick screening chats. Optional.",
  dateOfBirth: "Optional. Only some portals, such as India and UAE, ask. JobPilot AI fills it only when a form explicitly asks for it.",
  gender: "Optional diversity field. JobPilot AI never answers demographic questions automatically. This is only used when YOU choose to fill it.",
  nationality: "Employers use this to gauge visa requirements. Must match your passport.",
  currentResidenceCountry: "Where you live right now. Employers use it to plan relocation, notice period, and interview time zones.",

  // ---- profile: address ----
  address: "Street address. Needed for offer letters, contracts, and background verification.",
  city: "Current city. Recruiters check it against the job location to judge relocation needs.",
  state: "State or province. Part of the standard address block on most forms.",
  postalCode: "ZIP / PIN / postcode. Required in the address section of most portals.",
  country: "Country of your current address. Often a dropdown on forms. JobPilot AI matches the option text.",

  // ---- profile: professional ----
  currentTitle: "Your exact current designation. Recruiters match it against the role's seniority level.",
  currentEmployer: "Current company name. Used for experience verification and conflict-of-interest checks.",
  totalExperience: "Total years of work experience as a number, e.g. 7. Many portals filter candidates on this.",
  relevantExperience: "Years of experience relevant to the roles you apply for. Often asked separately from total experience.",
  primarySkills: "Comma-separated core skills. ATS systems keyword-match these against the job description, so use the same terms as job ads.",
  secondarySkills: "Additional skills and tools. Helps on longer forms that ask for a full skill inventory.",
  currentSalary: "Some portals require current pay. Include the currency, e.g. \"18 LPA INR\" or \"85000 SGD\". Expected salary is set per country in the Countries tab.",

  // ---- profile: education ----
  highestDegree: "Your highest completed qualification, e.g. Bachelor's or Master's. Common screening filter.",
  degreeName: "The formal degree title, e.g. \"B.Tech Computer Science\" or \"MSc Data Science\".",
  university: "University or college name. Used for education verification.",
  fieldOfStudy: "Your major / specialization. Portals often ask it separately from the degree.",
  graduationYear: "Year you completed the degree. Used to compute career length.",
  gpa: "GPA, CGPA, or percentage, whichever your institution used. Only some portals ask.",

  // ---- profile: links ----
  linkedinUrl: "Full LinkedIn profile URL. Most-requested link on applications; recruiters check it almost every time.",
  githubUrl: "GitHub profile URL. Tech roles frequently ask for it as work evidence.",
  portfolioUrl: "Portfolio or work-samples URL. Common for design/frontend roles.",
  personalWebsite: "Personal site or blog. Filled into generic \"Website\" fields when portals ask.",

  // ---- profile: cover letter ----
  coverLetterText: "Default text used when a form has a cover-letter box. Keep it generic enough to fit any company. You can edit it on the page after filling.",

  // ---- country profile ----
  "country-select": "Pick a country to edit its answers. When a job in this country is detected, these values answer visa, salary, relocation, and notice-period questions.",
  authorizedToWork: "Legal question. Answer \"Yes\" only if you already hold citizenship or a valid work permit for this country. JobPilot AI never guesses this. If empty, it asks you on the page.",
  needsSponsorship: "Whether the employer must sponsor your visa now or in the future. Answer honestly. A wrong answer here can void an offer later.",
  visaType: "Your current visa/immigration status for this country, e.g. \"H-1B\", \"EU Blue Card\", or \"None\". Filled when portals ask for visa status.",
  workPermitType: "Specific permit you hold, if any, e.g. \"Employment Pass\" or \"Golden Visa\". Leave blank if none.",
  willingToRelocate: "Standard screening question for foreign applications. \"Yes\" signals you'll move for this job.",
  noticePeriod: "Time you need before joining, e.g. \"30 days\" or \"immediate\". One of the most common screening questions in India, Singapore, and Germany.",
  expectedSalary: "Expected pay for jobs in this country, as a number in the local currency. Combined with the format setting below when answering salary questions.",
  salaryCurrency: "Currency used for salary answers in this country. Auto-set to the local one, e.g. SGD, EUR, AED.",
  salaryAnswerFormat: "How JobPilot AI words the salary answer: an exact figure, a range, \"Negotiable\", or \"Ask me every time\" if you want to decide per application.",
  preferredCities: "Cities you'd accept in this country. Some forms ask for location preference.",
  notes: "Private notes for yourself about this market, such as visa timelines or salary research. Never filled into forms.",

  // ---- resume manager ----
  "resume-name": "Display name shown in the popup and side panel, e.g. \"Germany .NET Resume\". Pick names that make the country/purpose obvious.",
  "resume-file": "The actual PDF/DOCX uploaded to portals. Stored encrypted inside the extension. The file never leaves your machine until a portal upload.",
  "resume-countries": "Jobs detected in these countries auto-select this resume. Hold Ctrl to pick several. Leave empty for a general-purpose resume.",
  "resume-role": "Optional tag, e.g. \".NET Developer\", to tell resumes apart when you keep several per country.",
  "resume-default": "Fallback resume used when no country-specific resume matches the job.",

  // ---- AI matching ----
  "ai-provider": "Which AI service scores your job matches. OpenRouter is the easiest: one key gives access to every cheap model. 'Custom' works with any OpenAI-compatible endpoint, such as Groq, Together, or local Ollama.",
  "ai-model": "Model used for scoring. Cheap, fast models are enough for this task because matching is classification, not writing. Examples: google/gemini-2.0-flash-lite-001 (OpenRouter), gpt-4o-mini (OpenAI), claude-haiku-4-5-20251001 (Anthropic).",
  "ai-baseurl": "API endpoint base URL. Prefilled per provider; only change it for custom/self-hosted endpoints. JobPilot AI requests permission to call this host when you save.",
  "ai-key": "Your API key for the provider. Stored AES-encrypted in the vault, sent only to the base URL above, never anywhere else.",
  "ai-enabled": "Master switch. Off = matching still works with the free offline keyword estimate; on = job description + resume text are sent to your AI provider for semantic scoring.",
  "ai-auto": "When on, every detected job page is scored automatically and results are cached per job. Turn off to only match when you click the button in the side panel. This saves tokens and sends nothing without your action.",
};
