import { bookingLink, config } from './config.ts';
import { CAPTION_RULES, REPLY_RULES_TEXT } from './compliance.ts';
import { loadHospital } from './hospital.ts';
import type { Topic } from './topics.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGeminiRaw(system: string, prompt: string, schema: Record<string, unknown> | null): Promise<string> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
  const generationConfig: Record<string, unknown> = { temperature: 0.8 };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  const res = await fetch(`${API}/${encodeURIComponent(config.geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
}

async function callGemini(system: string, prompt: string, json: boolean): Promise<string> {
  const schema = { type: 'OBJECT', properties: { caption: { type: 'STRING' } }, required: ['caption'] };
  const text = await callGeminiRaw(system, prompt, json ? schema : null);
  if (!json) return text;
  try {
    return String((JSON.parse(text) as { caption?: unknown }).caption ?? '').trim();
  } catch {
    return '';
  }
}

/** Structured answer from Gemini following `schema`; throws if it isn't valid JSON. */
export async function generateJson<T>(system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const text = await callGeminiRaw(system, prompt, schema);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Gemini did not return valid JSON');
  }
}

/** Ask for JSON (reliable output), fall back to plain text if the JSON came back empty. */
async function generate(system: string, prompt: string): Promise<string> {
  let caption = await callGemini(system, prompt, true);
  if (!caption) caption = await callGemini(system, `${prompt}\n\nReply with the caption text only.`, false);
  if (!caption) throw new Error('Gemini returned an empty caption');
  return cleanCaption(caption);
}

/** Remove anything the footer adds, in case the model ignored the rule. */
export function cleanCaption(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#\w+\s*)+$/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function systemPrompt(): string {
  const h = loadHospital().hospital;
  return `You write social media captions for ${h.name}, ${h.location}.
Hospital facts: ${h.facts.join('; ')}.

${CAPTION_RULES}`;
}

export async function writeCaption(topic: Topic): Promise<string> {
  const prompt = `Write one Facebook/Instagram caption.
Post type: ${topic.kind}
Subject: ${topic.title}
Facts you may use:
${topic.facts.map((f) => `- ${f}`).join('\n')}`;
  return generate(systemPrompt(), prompt);
}

export async function reviseCaption(topic: Topic, current: string, feedback: string): Promise<string> {
  const prompt = `Here is a draft caption:
"""
${current}
"""
Rewrite it following this feedback from hospital staff: ${feedback.trim().slice(0, 1000)}
The rules above still apply. Facts you may use:
${topic.facts.map((f) => `- ${f}`).join('\n')}`;
  return generate(systemPrompt(), prompt);
}

export interface ReviewForReply {
  reviewer: string;
  rating: number;
  comment: string;
  profileTitle: string;
}

function replySystemPrompt(): string {
  const h = loadHospital().hospital;
  const contact = config.reviewContactLine ? `\nWhen inviting them to get in touch, use exactly: "${config.reviewContactLine}"` : '';
  return `You write public owner replies to Google reviews for ${h.name}, ${h.location}.
${REPLY_RULES_TEXT.replace('{HOSPITAL}', h.shortName)}${contact}`;
}

function reviewPrompt(r: ReviewForReply): string {
  return `Google profile: ${r.profileTitle}
Reviewer name: ${r.reviewer}
Rating: ${r.rating} of 5 stars
Review text: ${r.comment ? `"""${r.comment.slice(0, 3000)}"""` : '(no text, star rating only)'}`;
}

export async function writeReviewReply(r: ReviewForReply): Promise<string> {
  return generate(replySystemPrompt(), `Write the owner reply to this review.\n${reviewPrompt(r)}`);
}

export async function reviseReviewReply(r: ReviewForReply, current: string, feedback: string): Promise<string> {
  return generate(
    replySystemPrompt(),
    `${reviewPrompt(r)}

Current draft reply:
"""
${current}
"""
Rewrite it following this feedback from hospital staff: ${feedback.trim().slice(0, 1000)}
The rules above still apply.`,
  );
}

/** Caption as published on Facebook/Instagram: body + booking footer + hashtags. */
export function socialCaption(body: string): string {
  const h = loadHospital().hospital;
  const lines = [body.trim(), ''];
  const link = bookingLink();
  if (link) lines.push(`📲 Book on WhatsApp: ${link}`);
  if (config.bookingPhoneDisplay) lines.push(`📞 ${config.bookingPhoneDisplay}`);
  if (h.hashtags.length) lines.push('', h.hashtags.join(' '));
  return lines.join('\n').trim();
}

/**
 * Text for a Google Business Profile post. Google rejects posts containing phone numbers,
 * so phone numbers, hashtags and links are stripped; booking goes through the BOOK button.
 * Max 1500 characters.
 */
export function gbpSummary(body: string): string {
  const text = body
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .replace(/(\+?\d[\d\s-]{7,}\d)/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 1500 ? `${text.slice(0, 1497).trimEnd()}...` : text;
}
