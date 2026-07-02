// Help text for every user-facing field: what it is and why job portals
// ask for it. Rendered as an info-icon tooltip next to the field label.

export const FIELD_HELP: Record<string, string> = {
  // ---- profile: personal ----
  firstName: "Your legal first name, as on official documents. Nearly every application requires it for identification and background checks.",
  middleName: "Optional. Some portals (mainly US) have a separate middle-name box. Leave blank if you don't use one.",
  lastName: "Legal surname / family name. Required everywhere; for visa-sponsored roles it must match your passport.",
  email: "Primary contact email. Recruiters send interview invites and offers here — use one you check daily.",
  alternateEmail: "Backup email a few portals ask for. Used only if your primary address bounces.",
  phone: "Include the country code (e.g. +91, +65). Foreign recruiters cannot call a local-format number.",
  whatsapp: "Some overseas recruiters (UAE, India, Singapore) prefer WhatsApp for quick screening chats. Optional.",
  dateOfBirth: "Optional. Only some portals (India, UAE) ask. FireApply fills it only when a form explicitly asks for it.",
  gender: "Optional diversity field. FireApply never answers demographic questions automatically — this is only used when YOU choose to fill it.",
  nationality: "Employers use this to gauge visa requirements. Must match your passport.",
  currentResidenceCountry: "Where you live right now. Employers use it to plan relocation, notice period, and interview time zones.",

  // ---- profile: address ----
  address: "Street address. Needed for offer letters, contracts, and background verification.",
  city: "Current city. Recruiters check it against the job location to judge relocation needs.",
  state: "State or province. Part of the standard address block on most forms.",
  postalCode: "ZIP / PIN / postcode. Required in the address section of most portals.",
  country: "Country of your current address. Often a dropdown on forms — FireApply matches the option text.",

  // ---- profile: professional ----
  currentTitle: "Your exact current designation. Recruiters match it against the role's seniority level.",
  currentEmployer: "Current company name. Used for experience verification and conflict-of-interest checks.",
  totalExperience: "Total years of work experience (a number, e.g. 7). Many portals filter candidates on this.",
  relevantExperience: "Years of experience relevant to the roles you apply for — often asked separately from total experience.",
  primarySkills: "Comma-separated core skills. ATS systems keyword-match these against the job description, so use the same terms as job ads.",
  secondarySkills: "Additional skills and tools. Helps on longer forms that ask for a full skill inventory.",
  currentSalary: "Some portals require current pay. Include the currency (e.g. \"18 LPA INR\", \"85000 SGD\"). Expected salary is set per country in the Countries tab.",

  // ---- profile: education ----
  highestDegree: "Your highest completed qualification (e.g. Bachelor's, Master's). Common screening filter.",
  degreeName: "The formal degree title, e.g. \"B.Tech Computer Science\", \"MSc Data Science\".",
  university: "University or college name. Used for education verification.",
  fieldOfStudy: "Your major / specialization. Portals often ask it separately from the degree.",
  graduationYear: "Year you completed the degree. Used to compute career length.",
  gpa: "GPA, CGPA, or percentage — whichever your institution used. Only some portals ask.",

  // ---- profile: links ----
  linkedinUrl: "Full LinkedIn profile URL. Most-requested link on applications; recruiters check it almost every time.",
  githubUrl: "GitHub profile URL. Tech roles frequently ask for it as work evidence.",
  portfolioUrl: "Portfolio or work-samples URL. Common for design/frontend roles.",
  personalWebsite: "Personal site or blog. Filled into generic \"Website\" fields when portals ask.",

  // ---- profile: cover letter ----
  coverLetterText: "Default text used when a form has a cover-letter box. Keep it generic enough to fit any company — you can edit it on the page after filling.",

  // ---- country profile ----
  "country-select": "Pick a country to edit its answers. When a job in this country is detected, these values answer visa, salary, relocation, and notice-period questions.",
  authorizedToWork: "Legal question. Answer \"Yes\" only if you already hold citizenship or a valid work permit for this country. FireApply never guesses this — if empty, it asks you on the page.",
  needsSponsorship: "Whether the employer must sponsor your visa now or in the future. Answer honestly — a wrong answer here can void an offer later.",
  visaType: "Your current visa/immigration status for this country (e.g. \"H-1B\", \"EU Blue Card\", \"None\"). Filled when portals ask for visa status.",
  workPermitType: "Specific permit you hold, if any (e.g. \"Employment Pass\", \"Golden Visa\"). Leave blank if none.",
  willingToRelocate: "Standard screening question for foreign applications. \"Yes\" signals you'll move for this job.",
  noticePeriod: "Time you need before joining (e.g. \"30 days\", \"immediate\"). One of the most common screening questions in India, Singapore, and Germany.",
  expectedSalary: "Expected pay for jobs in this country, as a number in the local currency. Combined with the format setting below when answering salary questions.",
  salaryCurrency: "Currency used for salary answers in this country (auto-set to the local one, e.g. SGD, EUR, AED).",
  salaryAnswerFormat: "How FireApply words the salary answer: an exact figure, a range, \"Negotiable\", or \"Ask me every time\" if you want to decide per application.",
  preferredCities: "Cities you'd accept in this country. Some forms ask for location preference.",
  notes: "Private notes for yourself about this market (visa timelines, salary research). Never filled into forms.",

  // ---- resume manager ----
  "resume-name": "Display name shown in the popup and side panel, e.g. \"Germany .NET Resume\". Pick names that make the country/purpose obvious.",
  "resume-file": "The actual PDF/DOCX uploaded to portals. Stored encrypted inside the extension — the file never leaves your machine until a portal upload.",
  "resume-countries": "Jobs detected in these countries auto-select this resume. Hold Ctrl to pick several. Leave empty for a general-purpose resume.",
  "resume-role": "Optional tag (e.g. \".NET Developer\") to tell resumes apart when you keep several per country.",
  "resume-default": "Fallback resume used when no country-specific resume matches the job.",

  // ---- settings ----
  autolock: "Minutes of inactivity before the vault locks itself and requires the master password again. 0 disables auto-lock (not recommended).",
};
