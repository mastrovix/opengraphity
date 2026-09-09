/**
 * Corpo del widget "Allarmi attivi" (Event Management): i contatori di
 * `eventStats` (attivi, critici, warning, orfani) con link alla console
 * filtrata. Registrato nel sistema dei widget come tipo `active_alarms`
 * (WIDGET_TYPES in useWidgetConfig): entità/metrica non si configurano,
 * la sorgente dei dati è sempre la console eventi.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Radar } from 'lucide-react'
import { GET_EVENT_STATS } from '@/graphql/queries'
import { colors } from '@/lib/tokens'
import type { EventStats, EventStatCounts } from '@/types/events'

export const ACTIVE_ALARMS_WIDGET_TYPE = 'active_alarms'
const POLL_MS = 30_000

/** Contatori mostrati, con il preset della console (`/events?stat=…`) e il colore (stesso di EventsPage). */
const TILES: ReadonlyArray<{ key: keyof EventStatCounts; accent: string }> = [
  { key: 'firing',   accent: colors.danger },
  { key: 'critical', accent: '#b91c1c' },
  { key: 'warning',  accent: '#b45309' },
  { key: 'orphan',   accent: colors.slate },
]

export function ActiveAlarmsWidget({ color, large = false }: { color: string; large?: boolean }) {
  const { t } = useTranslation()
  const { data, loading, error } = useQuery<{ eventStats: EventStats }>(GET_EVENT_STATS, { pollInterval: POLL_MS, fetchPolicy: 'cache-and-network' })
  const stats = data?.eventStats

  if (error && !stats) {
    return <div role="alert" style={{ padding: 16, fontSize: 'var(--font-size-body)', color: colors.danger }}>{t('monitoring.widget.loadError', { error: error.message })}</div>
  }

  return (
    <div style={{ padding: large ? '20px 20px 16px' : '14px 14px 12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {TILES.map(({ key, accent }) => (
          <Link
            key={key}
            to={`/events?stat=${key}`}
            aria-label={`${t(`events.stats.${key}`)} ${stats ? stats[key] : '—'}`}
            style={{ textDecoration: 'none', textAlign: 'center', padding: '10px 6px', borderRadius: 8, background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}` }}
          >
            <div style={{ fontSize: large ? 32 : 26, fontWeight: 700, color: accent, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
              {stats ? stats[key] : loading ? '…' : '—'}
            </div>
            <div style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 }}>{t(`events.stats.${key}`)}</div>
          </Link>
        ))}
      </div>
      <Link to="/events" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 'var(--font-size-table)', color, textDecoration: 'none', fontWeight: 600 }}>
        <Radar size={12} aria-hidden="true" />{t('monitoring.widget.openConsole')}
      </Link>
    </div>
  )
}
