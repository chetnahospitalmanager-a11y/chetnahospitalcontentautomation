import { config } from '../config.ts';

export async function graph(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${config.metaGraphVersion}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: config.metaPageAccessToken });
  let res: Response;
  if (method === 'GET') {
    body.forEach((v, k) => url.searchParams.set(k, v));
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } else {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(60_000) });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok || json.error) {
    throw new Error(`Meta ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  }
  return json;
}

/** Photo post on the Facebook Page. Returns the post id. */
export async function postToFacebook(imageUrl: string, caption: string): Promise<string> {
  const r = await graph(`${config.metaPageId}/photos`, { url: imageUrl, message: caption, published: 'true' });
  return String(r.post_id ?? r.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Instagram publishing is two steps: create a media container, wait until Instagram has fetched the image, then publish. */
export async function postToInstagram(imageUrl: string, caption: string): Promise<string> {
  const container = await graph(`${config.metaIgUserId}/media`, { image_url: imageUrl, caption });
  const creationId = String(container.id);
  for (let i = 0; i < 15; i++) {
    const s = await graph(creationId, { fields: 'status_code' }, 'GET');
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram container ${s.status_code}`);
    await sleep(2000);
  }
  const published = await graph(`${config.metaIgUserId}/media_publish`, { creation_id: creationId });
  return String(published.id);
}
