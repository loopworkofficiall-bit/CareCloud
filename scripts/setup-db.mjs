#!/usr/bin/env node
// npm run db:setup
//
// Applies db/schema.sql and inserts two demo patients. Idempotent.
// Uses node-postgres rather than the Neon HTTP driver: the schema is a
// multi-statement script with a PL/pgSQL body, which the HTTP endpoint
// will not accept in a single request.
import { readFileSync } from 'node:fs';
import pg from 'pg';

try { process.loadEnvFile('.env.local'); } catch { /* CI passes real env vars */ }

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.');
  process.exit(1);
}

const SEED = [
  {
    first_name: 'Jane', last_name: 'Doe', date_of_birth: '1985-03-05', sex: 'Female',
    phone_number: '5125550142', email: 'jane.doe@example.com',
    address_line_1: '1200 Congress Ave', address_line_2: 'Apt 4B',
    city: 'Austin', state: 'TX', zip_code: '78701',
    insurance_provider: 'Blue Cross Blue Shield', insurance_member_id: 'BCBS 8842190',
    preferred_language: 'English',
    emergency_contact_name: 'Marcus Doe', emergency_contact_phone: '5125550188',
  },
  {
    first_name: 'Luis', last_name: 'Ortega', date_of_birth: '1972-11-19', sex: 'Male',
    phone_number: '4155550117', email: null,
    address_line_1: '88 Valencia St', address_line_2: null,
    city: 'San Francisco', state: 'CA', zip_code: '94103-1122',
    insurance_provider: null, insurance_member_id: null,
    preferred_language: 'Spanish',
    emergency_contact_name: null, emergency_contact_phone: null,
  },
];

const COLS = Object.keys(SEED[0]);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(readFileSync('db/schema.sql', 'utf8'));
  console.log('schema applied');

  let inserted = 0;
  for (const p of SEED) {
    const placeholders = COLS.map((_, i) => `$${i + 1}`).join(', ');
    // ON CONFLICT against the partial unique index makes re-runs a no-op.
    const res = await client.query(
      `INSERT INTO patients (${COLS.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (phone_number) WHERE deleted_at IS NULL DO NOTHING
       RETURNING patient_id`,
      COLS.map((c) => p[c]),
    );
    if (res.rowCount) inserted += 1;
  }
  console.log(`seed patients inserted: ${inserted} (${SEED.length - inserted} already present)`);

  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM patients WHERE deleted_at IS NULL',
  );
  console.log(`active patients in database: ${rows[0].n}`);
} finally {
  await client.end();
}
