#!/usr/bin/env node
/**
 * Provisions the Vapi assistant from vapi/assistant.json + vapi/system-prompt.md,
 * pointing every tool and the server webhook at APP_URL.
 *
 *   npm run vapi:setup
 *
 * Creates on first run; pass VAPI_ASSISTANT_ID to update in place. Keeping this
 * in code means the prompt in the repo is the prompt that is actually live --
 * no copy-paste drift between the README and the dashboard.
 */
import { readFileSync } from 'node:fs';

try { process.loadEnvFile('.env.local'); } catch { /* CI passes real env vars */ }

const { VAPI_PRIVATE_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID, APP_URL, VAPI_SERVER_SECRET } = process.env;

if (!VAPI_PRIVATE_KEY) throw new Error('VAPI_PRIVATE_KEY is not set.');
if (!APP_URL) throw new Error('APP_URL is not set (e.g. https://carecloud.vercel.app).');
if (!/^https:\/\//.test(APP_URL)) throw new Error('APP_URL must be https -- Vapi will not call http.');

/** The system message is the slice between the SYSTEM MESSAGE heading and the design notes. */
function extractPrompt() {
  const md = readFileSync('vapi/system-prompt.md', 'utf8');
  const start = md.indexOf('## SYSTEM MESSAGE');
  const end = md.indexOf('## Design notes');
  if (start === -1 || end === -1) throw new Error('system-prompt.md is missing its markers.');
  return md.slice(start + '## SYSTEM MESSAGE'.length, end).replace(/^\s*|\s*-*\s*$/g, '').trim();
}

const headers = { 'x-vapi-secret': VAPI_SERVER_SECRET ?? '' };
const config = JSON.parse(readFileSync('vapi/assistant.json', 'utf8'));

// systemPromptFile is our own marker, not part of the Vapi schema -- swap it
// for the real message and point the tools at this deployment.
delete config.model.systemPromptFile;
config.model.messages = [{ role: 'system', content: extractPrompt() }];
config.model.tools = config.model.tools.map((t) => ({
  ...t,
  server: { url: `${APP_URL}/api/vapi/tools`, headers },
}));
config.server = { url: `${APP_URL}/api/vapi/events`, headers };

const api = async (path, method, body) => {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${text}`);
  return text ? JSON.parse(text) : {};
};

const assistant = VAPI_ASSISTANT_ID
  ? await api(`/assistant/${VAPI_ASSISTANT_ID}`, 'PATCH', config)
  : await api('/assistant', 'POST', config);

console.log(`assistant ${VAPI_ASSISTANT_ID ? 'updated' : 'created'}: ${assistant.id}`);
console.log(`  tools  -> ${APP_URL}/api/vapi/tools`);
console.log(`  events -> ${APP_URL}/api/vapi/events`);

if (VAPI_PHONE_NUMBER_ID) {
  const number = await api(`/phone-number/${VAPI_PHONE_NUMBER_ID}`, 'PATCH', {
    assistantId: assistant.id,
  });
  console.log(`phone number ${number.number ?? VAPI_PHONE_NUMBER_ID} now answers with this assistant`);
} else {
  console.log('\nVAPI_PHONE_NUMBER_ID not set -- attach the assistant to your number');
  console.log('in the Vapi dashboard, or set it and re-run.');
}

if (!VAPI_ASSISTANT_ID) {
  console.log(`\nAdd this to .env.local so future runs update instead of duplicating:`);
  console.log(`VAPI_ASSISTANT_ID=${assistant.id}`);
}
