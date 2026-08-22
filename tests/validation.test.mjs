import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDob, normalizeEmail, normalizeName, normalizePhone,
  normalizeSex, normalizeState, normalizeZip,
} from '../lib/normalize.ts';
import { patientCreateSchema, fieldErrors } from '../lib/patients.ts';

test('phone numbers survive however the transcriber formats them', () => {
  for (const input of ['(512) 555-0142', '512-555-0142', '512 555 0142', '+1 512 555 0142', '15125550142']) {
    assert.equal(normalizePhone(input), '5125550142', `failed on ${input}`);
  }
});

test('phone numbers that cannot be dialled are rejected', () => {
  assert.equal(normalizePhone('555'), null);          // the brief calls this out
  assert.equal(normalizePhone('123-4567'), null);
  assert.equal(normalizePhone('0125550142'), null);   // area code cannot start with 0
  assert.equal(normalizePhone(''), null);
});

test('dates of birth accept both spoken and ISO formats', () => {
  assert.equal(normalizeDob('03/05/1985'), '1985-03-05');
  assert.equal(normalizeDob('3/5/1985'), '1985-03-05');
  assert.equal(normalizeDob('1985-03-05'), '1985-03-05');
});

test('impossible and future dates of birth are rejected', () => {
  const nextYear = new Date().getUTCFullYear() + 1;
  assert.equal(normalizeDob(`01/01/${nextYear}`), null);  // the brief calls this out
  assert.equal(normalizeDob('02/31/1990'), null);         // would silently roll to March
  assert.equal(normalizeDob('13/01/1990'), null);
  assert.equal(normalizeDob('sometime in the eighties'), null);
});

test('states arrive as names or abbreviations', () => {
  assert.equal(normalizeState('texas'), 'TX');
  assert.equal(normalizeState('New York'), 'NY');
  assert.equal(normalizeState('tx'), 'TX');
  assert.equal(normalizeState('Freedonia'), null);
});

test('zip codes keep ZIP+4 and reject the wrong length', () => {
  assert.equal(normalizeZip('78701'), '78701');
  assert.equal(normalizeZip('941031122'), '94103-1122');
  assert.equal(normalizeZip('94103-1122'), '94103-1122');
  assert.equal(normalizeZip('787'), null);
});

test('emails spelled aloud are reassembled', () => {
  assert.equal(normalizeEmail('jane dot doe at example dot com'), 'jane.doe@example.com');
  assert.equal(normalizeEmail('  Jane.Doe@Example.com '), 'jane.doe@example.com');
  assert.equal(normalizeEmail('not an email'), null);
});

test('names allow hyphens and apostrophes but not digits', () => {
  assert.equal(normalizeName("O'Brien"), "O'Brien");
  assert.equal(normalizeName('Mary-Jane'), 'Mary-Jane');
  assert.equal(normalizeName('  Luis   Ortega '), 'Luis Ortega');
  assert.equal(normalizeName('Patient 42'), null);
});

test('sex accepts what people actually say', () => {
  assert.equal(normalizeSex('female'), 'Female');
  assert.equal(normalizeSex('M'), 'Male');
  assert.equal(normalizeSex('prefer not to say'), 'Decline to Answer');
  assert.equal(normalizeSex('yes'), null);
});

const VALID = {
  first_name: 'Jane', last_name: 'Doe', date_of_birth: '03/05/1985', sex: 'female',
  phone_number: '(512) 555-0142', address_line_1: '1200 Congress Ave',
  city: 'Austin', state: 'texas', zip_code: '78701',
};

test('a messy but valid payload is normalized for storage', () => {
  const parsed = patientCreateSchema.safeParse(VALID);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.date_of_birth, '1985-03-05');
  assert.equal(parsed.data.phone_number, '5125550142');
  assert.equal(parsed.data.state, 'TX');
  assert.equal(parsed.data.sex, 'Female');
  assert.equal(parsed.data.email, undefined);          // optional, not supplied
});

test('optional fields opt in without breaking the required ones', () => {
  const parsed = patientCreateSchema.safeParse({
    ...VALID, email: 'jane at example dot com', insurance_provider: 'none',
    emergency_contact_phone: '512-555-0188',
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.email, 'jane@example.com');
  assert.equal(parsed.data.insurance_provider, undefined);   // "none" means not provided
  assert.equal(parsed.data.emergency_contact_phone, '5125550188');
});

test('only the bad fields come back, which is what the agent re-prompts on', () => {
  const parsed = patientCreateSchema.safeParse({
    ...VALID, phone_number: '555', date_of_birth: '01/01/2099',
  });
  assert.ok(!parsed.success);
  const bad = fieldErrors(parsed.error).map((f) => f.field).sort();
  assert.deepEqual(bad, ['date_of_birth', 'phone_number']);
});

test('missing required fields are reported individually', () => {
  const parsed = patientCreateSchema.safeParse({ first_name: 'Jane' });
  assert.ok(!parsed.success);
  const bad = fieldErrors(parsed.error).map((f) => f.field);
  assert.ok(bad.includes('last_name'));
  assert.ok(bad.includes('zip_code'));
  assert.ok(!bad.includes('first_name'));
});
