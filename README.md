# CareCloud — Voice AI Patient Registration

A phone number you can call. An AI intake coordinator answers, collects your
demographics in natural conversation, reads them back, and writes them to
Postgres. A REST API and a dashboard expose what it captured.

Built for the CareCloud take-home assessment. Every service used is on a free
tier — no card was entered anywhere.

## Live

| | |
|---|---|
| **Phone number** | `+1 (___) ___-____` |
| **API base URL** | `https://________.vercel.app` |
| **Dashboard** | `https://________.vercel.app` |
| **Repository** | `https://github.com/________` |

No credentials are needed to test. The API is intentionally open for review;
see [Security](#security) for what that means and what is actually protected.

## Architecture

```
  Caller
    │  PSTN
    ▼
  Vapi  ── Deepgram Nova-3 (STT) · Gemini 2.5 Flash (LLM) · Vapi TTS
    │
    │  HTTPS tool calls + end-of-call webhook  (x-vapi-secret)
    ▼
  Next.js on Vercel
    ├── /api/vapi/tools     lookup_patient · save_patient · update_patient
    ├── /api/vapi/events    end-of-call transcript
    ├── /api/patients       REST CRUD
    └── /                   dashboard
    │
    │  parameterised SQL over HTTPS
    ▼
  Neon Postgres
```

The important line is the one that is *not* in the diagram: there is no second
validation path. `lib/patients.ts` holds one Zod schema and one service layer,
and both the REST API and the voice agent go through them. A record created by
phone is byte-identical to one created by `curl`.

### How the agent and the database actually talk

The voice agent is not trusted to validate anything. It calls `save_patient`,
the webhook runs the same schema the REST endpoint runs, and on failure returns:

```json
{ "ok": false,
  "invalid": [{ "field": "phone_number",
                "message": "Phone number must be a valid 10-digit US number including the area code." }],
  "speak": "Ask the caller again for only these fields, one at a time." }
```

Vapi feeds that string straight back to the model, so the agent re-prompts for
the one field that failed instead of restarting the intake. That is the whole
trick: **conversational error recovery is a property of the API response, not of
the prompt.** The prompt only has to be told to obey it.

## Tech stack, and why

| Layer | Choice | Why this one |
|---|---|---|
| Telephony + STT/TTS | **Vapi** | Free Vapi-owned US numbers, $10 signup credit, no card. Twilio's trial is unusable here — since their policy change, inbound calls to a trial number are rejected unless the caller's number is pre-verified, so a reviewer could not dial it. |
| LLM | **Gemini 2.5 Flash** (BYOK) | Free tier, and fast enough that turn latency stays conversational. Brought as our own key so Vapi credit is spent only on telephony. |
| Backend + dashboard | **Next.js on Vercel** | One repo, one deploy, API routes and the dashboard together. Render's free tier sleeps after 15 minutes and cold-starts for ~50s — long enough to time out a tool call mid-conversation, which would be a live failure during review. |
| Database | **Neon Postgres** | Free tier, real constraints and a real UUID type, wakes from idle in under a second. SQLite would have been simpler but Vercel's filesystem is ephemeral, so it would not survive the "call back and the data is still there" requirement. |
| Validation | **Zod** | One schema, two consumers, field-level errors that are already written as speakable sentences. |

## Project layout

```
app/
  page.tsx                    dashboard (server component)
  api/patients/route.ts       GET list · POST create
  api/patients/[id]/route.ts  GET · PUT · DELETE (soft)
  api/vapi/tools/route.ts     voice agent tool webhook
  api/vapi/events/route.ts    end-of-call transcript webhook
lib/
  normalize.ts                voice input coercion (phones, dates, states, emails)
  patients.ts                 Zod schema + service layer
  db.ts                       Neon client
  http.ts                     { data, error } envelope
db/schema.sql                 DDL, constraints, indexes, trigger
vapi/
  system-prompt.md            the agent's system message, with design notes
  assistant.json              assistant + tool definitions
scripts/
  setup-db.mjs                apply schema + seed
  vapi-setup.mjs              provision the assistant from the files above
tests/validation.test.mjs     13 tests, no framework
```

## Setup

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL at minimum
npm run db:setup               # applies db/schema.sql, seeds 2 demo patients
npm run dev
```

Deploy, then point Vapi at it:

```bash
vercel --prod                  # or push to GitHub and import at vercel.com
npm run vapi:setup             # creates the assistant, wires both webhooks
```

`vapi:setup` reads `vapi/assistant.json` and injects the system message from
`vapi/system-prompt.md`, so the prompt in the repo is always the prompt that is
live. Re-run it after any prompt edit; set `VAPI_ASSISTANT_ID` first so it
updates in place instead of creating a duplicate.

If `npm run db:setup` cannot reach Neon from your network, paste
`db/schema.sql` into the Neon SQL editor — it is plain DDL and idempotent.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled connection string |
| `APP_URL` | for `vapi:setup` | Public https base URL of the deployment |
| `VAPI_SERVER_SECRET` | recommended | Shared secret Vapi sends as `x-vapi-secret` |
| `VAPI_PRIVATE_KEY` | for `vapi:setup` | Vapi API key |
| `VAPI_ASSISTANT_ID` | after first run | Update the assistant instead of duplicating |
| `VAPI_PHONE_NUMBER_ID` | optional | Attaches the number to the assistant automatically |

Nothing is hardcoded; `.env.local` is gitignored.

## API

All responses use `{ "data": ..., "error": null }`. Errors carry
`{ "data": null, "error": { "message": "...", "fields": [...] } }`.

```bash
# list, with optional filters
curl "$API/api/patients?last_name=Doe"
curl "$API/api/patients?phone_number=512-555-0142"
curl "$API/api/patients?date_of_birth=03/05/1985"

# create
curl -X POST "$API/api/patients" -H 'content-type: application/json' -d '{
  "first_name":"Jane","last_name":"Doe","date_of_birth":"03/05/1985",
  "sex":"Female","phone_number":"(512) 555-0142",
  "address_line_1":"1200 Congress Ave","city":"Austin",
  "state":"texas","zip_code":"78701"}'

