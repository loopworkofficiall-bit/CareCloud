// Coercion of speech-transcribed input into canonical storage form.
// Returns null when a value is unusable, so the caller can raise a
// field-specific error rather than storing a guess.

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
  'puerto rico': 'PR', 'virgin islands': 'VI', guam: 'GU',
};

export const US_STATES = new Set([...Object.values(STATE_NAMES), 'AS', 'MP']);

/** 10 bare digits, NANP-valid. Tolerates +1, punctuation and spacing. */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  // NANP: area code and exchange both start 2-9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return d;
}

/** ISO YYYY-MM-DD. Accepts MM/DD/YYYY (the spec's format) and YYYY-MM-DD. */
export function normalizeDob(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let y: number, m: number, d: number;

  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (us) [m, d, y] = [+us[1], +us[2], +us[3]];
  else if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else return null;

  // Round-trip through UTC: Date() silently rolls 02/31 into March.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (dt.getTime() > todayUtc) return null;                 // no future dates of birth
  if (y < now.getUTCFullYear() - 120) return null;          // sanity bound

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

const SEX_ALIASES: Record<string, string> = {
  m: 'Male', male: 'Male', man: 'Male', boy: 'Male',
  f: 'Female', female: 'Female', woman: 'Female', girl: 'Female',
  o: 'Other', other: 'Other', nonbinary: 'Other', 'non binary': 'Other',
  'non-binary': 'Other', x: 'Other',
  'decline to answer': 'Decline to Answer', decline: 'Decline to Answer',
  'prefer not to say': 'Decline to Answer', 'prefer not to answer': 'Decline to Answer',
  'rather not say': 'Decline to Answer', unspecified: 'Decline to Answer',
};

export function normalizeSex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return SEX_ALIASES[input.trim().toLowerCase()] ?? null;
}

export function normalizeState(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const abbr = s.toUpperCase().replace(/\./g, '');
  if (US_STATES.has(abbr)) return abbr;
  return STATE_NAMES[s.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

/** 5-digit or ZIP+4. Accepts 9 straight digits and re-inserts the hyphen. */
export function normalizeZip(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const d = String(input).replace(/[^\d]/g, '');
  if (d.length === 5) return d;
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return null;
}

/** Callers spell emails aloud: "jane at gmail dot com". */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!s.includes('@')) s = s.replace(/\s+at\s+/g, '@');
  s = s.replace(/\s+dot\s+/g, '.').replace(/\s+underscore\s+/g, '_').replace(/\s+/g, '');
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s) ? s : null;
}

// Letter range covers Latin-1 and Latin Extended-A so accented names survive.
export function normalizeName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 50) return null;
  return /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ' -]*$/.test(s) ? s : null;
}

/** Optional free text: "", "none", "skip" all mean "not provided". */
export function optionalText(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || /^(none|n\/a|na|skip|no|nothing|null|undefined)$/i.test(s)) return null;
  return s;
}
