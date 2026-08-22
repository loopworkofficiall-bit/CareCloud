import { NextResponse } from 'next/server';

/**
 * Every endpoint answers with the same envelope: { data, error }.
 * Kept apart from the service layer so lib/patients.ts stays importable
 * from plain Node (the tests) without dragging in next/server.
 */
export type FieldError = { field: string; message: string };

export function ok(data: unknown, status = 200) {
  return NextResponse.json({ data, error: null }, { status });
}

export function fail(message: string, status: number, fields?: FieldError[]) {
  return NextResponse.json(
    { data: null, error: { message, ...(fields?.length ? { fields } : {}) } },
    { status },
  );
}

/**
 * Unexpected failures: log the real cause for us, return a generic message
 * to the caller. Never leak a driver error string to the phone or the API.
 */
export function serverError(e: unknown, context: string) {
  console.error(`[${context}]`, e);
  return fail('Something went wrong on our end. Please try again.', 500);
}
