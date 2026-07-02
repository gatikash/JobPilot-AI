// Portal + country detection. Pure functions over URL/text so they are
// unit-testable outside the browser.

import { COUNTRIES, Portal } from "./types";

export function detectPortal(url: string): Portal {
  const u = url.toLowerCase();
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("myworkdayjobs.com") || u.includes("workday")) return "workday";
  if (u.includes("indeed.")) return "indeed";
  if (u.includes("naukri.com")) return "naukri";
  return "generic";
}

/**
 * Detect country from location text plus supporting page signals.
 * Returns ISO-2 code or "" when ambiguous/unknown (caller must ask user).
 */
export function detectCountry(locationText: string, pageTitle = "", url = ""): string {
  const hits = new Set<string>();
  const loc = ` ${locationText.toLowerCase()} `;
  for (const c of COUNTRIES) {
    if (c.keywords.some((k) => loc.includes(k))) hits.add(c.code);
  }
  if (hits.size === 1) return [...hits][0];
  if (hits.size > 1) return ""; // ambiguous -> ask user

  // fall back to weaker signals only when location text said nothing
  const rest = ` ${pageTitle.toLowerCase()} `;
  for (const c of COUNTRIES) {
    if (c.keywords.some((k) => rest.includes(k))) hits.add(c.code);
  }
  if (hits.size === 1) return [...hits][0];

  const tld: Record<string, string> = {
    ".in/": "IN", ".sg/": "SG", ".de/": "DE", ".ae/": "AE", ".ie/": "IE",
    ".uk/": "GB", ".ca/": "CA", ".au/": "AU", ".nl/": "NL",
  };
  const uu = url.toLowerCase() + "/";
  for (const [suffix, code] of Object.entries(tld)) {
    try {
      const host = new URL(url).host + "/";
      if (host.endsWith(suffix)) return code;
    } catch {
      if (uu.includes(suffix)) return code;
    }
  }
  return "";
}
