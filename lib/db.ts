import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

// Neon HTTP driver: one round-trip per query, no pool to manage on serverless.
// Created lazily so importing the service layer does not require a database
// (the tests do exactly that, and next build must not fail on a missing var).
let client: NeonQueryFunction<false, false> | null = null;

function connection() {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
    }
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

// All queries go through here, parameterised.
export const sql = {
  query: (text: string, params: unknown[] = []) => connection().query(text, params),
};
