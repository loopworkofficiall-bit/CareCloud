import { NextResponse } from 'next/server';

// Shared response envelope. Separate from the service layer so lib/patients.ts
// stays importable from plain Node without pulling in next/server.
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

// Log the real cause, return a generic message. Driver errors never reach
// the caller or the phone.
export function serverError(e: unknown, context: string) {
  console.error(`[${context}]`, e);
  return fail('Something went wrong on our end. Please try again.', 500);
}
