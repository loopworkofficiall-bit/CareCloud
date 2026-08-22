import type { NextRequest } from 'next/server';
import {
  DuplicatePhoneError, createPatient, fieldErrors, findActiveByPhone, getPatient,
  isUuid, patientCreateSchema, patientUpdateSchema, saveCallRecord, updatePatient,
} from '@/lib/patients';
import { normalizePhone } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

/**
 * Vapi tool webhook.
 *
 * Vapi POSTs here whenever the assistant invokes one of its tools, and feeds
 * whatever string we return straight back into the model as the tool result.
 * So the shape of these replies is itself prompt engineering: a failed save
 * returns the exact list of bad fields, which is what lets the agent re-prompt
 * for the one field that was wrong instead of restarting the intake.
 *
 * Contract: { results: [{ toolCallId, result }] }
 */

type ToolCall = {
  id: string;
  function?: { name?: string; arguments?: unknown };
  name?: string;
  arguments?: unknown;
};

/** Vapi sends arguments as an object or as a JSON string, depending on model. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Everything the model sees is a string; JSON keeps it unambiguous. */
const say = (v: unknown) => JSON.stringify(v);

export async function POST(req: NextRequest) {
  // Shared-secret auth, set as a custom server header on the Vapi assistant,
  // so a leaked URL on its own cannot write to the database.
  const expected = process.env.VAPI_SERVER_SECRET;
  if (expected && req.headers.get('x-vapi-secret') !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const message = (payload.message ?? {}) as Record<string, unknown>;
  const call = (message.call ?? {}) as Record<string, unknown>;
  const callId = typeof call.id === 'string' ? call.id : undefined;
  const callerNumber =
    (call.customer as { number?: string } | undefined)?.number ??
    (message.customer as { number?: string } | undefined)?.number;

  const toolCalls = (message.toolCalls ?? message.toolCallList ?? []) as ToolCall[];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    // Vapi also delivers status-update and speech-update events to this URL.
    return Response.json({ results: [] });
  }

  const results = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name ?? tc.name ?? '';
    const args = parseArgs(tc.function?.arguments ?? tc.arguments);
    results.push({
      toolCallId: tc.id,
      result: await runTool(name, args, { callId, callerNumber }),
    });
  }

  return Response.json({ results });
}

type CallCtx = { callId?: string; callerNumber?: string };

async function runTool(name: string, args: Record<string, unknown>, ctx: CallCtx) {
  try {
    switch (name) {
      case 'lookup_patient':
        return await lookupPatient(args, ctx);
      case 'save_patient':
        return await savePatient(args, ctx);
      case 'update_patient':
        return await updatePatientTool(args, ctx);
      default:
        return say({ ok: false, error: `Unknown tool "${name}".` });
    }
  } catch (e) {
    console.error(`[vapi.tool.${name}]`, e);
    // The agent reads this and apologises to the caller rather than going silent.
    return say({
      ok: false,
      error: 'The records system is temporarily unavailable.',
      speak: 'Tell the caller you cannot reach the records system right now, '
        + 'that you have their details, and that someone will follow up shortly.',
    });
  }
}

/** Returning-caller detection. Defaults to the number the caller is dialling from. */
async function lookupPatient(args: Record<string, unknown>, ctx: CallCtx) {
  const phone = normalizePhone(args.phone_number ?? ctx.callerNumber);
  if (!phone) return say({ found: false, reason: 'No usable phone number to look up.' });

  const existing = await findActiveByPhone(phone);
  if (!existing) return say({ found: false });

  return say({
    found: true,
    patient_id: existing.patient_id,
    first_name: existing.first_name,
    last_name: existing.last_name,
    date_of_birth: existing.date_of_birth,
    city: existing.city,
    state: existing.state,
  });
}

async function savePatient(args: Record<string, unknown>, ctx: CallCtx) {
  // If the caller never spelled out a callback number, fall back to caller ID.
  if (args.phone_number === undefined && ctx.callerNumber) {
    args.phone_number = ctx.callerNumber;
  }

  const parsed = patientCreateSchema.safeParse(args);
  if (!parsed.success) {
    const invalid = fieldErrors(parsed.error);
    console.warn('[vapi.save_patient.invalid]', invalid);
    return say({
      ok: false,
      invalid,
      speak: 'Ask the caller again for only these fields, one at a time.',
    });
  }

  try {
    const patient = await createPatient(parsed.data);
    console.log('[patient.created]', {
      patient_id: patient.patient_id, source: 'voice', call_id: ctx.callId,
      payload: parsed.data,
    });
    await linkCall(ctx, String(patient.patient_id));
    return say({
      ok: true,
      patient_id: patient.patient_id,
      first_name: patient.first_name,
      speak: `Saved. Tell the caller they are all set, ${patient.first_name}, then end the call.`,
    });
  } catch (e) {
    if (e instanceof DuplicatePhoneError) {
      return say({
        ok: false,
        duplicate: true,
        patient_id: e.existing.patient_id,
        first_name: e.existing.first_name,
        last_name: e.existing.last_name,
        speak: 'A record already exists for this phone number. Offer to update it instead.',
      });
    }
    throw e;
  }
}

async function updatePatientTool(args: Record<string, unknown>, ctx: CallCtx) {
  const { patient_id, ...rest } = args;
  const id = String(patient_id ?? '');
  if (!isUuid(id)) return say({ ok: false, error: 'A valid patient_id is required to update.' });

  if (!(await getPatient(id))) return say({ ok: false, error: 'No active patient with that id.' });

  const parsed = patientUpdateSchema.safeParse(rest);
  if (!parsed.success) {
    const invalid = fieldErrors(parsed.error);
    return say({ ok: false, invalid, speak: 'Re-ask the caller for only these fields.' });
  }

  try {
    const patient = await updatePatient(id, parsed.data);
    if (!patient) return say({ ok: false, error: 'No active patient with that id.' });
    console.log('[patient.updated]', {
      patient_id: id, source: 'voice', call_id: ctx.callId, payload: parsed.data,
    });
    await linkCall(ctx, id);
    return say({ ok: true, patient_id: id, first_name: patient.first_name });
  } catch (e) {
    if (e instanceof DuplicatePhoneError) {
      return say({ ok: false, duplicate: true, patient_id: e.existing.patient_id });
    }
    throw e;
  }
}

/**
 * Stamp the call row now so the end-of-call webhook can attach the transcript
 * to the right patient. Best effort: never fail a registration over logging.
 */
async function linkCall(ctx: CallCtx, patientId: string) {
  if (!ctx.callId) return;
  try {
    await saveCallRecord({
      call_id: ctx.callId,
      patient_id: patientId,
      caller_number: ctx.callerNumber ?? null,
    });
  } catch (e) {
    console.error('[vapi.linkCall]', e);
  }
}
