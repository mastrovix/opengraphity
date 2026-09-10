/**
 * Banner "Tempesta in corso" in testa alla console allarmi (ondata 4): una
 * riga per ogni sorgente in `eventStats.stormSources` — chi, quanti allarmi
 * al minuto, da che ora, in quale incident di tempesta sono raggruppati — con
 * l'azione per l'operatore "Vedi gli allarmi della sorgente" (console filtrata
 * per sourceId) e il link alla pagina Sorgenti (solo admin: la pagina è sua).
 * Ambra e `role="status"`: è un avviso, non un errore. La frase con il link
 * all'incident passa da `<Trans>`: l'ordine delle parole resta alla lingua.
 */
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { CloudLightning } from 'lucide-react'
import { currentLocale, formatDateTime } from '@/lib/datetime'
import { AMBER_BANNER } from '@/lib/eventPalette'
import type { StormSource } from '@/types/events'

const linkStyle = { color: AMBER_BANNER.text, fontWeight: 600 } as const

/** "14:05" nella lingua attiva. */
function timeOfDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })
}

export function StormBanner({ sources, showSourcesLink }: { sources: StormSource[]; showSourcesLink: boolean }) {
  const { t } = useTranslation()
  if (sources.length === 0) return null
  return (
    <div role="status" data-testid="storm-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', marginBottom: 16, background: AMBER_BANNER.bg, border: `1px solid ${AMBER_BANNER.border}`, borderRadius: 8, color: AMBER_BANNER.text, fontSize: 'var(--font-size-body)' }}>
      <CloudLightning size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('events.storm.banner.title', { count: sources.length })}</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.5 }}>
          {sources.map((s) => {
            const vars = { source: s.sourceName, rate: s.ratePerMinute, time: timeOfDay(s.since) }
            return (
              <li key={s.sourceId} title={formatDateTime(s.since)}>
                {s.incidentId && s.incidentNumber
                  ? <Trans
                      i18nKey="events.storm.banner.line"
                      values={{ ...vars, number: s.incidentNumber }}
                      components={{ incident: <Link to={`/incidents/${s.incidentId}`} style={linkStyle} /> }}
                    />
                  : t('events.storm.banner.lineNoIncident', vars)}
                {' '}
                <Link to={`/events?sourceId=${encodeURIComponent(s.sourceId)}`} style={linkStyle}>{t('events.storm.banner.viewSource')}</Link>
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
