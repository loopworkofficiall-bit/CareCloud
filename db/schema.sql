-- CareCloud patient registration schema (PostgreSQL / Neon)
-- Constraints are duplicated in lib/patients.ts (Zod) on purpose:
-- Zod gives the voice agent field-level errors to re-prompt with,
-- the DB is the last line of defence for anything that bypasses it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS patients (
  patient_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  first_name              TEXT NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 50),
  last_name               TEXT NOT NULL CHECK (char_length(last_name)  BETWEEN 1 AND 50),
  date_of_birth           DATE NOT NULL CHECK (date_of_birth <= CURRENT_DATE),
  sex                     TEXT NOT NULL CHECK (sex IN ('Male','Female','Other','Decline to Answer')),

  -- Phones are stored as bare 10 digits (NANP). Formatting is a display concern.
  phone_number            CHAR(10) NOT NULL CHECK (phone_number ~ '^[2-9][0-9]{9}$'),
  email                   TEXT CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  address_line_1          TEXT NOT NULL CHECK (char_length(address_line_1) BETWEEN 1 AND 200),
  address_line_2          TEXT,
  city                    TEXT NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  state                   CHAR(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  zip_code                TEXT NOT NULL CHECK (zip_code ~ '^[0-9]{5}(-[0-9]{4})?$'),

  insurance_provider      TEXT,
  insurance_member_id     TEXT CHECK (insurance_member_id ~ '^[A-Za-z0-9 -]{1,50}$'),
  preferred_language      TEXT NOT NULL DEFAULT 'English',
  emergency_contact_name  TEXT,
  emergency_contact_phone CHAR(10) CHECK (emergency_contact_phone ~ '^[2-9][0-9]{9}$'),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ                      -- soft delete; never hard-delete
);

-- Duplicate detection: one active record per phone number.
-- Partial index so a soft-deleted patient does not block re-registration.
CREATE UNIQUE INDEX IF NOT EXISTS patients_active_phone_idx
  ON patients (phone_number) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS patients_last_name_idx ON patients (lower(last_name));
CREATE INDEX IF NOT EXISTS patients_dob_idx       ON patients (date_of_birth);

-- updated_at maintenance lives in the DB so every writer gets it, API or not.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS patients_touch_updated_at ON patients;
CREATE TRIGGER patients_touch_updated_at
  BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Call transcripts, written by the Vapi end-of-call webhook.
CREATE TABLE IF NOT EXISTS calls (
  call_id       TEXT PRIMARY KEY,
  patient_id    UUID REFERENCES patients(patient_id) ON DELETE SET NULL,
  caller_number TEXT,
  ended_reason  TEXT,
  duration_secs INTEGER,
  summary       TEXT,
  transcript    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_patient_idx ON calls (patient_id);
