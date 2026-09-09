/**
 * Banner "Tempesta in corso" in testa alla console eventi (ondata 4): una
 * riga per ogni sorgente in `eventStats.stormSources` — chi, quanti allarmi
 * al minuto, da che ora, in quale incident di tempesta sono raggruppati —
 * e il link alla pagina Sorgenti (solo admin: la pagina è sua).
 * Ambra e `role="status"`: è un avviso, non un errore.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CloudLightning } from 'lucide-react'
import { currentLocale, formatDateTime } from '@/lib/datetime'
import type { StormSource } from '@/types/events'

const AMBER = { bg: '#fef3c7', border: '#fcd34d', text: '#92400e' } as const
const linkStyle = { color: AMBER.text, fontWeight: 600 } as const

/** "14:05" nella lingua attiva. */
function timeOfDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })
}

export function StormBanner({ sources, showSourcesLink }: { sources: StormSource[]; showSourcesLink: boolean }) {
  const { t } = useTranslation()
  if (sources.length === 0) return null
  return (
    <div role="status" data-testid="storm-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', marginBottom: 16, background: AMBER.bg, border: `1px solid ${AMBER.border}`, borderRadius: 8, color: AMBER.text, fontSize: 'var(--font-size-body)' }}>
      <CloudLightning size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('events.storm.banner.title', { count: sources.length })}</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.5 }}>
          {sources.map((s) => {
            const vars = { source: s.sourceName, rate: s.ratePerMinute, time: timeOfDay(s.since) }
            return (
              <li key={s.sourceId} title={formatDateTime(s.since)}>
                {s.incidentId && s.incidentNumber
                  ? <>
                      {t('events.storm.banner.line', vars)}{' '}
                      <Link to={`/incidents/${s.incidentId}`} style={linkStyle}>{s.incidentNumber}</Link>
                    </>
                  : t('events.storm.banner.lineNoIncident', vars)}
              </li>
            )
          })}
        </ul>
      </div>
      {showSourcesLink && (
        <Link to="/monitoring/sources" style={{ ...linkStyle, whiteSpace: 'nowrap' }}>{t('events.storm.banner.sources')} →</Link>
      )}
    </div>
  )
}
