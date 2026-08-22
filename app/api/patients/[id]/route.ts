import type { NextRequest } from 'next/server';
import { fail, ok, serverError } from '@/lib/http';
import {
  DuplicatePhoneError, fieldErrors, getPatient, isUuid,
  patientUpdateSchema, softDeletePatient, updatePatient,
} from '@/lib/patients';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /patients/:id */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return fail('patient_id must be a UUID.', 400);
  try {
    const patient = await getPatient(id);
    return patient ? ok(patient) : fail('Patient not found.', 404);
  } catch (e) {
    return serverError(e, 'GET /patients/:id');
  }
}

/** PUT /patients/:id -- partial updates allowed. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return fail('patient_id must be a UUID.', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('Request body must be valid JSON.', 400);
  }

  const parsed = patientUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail('Validation failed.', 422, fieldErrors(parsed.error));
  }

  try {
    const patient = await updatePatient(id, parsed.data);
    if (!patient) return fail('Patient not found.', 404);
    console.log('[patient.updated]', { patient_id: id, source: 'api' });
    return ok(patient);
  } catch (e) {
    if (e instanceof DuplicatePhoneError) {
      return fail(e.message, 409, [
        { field: 'phone_number', message: 'This phone number belongs to another patient.' },
      ]);
    }
    return serverError(e, 'PUT /patients/:id');
  }
}

/** DELETE /patients/:id -- soft delete, sets deleted_at. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return fail('patient_id must be a UUID.', 400);
  try {
    const patient = await softDeletePatient(id);
    if (!patient) return fail('Patient not found.', 404);
    console.log('[patient.deleted]', { patient_id: id, soft: true });
    return ok(patient);
  } catch (e) {
    return serverError(e, 'DELETE /patients/:id');
  }
}
