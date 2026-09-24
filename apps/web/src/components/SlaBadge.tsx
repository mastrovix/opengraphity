import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Timer, CheckCircle2, AlertTriangle, PauseCircle } from 'lucide-react'
import { colors, palette } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'
import i18n from '@/i18n/i18n'

export interface SlaStatusInfo {
  startedAt:        string
  responseDeadline: string
  resolveDeadline:  string
  responseMet:      boolean
  /** When the response was given: after the response deadline it was late (G14). */
  respondedAt?:     string | null
  resolveMet:       boolean
  breached:         boolean
  pausedAt?:        string | null
  /** Minuti di preavviso della policy (gli stessi dell'avviso inviato dallo scheduler). */
  warningMinutes:   number
}

/**
 * Durata compatta del badge: «45 min», «3 h 20 min», «1 d 23 h». Giro nel
 * browser del 14 set 2026 (#25): i giorni erano «g» anche con l'interfaccia
 * inglese; le unità vengono dalla lingua attiva.
 */
function formatDuration(ms: number): string {
  const abs  = Math.abs(ms)
  const mins = Math.floor(abs / 60_000)
  if (mins < 60) return i18n.t('time.short.minutes', { m: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return i18n.t('time.short.hoursMinutes', { h: hrs, m: mins % 60 })
  return i18n.t('time.short.daysHours', { d: Math.floor(hrs / 24), h: hrs % 24 })
}

type SlaState = 'met' | 'breached' | 'overdue' | 'warning' | 'ontrack' | 'paused'

const STATE_STYLE: Record<SlaState, { bg: string; fg: string }> = {
  met:      { bg: palette.success.tint, fg: palette.success.text },
  breached: { bg: palette.danger.tint, fg: palette.danger.text },
  overdue:  { bg: palette.danger.tint, fg: palette.danger.text },
  warning:  { bg: palette.warning.tint, fg: palette.warning.text },
  ontrack:  { bg: colors.slateBg, fg: palette.neutral.textStrong },
  paused:   { bg: palette.info.tint, fg: palette.purple.dark },
}

/**
 * SLA pill for lists and detail pages. States:
 * met (resolve met) · breached (marked by scheduler) · overdue (deadline past)
 * · warning (meno dei minuti di preavviso della POLICY: gli stessi dell'avviso
 *   inviato — prima era una soglia del badge, 25% della finestra o 30 minuti,
 *   che non concordava con la notifica) · ontrack.
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
  } else if (sla.pausedAt) {
    state = 'paused'
    label = t('sla.paused')
  } else if (sla.breached) {
    state = 'breached'
    label = t('sla.breached')
  } else {
    // Next deadline: response first, then resolve
    const deadline  = sla.responseMet ? Date.parse(sla.resolveDeadline) : Date.parse(sla.responseDeadline)
    const remaining = deadline - now
    if (remaining < 0) {
      state = 'overdue'
      label = t('sla.overdueBy', { time: formatDuration(remaining) })
    } else {
      state = remaining <= sla.warningMinutes * 60_000 ? 'warning' : 'ontrack'
      label = t('sla.remaining', { time: formatDuration(remaining) })
    }
  }

  // A late response stays said once the ticket is taken (tour of 24 Sep 2026, G14):
  // the badge moved from «Overdue by 37 min» to the resolve countdown as if nothing had happened.
  const lateBy = sla.responseMet && sla.respondedAt ? Date.parse(sla.respondedAt) - Date.parse(sla.responseDeadline) : 0
  const responseLate = !compact && lateBy > 60_000

  const { bg, fg } = STATE_STYLE[state]
  const Icon = state === 'met' ? CheckCircle2
    : state === 'paused' ? PauseCircle
    : state === 'ontrack' || state === 'warning' ? Timer
    : AlertTriangle

  return (
    <span
      title={`${t('sla.response')}: ${formatDateTime(sla.responseDeadline)} · ${t('sla.resolve')}: ${formatDateTime(sla.resolveDeadline)}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: compact ? '2px 8px' : '4px 10px', borderRadius: 12, fontSize: compact ? 'var(--font-size-table)' : 'var(--font-size-body)', fontWeight: 600, background: bg, color: fg, whiteSpace: 'nowrap' }}
    >
      <Icon size={compact ? 11 : 13} />
      {label}
      {responseLate && (
        <span style={{ fontWeight: 500, color: palette.danger.text }}>
          {' · '}{t('sla.responseLateBy', { time: formatDuration(lateBy) })}
        </span>
      )}
    </span>
  )
}
