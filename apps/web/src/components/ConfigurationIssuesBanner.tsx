/**
 * «C'è qualcosa da sistemare», detto a chi può sistemarlo (revisione delle otto
 * ondate · A·#3, D·D4, D·#5, C·#8).
 *
 * Il prodotto sapeva già quando la configurazione di un cliente era rotta o
 * incompleta — lo schema degradato ha l'intestazione HTTP, la metrica e il log;
 * le matrici incomplete sono nella loro pagina; i buchi di configurazione li
 * conosceva `migrate --status` — e non lo diceva all'amministratore del tenant,
 * che vedeva soltanto pagine che non funzionano. Nessuno aveva collegato la
 * rete alla persona che deve tirarla.
 *
 * Solo per gli admin, e solo quando c'è qualcosa: un banner che compare sempre
 * diventa invisibile in una settimana.
 */
import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'

interface Issue { kind: string; severity: string; message: string; where: string | null }

export function ConfigurationIssuesBanner() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { me } = useMe()
  const [dismissed, setDismissed] = useState(false)
  const isAdmin = me?.role === 'admin'

  const { data, error } = useQuery<{ configurationIssues: Issue[] }>(GET_CONFIGURATION_ISSUES, {
    skip: !isAdmin,
    fetchPolicy: 'cache-and-network',
  })

  // Un errore qui non deve rompere la pagina: se la diagnostica non risponde,
  // il banner semplicemente non c'è (e il problema vero resta nei log del
  // server, dove la diagnostica stessa lo scrive).
  const issues = error ? [] : data?.configurationIssues ?? []
  if (!isAdmin || dismissed || issues.length === 0) return null

  const errors = issues.filter((i) => i.severity === 'error')
  const tone = errors.length > 0 ? 'error' : 'warning'

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 16px',
        background: tone === 'error' ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)',
        borderBottom: '1px solid var(--color-border)',
        fontSize: 'var(--font-size-body)',
      }}
    >
      <AlertTriangle size={16} aria-hidden="true" style={{ marginTop: 2, color: tone === 'error' ? 'var(--color-danger-text)' : 'var(--color-warning-text)' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong>{t('configurationIssues.title', { count: issues.length })}</strong>
        {issues.map((issue, i) => (
          <div key={`${issue.kind}-${String(i)}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-slate-dark)' }}>{issue.message}</span>
            {issue.where && (
              <button
                type="button"
                onClick={() => navigate(issue.where!)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-brand)', textDecoration: 'underline', fontSize: 'inherit' }}
              >
                {t('configurationIssues.goFix')}
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('configurationIssues.dismiss')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', display: 'flex' }}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
