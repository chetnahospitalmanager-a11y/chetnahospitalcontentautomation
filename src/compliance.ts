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

// Review replies are public. Confirming that someone was a patient, or mentioning their condition or
// treatment, breaches patient confidentiality even if the reviewer mentioned it first.
const REPLY_RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /\byour\s+(surgery|operation|treatment|diagnosis|condition|illness|disease|reports?|procedure|delivery|admission|stay|recovery|medication|prescription|bill|case)\b/i, message: 'Mentions the reviewer\'s own treatment or condition (patient confidentiality)' },
  { pattern: /\b(our|the)\s+records\s+(show|indicate)\b/i, message: 'Refers to hospital records about the reviewer' },
  { pattern: /\b(you|your\s+\w+)\s+(were|was)\s+(admitted|treated|operated|discharged|diagnosed)\b/i, message: 'Confirms the reviewer was treated here' },
  { pattern: /\b(fake|liar|lying|false review|defam)/i, message: 'Accuses the reviewer; keep replies calm and neutral' },
];

export function replyWarnings(text: string): string[] {
  return [...complianceWarnings(text), ...REPLY_RULES.filter((r) => r.pattern.test(text)).map((r) => r.message)];
}

export const REPLY_RULES_TEXT = `Rules you must follow:
- Patient confidentiality: never confirm the reviewer was a patient, and never mention any condition, treatment, test, surgery, bill or visit detail, even if the reviewer mentioned it.
- Never argue, blame, or call a review fake. Stay calm, polite and brief.
- For a complaint (1-3 stars): thank them, apologise that their experience fell short, say the feedback is being looked into, and invite them to contact the hospital directly so it can be resolved.
- For praise (4-5 stars): thank them warmly and briefly; you may say the feedback will be shared with the team.
- No superlatives ("best", "No. 1"), no promises of results, no offers or discounts.
- Plain English, 25-70 words, no hashtags, no links, at most 1 emoji. Address the reviewer by first name only if a name is given.
- Sign off as "Team {HOSPITAL}".`;

export const CAPTION_RULES = `Rules you must follow (Indian NMC rules on medical advertising):
- Never use superlatives or rankings: no "best", "No. 1", "top", "leading", "renowned".
- Never promise results: no "cure", "guaranteed", "100%", "permanent relief", "painless", "risk-free".
- No patient testimonials, success rates, surgery counts, prices, discounts or free offers.
- Use ONLY the facts given. Do not invent qualifications, years of experience, awards, equipment, timings or prices.
- Informative, warm and calm. Encourage people to consult a doctor; do not give a diagnosis.
- Plain English that a general audience in Pune understands. 60-120 words. At most 3 emojis.
- Do not include hashtags, phone numbers or links; they are added automatically.`;

export const COMMENT_CATEGORIES = ['question', 'booking', 'medical_question', 'praise', 'complaint', 'emergency', 'spam', 'other'] as const;
export type CommentCategory = (typeof COMMENT_CATEGORIES)[number];

export const COMMENT_RULES_TEXT = `Rules you must follow:
- Public reply on social media: 1-3 short sentences, at most 50 words, warm and polite. Reply in the same language as the comment (English, Hindi or Marathi).
- Never give medical advice, a diagnosis, medicine names or doses, even if asked. For health questions, say a doctor needs to see them and invite them to book a consultation.
- If the comment describes an emergency (chest pain, breathlessness, stroke signs, heavy bleeding, unconsciousness, accident), tell them to come to the emergency department immediately; it is open 24x7.
- Patient confidentiality: never confirm the commenter was a patient and never mention any condition, treatment, bill or visit detail.
- Never quote prices, timings or doctor availability unless they are in the facts. Ask them to contact the hospital instead.
- No superlatives ("best", "No. 1"), no promises of results, no offers or discounts. Never argue with a complaint: apologise and invite them to contact the hospital directly.
- No hashtags, no links, no phone numbers. Where booking helps, write the exact placeholder [BOOKING_LINK] as its own phrase, e.g. "You can book an appointment here: [BOOKING_LINK]".
- needs_reply = false for spam, abuse, tagging friends only, or a lone emoji/"nice"; still give a short friendly reply (or empty for spam) in case staff want to reply anyway.`;
