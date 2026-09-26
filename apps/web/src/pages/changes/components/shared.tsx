/**
 * Presentational bits shared between ChangeDetailPage components.
 * Pure: no data fetching, no mutations, no app-level state.
 */
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Eye, ExternalLink } from 'lucide-react'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } from '@/lib/taskStatus'
import type { TFunction } from 'i18next'
import { formatDateTime } from '@/lib/datetime'
import { StatusLabel } from '@/components/ui/badges'
import { colors } from '@/lib/tokens'

// Date e badge vivono nei moduli condivisi; i re-export mantengono i path
// storici dei call site delle change.
export { fmtDate } from '@/lib/datetime'
export { StatusLabel, RiskBadge } from '@/components/ui/badges'

export function OpenTaskButton({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  return (
    <Link to={`/tasks/${taskId}`} onClick={(e) => e.stopPropagation()} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)',
      fontSize: 'var(--font-size-label)', fontWeight: 500,
      color: 'var(--color-link)', background: 'transparent', textDecoration: 'underline', textUnderlineOffset: 2,
    }}>
      <ExternalLink size={12} /> {t('common.open')}
    </Link>
  )
}

export function EyeButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button variant="secondary" size="xs"
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      <Eye size={12} /> {t('common.view')}
    </Button>
  )
}

/** A dialog of the change page: the app's `Modal` (26 Sep 2026: it was a hand-made overlay). */
export function ModalOverlay({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode
}) {
  return <Modal open onClose={onClose} title={title} width={600} zIndex={100}>{children}</Modal>
}

/** L'esito di un task (validazione, review) nella lingua di chi legge. */
export function taskResultLabel(t: TFunction, result: string): string {
  switch (result) {
    case VALIDATION_RESULT.PASS:   return t('taskStatus.result.pass')
    case VALIDATION_RESULT.FAIL:   return t('taskStatus.result.fail')
    case REVIEW_RESULT.CONFIRMED:  return t('taskStatus.result.confirmed')
    case REVIEW_RESULT.REJECTED:   return t('taskStatus.result.rejected')
    default:                       return result
  }
}

export function TaskStatusRow({ label, code, status, scheduledDate, result, actor, date, assignedTeam, assignee, action }: {
  label: string; code?: string; status: string | null; scheduledDate?: string | null
  result?: string | null; actor?: string | null; date?: string | null
  assignedTeam?: string | null; assignee?: string | null
  action?: React.ReactNode
}) {
  const { t } = useTranslation()
  const isScheduled = scheduledDate && status === TASK_STATUS.PENDING && new Date(scheduledDate).getTime() > Date.now()
  const isCompleted = status === TASK_STATUS.COMPLETED
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--color-border-light)', fontSize: 'var(--font-size-label)' }}>
      <span style={{ width: 90, flexShrink: 0, color: 'var(--color-slate)', fontWeight: 500, paddingTop: 1 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {code && <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{code}</span>}
          {isScheduled
            ? <span style={{ color: 'var(--color-slate-light)' }}>{t('changeTasks.scheduledOn', { date: formatDateTime(scheduledDate) })}</span>
            : status ? <StatusLabel status={status} /> : <span style={{ color: colors.slateLight }}>—</span>
          }
          {!isScheduled && result && <span style={{ color: 'var(--color-slate)' }}>· {taskResultLabel(t, result)}</span>}
        </div>
        {isCompleted && (actor || date) && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {actor}{actor && date ? ' · ' : ''}{date ? formatDateTime(date) : ''}
          </div>
        )}
        {!isCompleted && assignedTeam && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {t('detail.assignedTo')}: <span style={{ fontWeight: 600 }}>{assignedTeam}</span>{assignee ? ` — ${assignee}` : ''}
          </div>
        )}
      </div>
      {action && <span style={{ flexShrink: 0, paddingTop: 1 }}>{action}</span>}
    </div>
  )
}

export const fieldLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)', fontWeight: 500, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4,
}
export const fieldValueStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}

export function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={fieldValueStyle}>{value}</div>
    </div>
  )
}

export function DescriptionField({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation()
  const [showFull, setShowFull] = useState(false)
  return (
    <div>
      <div style={fieldLabelStyle}>{label ?? t('common.description')}</div>
      <div style={{ ...fieldValueStyle, ...(showFull ? {} : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>
        {value}
      </div>
      {value.length > 150 && (
        <button type="button" onClick={() => setShowFull(p => !p)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, marginTop: 2 }}>
          {t(showFull ? 'common.showLess' : 'common.showAll')}
        </button>
      )}
    </div>
  )
}
