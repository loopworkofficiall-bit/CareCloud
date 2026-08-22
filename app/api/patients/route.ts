import type { NextRequest } from 'next/server';
import { fail, ok, serverError } from '@/lib/http';
import {
  DuplicatePhoneError, createPatient, fieldErrors, listPatients, patientCreateSchema,
} from '@/lib/patients';

// Patient data must never be served from a build-time cache.
export const dynamic = 'force-dynamic';

/** GET /patients?last_name=&date_of_birth=&phone_number=&limit= */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    const patients = await listPatients({
      last_name: q.get('last_name') ?? undefined,
      date_of_birth: q.get('date_of_birth') ?? undefined,
      phone_number: q.get('phone_number') ?? undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
    });
    return ok(patients);
  } catch (e) {
    return serverError(e, 'GET /patients');
  }
}

/** POST /patients */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('Request body must be valid JSON.', 400);
  }

  const parsed = patientCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail('Validation failed.', 422, fieldErrors(parsed.error));
  }

  try {
    const patient = await createPatient(parsed.data);
    console.log('[patient.created]', {
      patient_id: patient.patient_id, source: 'api',
    });
    return ok(patient, 201);
  } catch (e) {
    if (e instanceof DuplicatePhoneError) {
      return fail(e.message, 409, [
        { field: 'phone_number', message: 'This phone number is already registered.' },
      ]);
    }
    return serverError(e, 'POST /patients');
  }
}
