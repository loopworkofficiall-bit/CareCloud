import { z } from 'zod';
import { sql } from './db.ts';
import {
  normalizeDob, normalizeEmail, normalizeName, normalizePhone,
  normalizeSex, normalizeState, normalizeZip, optionalText,
} from './normalize.ts';

/* ------------------------------------------------------------------ *
 * Validation
 *
 * One schema serves both the public REST API and the voice agent's tool
 * call. The agent is never trusted to validate -- it is only trusted to
 * *relay* the field-level errors produced here, so it can re-prompt for
 * exactly the field that failed rather than restarting the whole form.
 * ------------------------------------------------------------------ */

type Norm<T> = (v: unknown) => T | null;

/** Required field: run the normalizer, raise a speakable error if it fails. */
function required<T>(fn: Norm<T>, message: string) {
  return z.unknown().transform((v, ctx) => {
    const out = fn(v);
    if (out === null) {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return out;
  });
}

/**
 * Optional field: absent / blank / "none" all collapse to undefined, which
 * createPatient then omits from the INSERT so column defaults still apply.
 * The trailing .optional() is required -- Zod rejects a transform that
 * returns undefined unless the key itself is optional.
 */
function optional<T>(fn: Norm<T>, message: string) {
  return z.unknown().transform((v, ctx) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string' && optionalText(v) === null) return undefined;
    const out = fn(v);
    if (out === null) {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return out;
  }).optional();
}

const boundedText = (max: number): Norm<string> => (v) => {
  const s = optionalText(v);
  return s && s.length <= max ? s : null;
};

const memberId: Norm<string> = (v) => {
  const s = optionalText(v);
  return s && /^[A-Za-z0-9 -]{1,50}$/.test(s) ? s : null;
};

export const patientCreateSchema = z.object({
  first_name: required(normalizeName,
    'First name must be 1 to 50 letters. Hyphens and apostrophes are allowed.'),
  last_name: required(normalizeName,
    'Last name must be 1 to 50 letters. Hyphens and apostrophes are allowed.'),
  date_of_birth: required(normalizeDob,
    'Date of birth must be a real date in the past, in MM/DD/YYYY format.'),
  sex: required(normalizeSex,
    'Sex must be one of Male, Female, Other, or Decline to Answer.'),
  phone_number: required(normalizePhone,
    'Phone number must be a valid 10-digit US number including the area code.'),
  email: optional(normalizeEmail,
    'That email address does not look valid.'),
  address_line_1: required(boundedText(200),
    'Street address is required.'),
  address_line_2: optional(boundedText(200),
    'Address line 2 is too long.'),
  city: required(boundedText(100),
    'City is required and must be under 100 characters.'),
  state: required(normalizeState,
    'State must be a valid 2-letter US state abbreviation.'),
  zip_code: required(normalizeZip,
    'ZIP code must be 5 digits, or ZIP+4 such as 12345-6789.'),
  insurance_provider: optional(boundedText(100),
    'Insurance provider name is too long.'),
  insurance_member_id: optional(memberId,
    'Insurance member ID must be letters and numbers, up to 50 characters.'),
  preferred_language: optional(boundedText(50),
    'Preferred language is too long.'),
  emergency_contact_name: optional(boundedText(100),
    'Emergency contact name is too long.'),
  emergency_contact_phone: optional(normalizePhone,
    'Emergency contact phone must be a valid 10-digit US number.'),
});

/** PUT allows partial updates; each supplied field keeps its own validation. */
export const patientUpdateSchema = patientCreateSchema.partial();

export type PatientInput = z.infer<typeof patientCreateSchema>;

export function fieldErrors(err: z.ZodError): { field: string; message: string }[] {
  return err.issues.map((i) => ({
    field: i.path.length ? i.path.join('.') : '(body)',
    message: i.message,
  }));
}

export const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

/* ------------------------------------------------------------------ *
 * Service layer
 *
 * The REST routes and the Vapi tool webhook both call these functions,
 * so a record written by phone is byte-identical to one written by API.
 * ------------------------------------------------------------------ */

/** Fixed allow-list: nothing user-supplied ever reaches a column name. */
const WRITABLE = [
  'first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number', 'email',
  'address_line_1', 'address_line_2', 'city', 'state', 'zip_code',
  'insurance_provider', 'insurance_member_id', 'preferred_language',
  'emergency_contact_name', 'emergency_contact_phone',
] as const;

// date_of_birth is re-selected as text so JSON carries 1985-03-05 rather
// than a timezone-shifted ISO instant.
const COLUMNS = `patient_id, ${WRITABLE.join(', ')},
  to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
  created_at, updated_at, deleted_at`;

export type Patient = Record<string, unknown> & { patient_id: string };

export class DuplicatePhoneError extends Error {
  // Written out longhand rather than as a parameter property so that Node can
  // run this file directly under type stripping for the tests.
  existing: Patient;

  constructor(existing: Patient) {
    super('A patient with that phone number already exists.');
    this.name = 'DuplicatePhoneError';
    this.existing = existing;
  }
}

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

export async function listPatients(filter: {
  last_name?: string; date_of_birth?: string; phone_number?: string; limit?: number;
} = {}): Promise<Patient[]> {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  if (filter.last_name) {
    params.push(filter.last_name.trim().toLowerCase());
    where.push(`lower(last_name) = $${params.length}`);
  }
  if (filter.date_of_birth) {
    const dob = normalizeDob(filter.date_of_birth);
    if (!dob) return [];               // an unparseable filter matches nothing
    params.push(dob);
    where.push(`date_of_birth = $${params.length}::date`);
  }
  if (filter.phone_number) {
    const phone = normalizePhone(filter.phone_number);
    if (!phone) return [];
    params.push(phone);
    where.push(`phone_number = $${params.length}`);
  }

  params.push(Math.min(filter.limit ?? 100, 500));
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM patients WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows as Patient[];
}

export async function getPatient(id: string): Promise<Patient | null> {
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM patients WHERE patient_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (rows[0] as Patient) ?? null;
}

/** Duplicate detection for returning callers. */
export async function findActiveByPhone(phone: string): Promise<Patient | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM patients WHERE phone_number = $1 AND deleted_at IS NULL`,
    [normalized],
  );
  return (rows[0] as Patient) ?? null;
}

export async function createPatient(data: PatientInput): Promise<Patient> {
  const row = data as Record<string, unknown>;
  const keys = WRITABLE.filter((k) => row[k] !== undefined);
  const values = keys.map((k) => row[k]);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const rows = await sql.query(
      `INSERT INTO patients (${keys.join(', ')}) VALUES (${placeholders})
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] as Patient;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await findActiveByPhone(String(data.phone_number));
      if (existing) throw new DuplicatePhoneError(existing);
    }
    throw e;
  }
}

