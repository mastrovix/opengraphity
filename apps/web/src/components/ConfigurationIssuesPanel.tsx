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
 * ## Dove si legge (20 set 2026, decisione del proprietario)
 * Era un BANNER in cima a ogni pagina, e con tre rilievi aperti prendeva un
 * quinto dello schermo su ogni schermata dell'app: si legge una volta e poi
 * ingombra per sempre — e chiuderlo lo faceva sparire fino al ricaricamento,
 * cioè o troppo o niente. Ora è il corpo della pagina «Diagnostica» in
 * Configurazione, e in alto resta una pastiglia col numero che porta qui
 * (`TopbarConfigurationIssues`): presente quanto prima, ingombrante quanto un
 * pallino.
 */
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useConfigurationIssues } from '@/hooks/useConfigurationIssues'
import { issueText, type IssueData } from '@/lib/configurationIssueText'

/**
 * I messaggi della diagnostica usano `**…**` per l'enfasi, e il banner li
 * rendeva come testo nudo: l'admin leggeva «Per il prodotto sono CI **in
 * servizio**», asterischi compresi. Terza revisione, trovato in un browser
 * vero — nessun test poteva prenderlo, perché il testo con gli asterischi è
 * esattamente quello che un test sul contenuto si aspetta.
 *
 * Non un renderer markdown: l'enfasi qui è CONTENUTO (dice quale metà della
 * frase è la conseguenza per il prodotto), quindi si rende, e basta questa.
 * Ora gli asterischi stanno nei VALORI i18n — cioè l'enfasi la decide chi
 * traduce, insieme al resto della frase.
 */
function EnfasiDelMessaggio({ testo }: { testo: string }) {
  // Le parti dispari sono quelle fra i `**`.
  const parti = testo.split(/\*\*(.+?)\*\*/g)
  return (
    <>
      {parti.map((parte, i) => (
        i % 2 === 1 ? <strong key={i}>{parte}</strong> : <span key={i}>{parte}</span>
      ))}
    </>
  )
}

function Rilievo({ issue }: { issue: IssueData }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const grave = issue.severity === 'error'
  return (
    <li
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '12px 16px',
        borderLeft: `3px solid ${grave ? 'var(--color-danger)' : 'var(--warning)'}`,
        background: grave ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)',
        borderRadius: 6,
      }}
    >
      <AlertTriangle
        size={16}
        aria-hidden="true"
        style={{ marginTop: 2, flexShrink: 0, color: grave ? 'var(--color-danger-text)' : 'var(--color-warning-text)' }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 'var(--font-size-body)' }}>
        <span style={{ color: 'var(--color-slate-dark)' }}>
          <EnfasiDelMessaggio testo={issueText(t, (k, p) => i18n.exists(k, p), issue)} />
        </span>
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
    </li>
  )
}

export function ConfigurationIssuesPanel() {
  const { t } = useTranslation()
  const { issues, mayRead, loading } = useConfigurationIssues()

  if (!mayRead) return null

  // Mentre la diagnostica gira non si dice né «tutto a posto» né «c'è questo»:
  // sarebbero due bugie di mezzo secondo, e la seconda è quella che conta.
  if (loading && issues.length === 0) return <Skeleton style={{ height: 44 }} />

  // «Niente da sistemare» va DETTO: una pagina vuota non distingue «tutto a
  // posto» da «non ha risposto».
  if (issues.length === 0) {
    return (
      <div
        role="region"
        aria-label={t('configurationIssues.allClear')}
        style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-slate-dark)' }}
      >
        <CheckCircle2 size={18} aria-hidden="true" style={{ color: 'var(--color-success)' }} />
        <span>{t('configurationIssues.allClear')}</span>
      </div>
    )
  }

  return (
    <section aria-label={t('configurationIssues.title', { count: issues.length })}>
      <h2 style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, margin: '0 0 12px' }}>
        {t('configurationIssues.title', { count: issues.length })}
      </h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {issues.map((issue, i) => (
          <Rilievo key={`${issue.kind}-${String(i)}`} issue={issue} />
        ))}
      </ul>
    </section>
  )
}
