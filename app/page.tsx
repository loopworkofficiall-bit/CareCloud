import styles from './page.module.css';
import { listPatients, listRecentCalls } from '@/lib/patients';

// Always read live; a registration from seconds ago must appear.
export const dynamic = 'force-dynamic';

const INTAKE_LINE = '+1 (843) 638-6075';

type Search = Promise<Record<string, string | string[] | undefined>>;
type Row = Record<string, unknown>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => (v == null ? '' : String(v));

function formatPhone(v: unknown) {
  const d = str(v).replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : str(v);
}

function formatWhen(v: unknown) {
  if (!v) return '';
  return new Date(str(v)).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function Field({ label, value, digits, wide }: {
  label: string; value: string | null; digits?: boolean; wide?: boolean;
}) {
  const classes = [digits ? styles.digits : '', value ? '' : styles.absent].join(' ').trim();
  return (
    <div className={wide ? styles.wide : undefined}>
      <dt>{label}</dt>
      <dd className={classes || undefined}>{value || 'Not provided'}</dd>
    </div>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const filter = {
    last_name: one(q.last_name),
    phone_number: one(q.phone_number),
    date_of_birth: one(q.date_of_birth),
  };
  const filtered = Boolean(filter.last_name || filter.phone_number || filter.date_of_birth);

  let patients: Row[] = [];
  let calls: Row[] = [];
  let error: string | null = null;

  try {
    [patients, calls] = await Promise.all([
      listPatients(filter),
      listRecentCalls(5) as Promise<Row[]>,
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Unknown database error';
  }

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <p className={styles.eyebrow}>CareCloud</p>
        <h1 className={styles.title}>Patient registry</h1>
        <p className={styles.lede}>
          Every record below was dictated over the phone to the voice intake line,
          validated, and written straight to Postgres.
        </p>
        <dl className={styles.meta}>
          <div>
            <dt>Intake line</dt>
            <dd>{INTAKE_LINE}</dd>
          </div>
          <div>
            <dt>{filtered ? 'Matching' : 'Registered'}</dt>
            <dd>{error ? '--' : String(patients.length).padStart(2, '0')}</dd>
          </div>
        </dl>
      </header>

      {error ? (
        <div className={styles.notice}>
          <strong>The registry cannot reach its database.</strong>
          <p>{error}</p>
          <p>Set <code>DATABASE_URL</code>, then run <code>npm run db:setup</code>.</p>
        </div>
      ) : (
        <>
          <form className={styles.filters}>
            <input className={styles.input} name="last_name" placeholder="Last name"
              defaultValue={filter.last_name ?? ''} aria-label="Last name" />
            <input className={styles.input} name="phone_number" placeholder="Phone number"
              defaultValue={filter.phone_number ?? ''} aria-label="Phone number" />
            <input className={styles.input} name="date_of_birth" placeholder="Date of birth"
              defaultValue={filter.date_of_birth ?? ''} aria-label="Date of birth" />
            <button className={styles.button} type="submit">Search</button>
            {filtered && <a className={styles.clear} href="/">Clear</a>}
          </form>

          {patients.length === 0 ? (
            <p className={styles.empty}>
              <strong>{filtered ? 'No records match that search.' : 'No registrations yet.'}</strong>
              {filtered ? 'Try a different name, number, or date of birth.'
                : `Call ${INTAKE_LINE} and the record will appear here.`}
            </p>
          ) : (
            <ol className={styles.records}>
              {patients.map((p) => (
                <li key={str(p.patient_id)} className={styles.record}>
                  <div className={styles.rail}>
                    <span className={styles.railLabel}>Phone</span>
                    <span className={styles.railPhone}>{formatPhone(p.phone_number)}</span>
                    <span className={styles.railNote}>Registered {formatWhen(p.created_at)}</span>
                  </div>
                  <div>
                    <h2 className={styles.name}>{str(p.first_name)} {str(p.last_name)}</h2>
                    <dl className={styles.fields}>
                      <Field label="Date of birth" value={str(p.date_of_birth)} digits />
                      <Field label="Sex" value={str(p.sex)} />
                      <Field label="Language" value={str(p.preferred_language)} />
                      <Field label="Insurance" value={str(p.insurance_provider) || null} />
                      <Field label="Member ID" value={str(p.insurance_member_id) || null} digits />
                      <Field label="Emergency contact" value={str(p.emergency_contact_name) || null} />
                      <Field label="Address" wide value={[
                        str(p.address_line_1),
                        str(p.address_line_2),
                        `${str(p.city)}, ${str(p.state)} ${str(p.zip_code)}`,
                      ].filter(Boolean).join(', ')} />
                    </dl>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {calls.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Recent calls</h2>
              {calls.map((c) => (
                <article key={str(c.call_id)} className={styles.call}>
                  <div className={styles.callMeta}>
                    <span>{formatWhen(c.created_at)}</span>
                    {c.caller_number ? <span>{formatPhone(c.caller_number)}</span> : null}
                    {c.first_name ? <span>{str(c.first_name)} {str(c.last_name)}</span> : null}
                    {c.duration_secs ? <span>{str(c.duration_secs)}s</span> : null}
                    {c.ended_reason ? <span>{str(c.ended_reason)}</span> : null}
                  </div>
                  {c.summary ? <p className={styles.callSummary}>{str(c.summary)}</p> : null}
                  {c.transcript ? <pre className={styles.transcript}>{str(c.transcript)}</pre> : null}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
