/**
 * THE GRAPH'S INTEGRITY, FROM THE PLATFORM'S SIDE (wave 7 · A3, 24 Sep 2026).
 *
 * The tenant checks of the code let a query follow an edge from a tenant's
 * node without naming the tenant again: that is sound only while no edge
 * joins two different tenants. This panel checks it on the live graph. The
 * check reads every relationship of the database, so it runs when asked.
 *
 * In English, like the rest of this console (see TenantsPage.tsx).
 */
import { useState } from 'react'
import { api, messaggio, type CrossTenantEdges } from './api'

export function IntegrityPanel() {
  const [result, setResult] = useState<CrossTenantEdges | null>(null)
  const [running, setRunning] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)

  const check = () => {
    setRunning(true)
    setErrore(null)
    api.crossTenantEdges()
      .then(setResult)
      .catch((e: unknown) => setErrore(messaggio(e)))
      .finally(() => setRunning(false))
  }

  return (
    <section className="sezione" aria-labelledby="integrity-title">
      <span className="riga">
        <h1 id="integrity-title">Graph integrity</h1>
        <button onClick={check} disabled={running}>{running ? 'Checking…' : 'Check'}</button>
      </span>
      <p className="lede">
        No relationship may join the data of two different tenants (the shared <code>system</code> metamodel
        aside). The check reads every relationship of the database: it takes a few seconds, and runs only when asked.
      </p>
      {errore && <div className="errore" role="alert">{errore}</div>}
      {result && (result.total === 0 ? (
        <p role="status">
          No relationship between different tenants. Checked at {new Date(result.checkedAt).toLocaleString('en-GB')} in {(result.durationMs / 1000).toFixed(1)} s.
        </p>
      ) : (
        <>
          <div className="errore" role="alert">
            {result.total.toLocaleString('en-GB')} relationship(s) join two different tenants: a query wrote across them.
            The API log has the line «Edges between different tenants found».
          </div>
          <div className="scheda">
            <table aria-label="Relationships between tenants">
              <thead>
                <tr><th>From tenant</th><th>From</th><th>Relationship</th><th>To</th><th>To tenant</th><th style={{ textAlign: 'right' }}>Count</th></tr>
              </thead>
              <tbody>
                {result.groups.map((g) => (
                  <tr key={`${g.fromTenant}|${g.toTenant}|${g.type}|${g.fromLabels.join(':')}|${g.toLabels.join(':')}`}>
                    <td><span className="slug">{g.fromTenant}</span></td>
                    <td>{g.fromLabels.join(':')}</td>
                    <td><code>{g.type}</code></td>
                    <td>{g.toLabels.join(':')}</td>
                    <td><span className="slug">{g.toTenant}</span></td>
                    <td className="num">{g.count.toLocaleString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
    </section>
  )
}
