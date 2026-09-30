import { config } from './config.ts';

/**
 * Optional, send-only WhatsApp alert through WATI: "a draft is waiting". Approval itself happens on the
 * web page, so this service never receives WhatsApp messages and stays separate from the booking bot.
 * Template text (submit in WATI): "New post draft ready for approval: {{1}}. Review it here: {{2}}"
 */
export async function alertDraftReady(title: string, reviewUrl: string): Promise<void> {
  if (!config.watiApiEndpoint || !config.watiApiToken || config.alertPhones.length === 0) return;
  for (const phone of config.alertPhones) {
    try {
      const res = await fetch(
        `${config.watiApiEndpoint}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${config.watiApiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            template_name: config.watiTemplateName,
            broadcast_name: 'social_draft_ready',
            parameters: [
              { name: '1', value: title.slice(0, 200) },
              { name: '2', value: reviewUrl },
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) console.warn(`[notify] WATI ${res.status} for ${phone.slice(-4).padStart(phone.length, '*')}`);
    } catch (err) {
      console.warn('[notify] WhatsApp alert failed:', (err as Error).message);
    }
  }
}
