// One-time Google sign-in for Business Profile posting.
// Opens a sign-in link; sign in with the Gmail that owns (or manages) the profiles.
// The refresh token is written straight into .env as GBP_REFRESH_TOKEN and never printed.
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const clientId = process.env.GBP_CLIENT_ID;
const clientSecret = process.env.GBP_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GBP_CLIENT_ID and GBP_CLIENT_SECRET in .env first (Google Cloud → Credentials → OAuth client, type "Desktop app").');
  process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const state = randomBytes(16).toString('hex');
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/business.manage',
  access_type: 'offline',
  prompt: 'consent',
  state,
}).toString();

function saveToEnv(key, value) {
  const path = '.env';
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(path, text, { mode: 0o600 });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  if (url.searchParams.get('state') !== state) return res.writeHead(400).end('State mismatch; run the script again.');
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end(`Sign-in cancelled: ${url.searchParams.get('error') ?? 'no code'}`);
    server.close();
    process.exit(1);
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const json = await tokenRes.json();
  if (!json.refresh_token) {
    res.writeHead(500).end('Google did not return a refresh token. See the terminal.');
    console.error('No refresh token returned:', json.error ?? tokenRes.status, json.error_description ?? '');
    server.close();
    process.exit(1);
  }
  saveToEnv('GBP_REFRESH_TOKEN', json.refresh_token);
  res.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in. You can close this tab.');
  console.log('Saved GBP_REFRESH_TOKEN to .env. Next: npm run gbp:locations');
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this link in a browser on this computer and sign in with the Gmail that manages the profiles:\n');
  console.log(authUrl.toString());
});
