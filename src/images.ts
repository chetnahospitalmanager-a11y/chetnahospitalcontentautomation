import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadHospital } from './hospital.ts';

// Instagram only accepts JPEG and aspect ratios between 1.91:1 and 4:5, so everything is served as 1080x1350.
export const WIDTH = 1080;
export const HEIGHT = 1350;

const IMAGE_DIR = fileURLToPath(new URL('../social-images/', import.meta.url));
const EXTS = ['jpg', 'jpeg', 'png', 'webp'];

export function findImageFile(imageKey: string, dir = IMAGE_DIR): string | null {
  const keys = [imageKey];
  if (imageKey.startsWith('hospital-')) keys.push('hospital');
  for (const key of keys) {
    for (const ext of EXTS) {
      const p = join(dir, `${key}.${ext}`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`;
  }
  return lines;
}

/** A plain branded card used when there is no real photo for a post. */
export function textCardSvg(title: string): string {
  const h = loadHospital().hospital;
  const lines = wrap(title, 18, 5);
  const startY = HEIGHT / 2 - ((lines.length - 1) * 95) / 2;
  const tspans = lines
    .map((l, i) => `<text x="540" y="${startY + i * 95}" font-size="76" font-weight="700" fill="#ffffff" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${escapeXml(l)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b5d6b"/><stop offset="1" stop-color="#083e48"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="60" y="60" width="960" height="1230" rx="36" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="4"/>
  ${tspans}
  <text x="540" y="1180" font-size="48" font-weight="700" fill="#ffffff" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${escapeXml(h.name)}</text>
  <text x="540" y="1240" font-size="34" fill="#cfe9ed" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${escapeXml(h.location)}</text>
</svg>`;
}

const cache = new Map<string, Buffer>();

/** 1080x1350 JPEG for a post: the real photo if there is one, otherwise a text card. */
export async function renderPostImage(imageKey: string, title: string): Promise<Buffer> {
  const cacheKey = `${imageKey}|${title}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const file = findImageFile(imageKey);
  const input = file ?? Buffer.from(textCardSvg(title));
  const out = await sharp(input)
    .rotate() // respect EXIF orientation from phone photos
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
  if (cache.size > 100) cache.clear();
  cache.set(cacheKey, out);
  return out;
}
