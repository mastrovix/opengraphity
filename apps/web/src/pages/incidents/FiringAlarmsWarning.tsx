/**
 * RESOLVING WHILE THE ALARM STILL FIRES (tour of 23 Sep 2026).
 *
 * An incident whose monitoring alarm was still firing could be resolved
 * without a word: the person closing it often does not look at the alarms
 * section, and the incident reopens — or worse, stays resolved while the
 * service is still down. The resolve dialog now names the alarms that are
 * still firing. Resolving stays allowed: the person may know better (the fix
 * is in, the monitoring has not caught up yet).
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { palette } from '@/lib/tokens'
import type { EventRow } from '@/types/events'

/** How many alarms are named; the rest are counted. */
const NAMED = 3

export function FiringAlarmsWarning({ events }: { events: readonly EventRow[] }) {
  const { t } = useTranslation()
  const firing = events.filter((e) => e.status === 'firing')
  if (firing.length === 0) return null
  const named = firing.slice(0, NAMED).map((e) => (e.ci ? `«${e.title}» (${e.ci.name})` : `«${e.title}»`)).join(', ')
  const names = firing.length > NAMED ? t('pages.incidentDetail.firingAlarmsMore', { names: named, count: firing.length - NAMED }) : named
  return (
    <p role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '0 0 12px', padding: '8px 12px', borderRadius: 8, background: 'var(--color-warning-bg)', border: `1px solid ${palette.warning.border}`, color: palette.warning.strong, fontSize: 'var(--font-size-body)', lineHeight: 1.5 }}>
      <AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{t('pages.incidentDetail.firingAlarms', { count: firing.length, names })}</span>
    </p>
  )
}
