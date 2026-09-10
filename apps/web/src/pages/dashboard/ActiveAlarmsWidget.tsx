/**
 * Corpo del widget "Allarmi attivi" (Event Management): i contatori di
 * `eventStats` (attivi, critici, avvisi, senza CI) con link alla console
 * filtrata. Registrato nel sistema dei widget come tipo `active_alarms`
 * (WIDGET_TYPES in useWidgetConfig): entità/metrica non si configurano,
 * la sorgente dei dati è sempre la console allarmi.
 * La console è riservata allo staff (rotte `staff(...)` in main.tsx, stesso
 * predicato `isStaff`): a un end user il widget lo dice invece di linkare
 * una pagina "accesso negato".
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Radar } from 'lucide-react'
import { GET_EVENT_STATS } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import { isStaff } from '@/lib/roles'
import { colors } from '@/lib/tokens'
import { ACCENT } from '@/lib/eventPalette'
import { pausedWhenHidden } from '@/lib/polling'
import type { EventStats, EventStatCounts } from '@/types/events'

export const ACTIVE_ALARMS_WIDGET_TYPE = 'active_alarms'
/** Polling in pausa a scheda nascosta (lib/polling). */
const POLL_MS = 30_000

/** Contatori mostrati, con il preset della console (`/events?stat=…`) e il colore (stesso di EventsPage). */
const TILES: ReadonlyArray<{ key: keyof EventStatCounts; accent: string }> = [
  { key: 'firing',   accent: ACCENT.danger },
  { key: 'critical', accent: ACCENT.critical },
  { key: 'warning',  accent: ACCENT.warning },
  { key: 'orphan',   accent: ACCENT.neutral },
]

export function ActiveAlarmsWidget({ color, large = false }: { color: string; large?: boolean }) {
  const { t } = useTranslation()
  const { role, loading: meLoading } = useMe()
  const staff = isStaff(role)
  const { data, loading, error } = useQuery<{ eventStats: EventStats }>(GET_EVENT_STATS, { ...pausedWhenHidden(POLL_MS), fetchPolicy: 'cache-and-network', skip: !staff })
  const stats = data?.eventStats

  if (!staff) {
    // Finché `me` non risponde non si sa il ruolo: nessun messaggio prematuro.
    if (meLoading || role === null) return null
    return <p style={{ padding: 16, margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate }}>{t('pages.dashboard.activeAlarmsStaffOnly')}</p>
  }

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
