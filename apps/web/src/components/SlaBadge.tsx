import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Timer, CheckCircle2, AlertTriangle } from 'lucide-react'

export interface SlaStatusInfo {
  startedAt:        string
  responseDeadline: string
  resolveDeadline:  string
  responseMet:      boolean
  resolveMet:       boolean
  breached:         boolean
}

function formatDuration(ms: number): string {
  const abs  = Math.abs(ms)
  const mins = Math.floor(abs / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  return `${Math.floor(hrs / 24)}g ${hrs % 24}h`
}

type SlaState = 'met' | 'breached' | 'overdue' | 'warning' | 'ontrack'

const STATE_STYLE: Record<SlaState, { bg: string; fg: string }> = {
  met:      { bg: '#dcfce7', fg: '#15803d' },
  breached: { bg: '#fee2e2', fg: '#b91c1c' },
  overdue:  { bg: '#fee2e2', fg: '#b91c1c' },
  warning:  { bg: '#fef3c7', fg: '#b45309' },
  ontrack:  { bg: '#f1f5f9', fg: '#475569' },
}

/**
 * SLA pill for lists and detail pages. States:
 * met (resolve met) · breached (marked by scheduler) · overdue (deadline past)
 * · warning (<25% of window or <30min left) · ontrack.
 * Re-renders every 30s so the countdown stays live.
 */
export function SlaBadge({ sla, compact = false }: { sla: SlaStatusInfo | null | undefined; compact?: boolean }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!sla) {
    return compact
      ? <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-table)' }}>—</span>
      : null
  }

  let state: SlaState
  let label: string

  if (sla.resolveMet) {
    state = 'met'
    label = t('sla.met')
  } else if (sla.breached) {
    state = 'breached'
    label = t('sla.breached')
  } else {
    // Next deadline: response first, then resolve
    const deadline  = sla.responseMet ? Date.parse(sla.resolveDeadline) : Date.parse(sla.responseDeadline)
    const started   = Date.parse(sla.startedAt)
    const remaining = deadline - now
    if (remaining < 0) {
      state = 'overdue'
      label = t('sla.overdueBy', { time: formatDuration(remaining) })
    } else {
      const window = deadline - started
      state = remaining < Math.max(window * 0.25, 0) || remaining < 30 * 60_000 ? 'warning' : 'ontrack'
      label = t('sla.remaining', { time: formatDuration(remaining) })
    }
  }

  const { bg, fg } = STATE_STYLE[state]
  const Icon = state === 'met' ? CheckCircle2 : state === 'ontrack' || state === 'warning' ? Timer : AlertTriangle

  return (
    <span
      title={`${t('sla.response')}: ${new Date(sla.responseDeadline).toLocaleString()} · ${t('sla.resolve')}: ${new Date(sla.resolveDeadline).toLocaleString()}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: compact ? '2px 8px' : '4px 10px', borderRadius: 12, fontSize: compact ? 'var(--font-size-table)' : 'var(--font-size-body)', fontWeight: 600, background: bg, color: fg, whiteSpace: 'nowrap' }}
    >
      <Icon size={compact ? 11 : 13} />
      {label}
    </span>
  )
}