export async function updatePatient(
  id: string, data: Partial<PatientInput>,
): Promise<Patient | null> {
  const row = data as Record<string, unknown>;
  const keys = WRITABLE.filter((k) => row[k] !== undefined);
  if (!keys.length) return getPatient(id);

  const values: unknown[] = keys.map((k) => row[k]);
  const assignments = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  values.push(id);

  try {
    const rows = await sql.query(
      `UPDATE patients SET ${assignments}
       WHERE patient_id = $${values.length} AND deleted_at IS NULL
       RETURNING ${COLUMNS}`,
      values,
    );
    return (rows[0] as Patient) ?? null;
  } catch (e) {
    if (isUniqueViolation(e) && data.phone_number) {
      const existing = await findActiveByPhone(String(data.phone_number));
      if (existing) throw new DuplicatePhoneError(existing);
    }
    throw e;
  }
}

/** Soft delete only -- records are never removed. */
export async function softDeletePatient(id: string): Promise<Patient | null> {
  const rows = await sql.query(
    `UPDATE patients SET deleted_at = now()
     WHERE patient_id = $1 AND deleted_at IS NULL
     RETURNING ${COLUMNS}`,
    [id],
  );
  return (rows[0] as Patient) ?? null;
}

/** Written by the Vapi end-of-call webhook; a failure here never blocks a call. */
export async function saveCallRecord(rec: {
  call_id: string; patient_id?: string | null; caller_number?: string | null;
  ended_reason?: string | null; duration_secs?: number | null;
  summary?: string | null; transcript?: string | null;
}) {
  await sql.query(
    `INSERT INTO calls (call_id, patient_id, caller_number, ended_reason,
                        duration_secs, summary, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (call_id) DO UPDATE SET
       patient_id    = COALESCE(EXCLUDED.patient_id, calls.patient_id),
       caller_number = COALESCE(EXCLUDED.caller_number, calls.caller_number),
       ended_reason  = EXCLUDED.ended_reason,
       duration_secs = EXCLUDED.duration_secs,
       summary       = EXCLUDED.summary,
       transcript    = EXCLUDED.transcript`,
    [rec.call_id, rec.patient_id ?? null, rec.caller_number ?? null,
     rec.ended_reason ?? null, rec.duration_secs ?? null,
     rec.summary ?? null, rec.transcript ?? null],
  );
}

/** Recent call transcripts for the dashboard. */
export async function listRecentCalls(limit = 10) {
  return await sql.query(
    `SELECT c.call_id, c.caller_number, c.ended_reason, c.duration_secs,
            c.summary, c.transcript, c.created_at,
            p.first_name, p.last_name
       FROM calls c
       LEFT JOIN patients p ON p.patient_id = c.patient_id
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [Math.min(limit, 50)],
  );
}