# read, partial update, soft delete
curl "$API/api/patients/$ID"
curl -X PUT "$API/api/patients/$ID" -H 'content-type: application/json' \
  -d '{"city":"Dallas","state":"TX"}'
curl -X DELETE "$API/api/patients/$ID"
```

| Status | When |
|---|---|
| 200 / 201 | success |
| 400 | malformed JSON, or a `patient_id` that is not a UUID |
| 404 | no active patient with that id |
| 409 | phone number already registered (returns the existing patient to the agent) |
| 422 | validation failed — `error.fields` names each bad field |
| 500 | unexpected; the real cause is logged, never returned |

Inputs are normalised before storage, so `"texas"` becomes `TX`,
`"(512) 555-0142"` becomes `5125550142`, `"03/05/1985"` becomes `1985-03-05`.

## Edge cases handled

| Case | Behaviour |
|---|---|
| 3-digit phone number | Rejected by NANP rules; agent re-asks for that field only |
| Future date of birth | Rejected; so is `02/31/1990`, which naive parsers roll into March |
| Caller corrects a spelling mid-call | Prompt instructs single-field correction, then resumes |
| Caller asks to start over | Prompt discards collected state and restarts |
| Duplicate phone number | Partial unique index raises 23505; agent offers to update the existing record |
| Database write fails | Agent is handed a `speak` string and tells the caller; it never goes silent or claims a false save |
| Call drops mid-registration | Nothing is written before confirmation; the end-of-call webhook still stores the transcript |
| Caller speaks Spanish | Transcriber is set to multilingual; prompt switches language and records the preference |

## Security

- No secrets in source. Everything is read from the environment.
- Both webhooks require the `x-vapi-secret` shared header.
- Every query is parameterised, and column names come from a fixed allow-list —
  user input never reaches SQL as an identifier.
- Soft delete only. `DELETE` sets `deleted_at`; rows are never removed.
- The REST API is deliberately unauthenticated so reviewers can test it without
  credentials. Real deployment would put auth in front of `/api/patients`.
- No real patient data is stored. The seed records are fictional.

## Tests

```bash
npm test
```

13 tests over the validation layer, run by the built-in Node test runner — no
framework. They cover what the phone actually breaks: mangled phone numbers,
impossible dates, spelled-out emails, state names instead of abbreviations, and
the guarantee that a bad payload returns errors for *only* the bad fields.

## Trade-offs and known limitations

- **The dashboard is read-only.** Editing belongs to the API; a form would have
  been build time spent on the least-weighted requirement.
- **No auth on the REST API.** Deliberate, so the reviewer can call it. Called
  out above rather than hidden.
- **One patient per phone number.** Real households share numbers; the right
  model is a household with members, which is more schema than three hours buys.
- **Transcripts are stored as plain text** on the `calls` table, not a
  structured turn-by-turn log.
- **No retry on a failed database write.** The agent tells the caller honestly
  rather than silently dropping the registration, but the data is not queued.
- **Appointment scheduling was not built.** It was the bonus with the least
  signal per minute of build time.

## Next steps

1. API-key auth on `/api/patients`, keeping the Vapi webhooks on their own secret.
2. Queue failed writes so a database blip does not cost a completed intake.
3. Structured transcripts with per-turn timestamps, linked to the patient record.
4. Household model so family members can share a callback number.
5. Automated evaluation of the agent — scripted calls asserting that corrections,
   invalid input, and duplicate detection still behave after a prompt change.
