import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Neon HTTP driver: one round-trip per query, no pool to babysit on serverless.
 *
 * The client is created lazily so that importing the service layer does not
 * require a database -- the validation tests import lib/patients.ts without a
 * DATABASE_URL, and `next build` should not fall over on a missing env var.
 */
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

/** Every call site goes through here, so nothing is ever string-concatenated. */
export const sql = {
  query: (text: string, params: unknown[] = []) => connection().query(text, params),
};
