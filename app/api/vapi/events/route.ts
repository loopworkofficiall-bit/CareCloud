import type { NextRequest } from 'next/server';
import { findActiveByPhone, saveCallRecord } from '@/lib/patients';

export const dynamic = 'force-dynamic';

/* Vapi server events. Only end-of-call-report is handled; it carries the
 * transcript and the reason the call ended, including pipeline errors,
 * silence timeouts and mid-registration hangups. Everything else is
 * acknowledged and ignored. */
export async function POST(req: NextRequest) {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (expected && req.headers.get('x-vapi-secret') !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ received: false }, { status: 400 });
  }

  const message = (payload.message ?? {}) as Record<string, unknown>;
  if (message.type !== 'end-of-call-report') return Response.json({ received: true });

  const call = (message.call ?? {}) as Record<string, unknown>;
  const callId = typeof call.id === 'string' ? call.id : undefined;
  if (!callId) return Response.json({ received: true });

  const callerNumber =
    (call.customer as { number?: string } | undefined)?.number ??
    (message.customer as { number?: string } | undefined)?.number ?? null;

  // A completed registration already stamped patient_id during the call.
  // If the caller hung up first, match on number so the transcript still lands.
  let patientId: string | null = null;
  if (callerNumber) {
    const existing = await findActiveByPhone(callerNumber).catch(() => null);
    patientId = existing ? String(existing.patient_id) : null;
  }

  const transcript = typeof message.transcript === 'string' ? message.transcript : null;
  const summary = typeof message.summary === 'string' ? message.summary : null;
  const endedReason = typeof message.endedReason === 'string' ? message.endedReason : null;
  const duration = typeof message.durationSeconds === 'number'
    ? Math.round(message.durationSeconds) : null;

  console.log('[call.ended]', {
    call_id: callId, ended_reason: endedReason, duration_secs: duration,
    patient_id: patientId,
  });

  try {
    await saveCallRecord({
      call_id: callId,
      patient_id: patientId,
      caller_number: callerNumber,
      ended_reason: endedReason,
      duration_secs: duration,
      summary,
      transcript,
    });
  } catch (e) {
    console.error('[vapi.events]', e);   // never 500 back at Vapi over a log write
  }

  return Response.json({ received: true });
}
