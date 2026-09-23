/**
 * THE QUEUES, FROM THE PLATFORM'S SIDE (23 Sep 2026).
 *
 * Every tenant has its own queues, and its administrator sees and retries them
 * in its own console. Two queues belong to no tenant — backups and maintenance
 * (`maintenance`), self-analysis (`autoanalisi`) — and this is where they are
 * seen and retried. For the tenants, only the totals: which one has work
 * failing or piling up, without entering its console.
 *
 * In English, like the rest of this console (see TenantsPage.tsx).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, messaggio, type PlatformJob, type PlatformQueue, type QueueCounts, type TenantQueues } from './api'

const COLUMNS: ReadonlyArray<keyof QueueCounts> = ['waiting', 'active', 'delayed', 'failed', 'completed']

function Counts({ c }: { c: QueueCounts }) {
  return <>{COLUMNS.map((k) => <td key={k} className="num">{c[k].toLocaleString('en-GB')}</td>)}</>
}

function FailedJobs({ queue, onRetried, setErrore }: { queue: string; onRetried: () => void; setErrore: (m: string | null) => void }) {
  const [jobs, setJobs] = useState<PlatformJob[] | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  const load = useCallback(() => {
    api.failedJobs(queue).then((r) => setJobs(r.jobs)).catch((e: unknown) => setErrore(messaggio(e)))
  }, [queue, setErrore])
  useEffect(load, [load])

  const retry = (id: string) => {
    setRetrying(id)
    setErrore(null)
    api.retryJob(queue, id)
      .then(() => { load(); onRetried() })
      .catch((e: unknown) => setErrore(messaggio(e)))
      .finally(() => setRetrying(null))
  }

  if (jobs === null) return <p className="unknown">loading…</p>
  if (jobs.length === 0) return <p className="unknown">No failed job in {queue}.</p>
  return (
    <ul className="lavori" aria-label={`Failed jobs of ${queue}`}>
      {jobs.map((j) => (
        <li key={j.id}>
          <span className="riga">
            <span className="slug">{j.name}</span>
            <span className="unknown">{j.id}</span>
            <span>{j.attemptsMade}/{j.maxAttempts} attempts</span>
            <button onClick={() => retry(j.id)} disabled={retrying !== null}>Retry</button>
          </span>
          <div className="motivo">{j.failedReason ?? 'no reason recorded'}</div>
        </li>
      ))}
    </ul>
  )
}

export function QueuesPanel() {
  const [platform, setPlatform] = useState<PlatformQueue[] | null>(null)
  const [tenants, setTenants] = useState<TenantQueues[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)

  const load = useCallback(() => {
    api.queues()
      .then((r) => { setPlatform(r.platform); setTenants(r.tenants) })
      .catch((e: unknown) => setErrore(messaggio(e)))
  }, [])
  useEffect(load, [load])

  return (
    <section className="sezione" aria-labelledby="queues-title">
      <span className="riga">
        <h1 id="queues-title">Queues</h1>
        <button onClick={() => { setErrore(null); load() }}>Refresh</button>
      </span>
      <p className="lede">
        Two queues belong to the platform, not to a tenant: backups and maintenance (<code>maintenance</code>)
        and the self-analysis (<code>autoanalisi</code>). Every tenant has its own queues: its administrator sees
        and retries them in its console (Administration → Queues). Here, only their totals.
      </p>
      {errore && <div className="errore" role="alert">{errore}</div>}

      {platform === null ? <p className="unknown">loading…</p> : (
        <div className="scheda">
          <table aria-label="Platform queues">
            <thead>
              <tr>
                <th>Platform queue</th>
                {COLUMNS.map((k) => <th key={k} style={{ textAlign: 'right' }}>{k}</th>)}
                <th style={{ textAlign: 'right' }}>Failed jobs</th>
              </tr>
            </thead>
            <tbody>
              {platform.map((q) => (
                <tr key={q.name}>
                  <td>
                    <span className="slug">{q.name}</span>
                    {q.paused && <span className="pill suspended" style={{ marginLeft: 8 }}>paused</span>}
                  </td>
                  <Counts c={q.counts} />
                  <td className="num">
                    <button onClick={() => setOpen(open === q.name ? null : q.name)} disabled={q.counts.failed === 0} aria-expanded={open === q.name}>
                      {open === q.name ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <FailedJobs queue={open} onRetried={load} setErrore={setErrore} />}

      {platform !== null && (tenants.length === 0 ? <p className="unknown">No tenant has queues yet.</p> : (
        <div className="scheda" style={{ marginTop: 20 }}>
          <table aria-label="Tenant queues">
            <thead>
              <tr>
                <th>Tenant</th>
                {COLUMNS.map((k) => <th key={k} style={{ textAlign: 'right' }}>{k}</th>)}
                <th>Queues with failed jobs</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.tenantId} className={t.suspended ? 'suspended' : undefined}>
                  <td>
                    <span className="slug">{t.tenantId}</span>
                    {t.suspended && <span className="pill suspended" style={{ marginLeft: 8 }}>paused</span>}
                  </td>
                  <Counts c={t.counts} />
                  <td>
                    {t.failedQueues.length === 0
                      ? <span className="unknown">none</span>
                      : t.failedQueues.map((f) => `${f.name} (${f.failed.toLocaleString('en-GB')})`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  )
}
