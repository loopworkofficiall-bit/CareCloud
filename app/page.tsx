import styles from './page.module.css';
import { listPatients, listRecentCalls } from '@/lib/patients';

// Always read live -- a registration made thirty seconds ago must show up.
export const dynamic = 'force-dynamic';

type Search = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function formatPhone(v: unknown) {
  const d = String(v ?? '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || '--';
}

function formatWhen(v: unknown) {
  if (!v) return '--';
  return new Date(String(v)).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default async function Dashboard({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const filter = {
    last_name: one(q.last_name),
    phone_number: one(q.phone_number),
    date_of_birth: one(q.date_of_birth),
  };
  const filtered = Boolean(filter.last_name || filter.phone_number || filter.date_of_birth);

  let patients: Record<string, unknown>[] = [];
  let calls: Record<string, unknown>[] = [];
  let error: string | null = null;

  try {
    [patients, calls] = await Promise.all([
      listPatients(filter),
      listRecentCalls(5) as Promise<Record<string, unknown>[]>,
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Unknown database error';
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>CareCloud patient registry</h1>
          <p className={styles.subtitle}>Registrations captured by the voice intake agent.</p>
        </div>
        <span className={styles.count}>
          {error ? '--' : `${patients.length} ${patients.length === 1 ? 'patient' : 'patients'}`}
        </span>
      </header>

      {error ? (
        <div className={styles.error}>
          <strong>Cannot reach the database.</strong>
          <p>{error}</p>
          <p className={styles.dim}>
            Set <code>DATABASE_URL</code> and run <code>npm run db:setup</code>.
          </p>
        </div>
      ) : (
        <>
          <form className={styles.search}>
            <input className={styles.input} name="last_name" placeholder="Last name"
              defaultValue={filter.last_name ?? ''} />
            <input className={styles.input} name="phone_number" placeholder="Phone number"
              defaultValue={filter.phone_number ?? ''} />
            <input className={styles.input} name="date_of_birth" placeholder="DOB (MM/DD/YYYY)"
              defaultValue={filter.date_of_birth ?? ''} />
            <button className={styles.button} type="submit">Search</button>
            {filtered && <a className={styles.clear} href="/">Clear</a>}
          </form>

          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th><th>DOB</th><th>Sex</th><th>Phone</th>
                  <th>Address</th><th>Insurance</th><th>Language</th><th>Registered</th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr key={String(p.patient_id)}>
                    <td>{String(p.first_name)} {String(p.last_name)}</td>
                    <td className={styles.mono}>{String(p.date_of_birth)}</td>
                    <td>{String(p.sex)}</td>
                    <td className={styles.mono}>{formatPhone(p.phone_number)}</td>
                    <td>
                      {String(p.address_line_1)}
                      {p.address_line_2 ? `, ${p.address_line_2}` : ''}
                      {`, ${p.city}, ${p.state} ${p.zip_code}`}
                    </td>
                    <td className={p.insurance_provider ? undefined : styles.dim}>
                      {p.insurance_provider ? String(p.insurance_provider) : 'none'}
                    </td>
                    <td>{String(p.preferred_language ?? 'English')}</td>
                    <td className={styles.dim}>{formatWhen(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {patients.length === 0 && (
              <p className={styles.empty}>
                {filtered ? 'No patients match that search.' : 'No patients registered yet.'}
              </p>
            )}
          </div>

          {calls.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Recent calls</h2>
              {calls.map((c) => (
                <article key={String(c.call_id)} className={styles.call}>
                  <div className={styles.callMeta}>
                    <span>{formatWhen(c.created_at)}</span>
                    <span>{formatPhone(String(c.caller_number ?? '').replace(/\D/g, '').slice(-10))}</span>
                    {c.first_name ? <span>{String(c.first_name)} {String(c.last_name)}</span> : null}
                    {c.duration_secs ? <span>{String(c.duration_secs)}s</span> : null}
                    {c.ended_reason ? <span>{String(c.ended_reason)}</span> : null}
                  </div>
                  {c.summary ? <p>{String(c.summary)}</p> : null}
                  {c.transcript ? <pre className={styles.transcript}>{String(c.transcript)}</pre> : null}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
