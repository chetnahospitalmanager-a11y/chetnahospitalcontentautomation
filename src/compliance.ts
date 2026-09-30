// NMC (India) rules on doctors' advertising: no superlatives, no promised results, no testimonials.
// Gemini is told these rules, and this check is a second net that shows warnings on the approval page.

const RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /\bbest\b/i, message: 'Uses "best" (superlative claims are not allowed)' },
  { pattern: /\b(no\.?\s*1|number\s*one|#\s*1)\b/i, message: 'Claims to be "No. 1"' },
  { pattern: /\b(top|leading|finest|renowned|famous)\s+(doctor|surgeon|hospital|specialist|cardiologist)/i, message: 'Ranks the doctor/hospital ("top", "leading"…)' },
  { pattern: /\bguarantee(d|s)?\b/i, message: 'Promises a guaranteed result' },
  { pattern: /\b(cure[sd]?|curing)\b/i, message: 'Mentions a cure' },
  { pattern: /\b100\s*%/, message: 'Uses "100%"' },
  { pattern: /\b(permanent(ly)?\s+(relief|solution|fix)|miracle|magic)\b/i, message: 'Promises permanent/miraculous results' },
  { pattern: /\b(painless|risk[- ]free|no side effects?)\b/i, message: 'Promises no pain or no risk' },
  { pattern: /\b(success rate|\d+\s*\+?\s*(successful\s+)?(surgeries|operations|patients treated))\b/i, message: 'Quotes success rates or case counts' },
  { pattern: /\b(testimonial|review from|patient says|patients say|happy patients?|satisfied patients?)\b/i, message: 'Looks like a patient testimonial' },
  { pattern: /\b(cheapest|lowest (price|cost)|discount|free (consultation|check-?up))\b/i, message: 'Price promotion or inducement' },
];

export function complianceWarnings(text: string): string[] {
  return RULES.filter((r) => r.pattern.test(text)).map((r) => r.message);
}

export const CAPTION_RULES = `Rules you must follow (Indian NMC rules on medical advertising):
- Never use superlatives or rankings: no "best", "No. 1", "top", "leading", "renowned".
- Never promise results: no "cure", "guaranteed", "100%", "permanent relief", "painless", "risk-free".
- No patient testimonials, success rates, surgery counts, prices, discounts or free offers.
- Use ONLY the facts given. Do not invent qualifications, years of experience, awards, equipment, timings or prices.
- Informative, warm and calm. Encourage people to consult a doctor; do not give a diagnosis.
- Plain English that a general audience in Pune understands. 60-120 words. At most 3 emojis.
- Do not include hashtags, phone numbers or links; they are added automatically.`;
