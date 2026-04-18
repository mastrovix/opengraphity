/**
 * Presentational bits shared between ChangeDetailPage components.
 * Pure: no data fetching, no mutations, no app-level state.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, ExternalLink, X } from 'lucide-react'
import { TASK_STATUS, REVIEW_RESULT } from '@/lib/taskStatus'

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return iso }
}

export function fmtShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return iso }
}

export function StatusLabel({ status }: { status: string | null | undefined }) {
  const s = status ?? '—'
  const color =
    s === TASK_STATUS.COMPLETED   ? 'var(--color-success)' :
    s === TASK_STATUS.IN_PROGRESS ? 'var(--color-warning)' :
    s === TASK_STATUS.PENDING     ? 'var(--color-danger)' :
    s === 'failed' || s === REVIEW_RESULT.REJECTED ? 'var(--color-danger)' : '#d1d5db'
  const label = s === TASK_STATUS.PENDING ? 'TO BE COMPLETED' : s.replace(/_/g, ' ')
  return <strong title={s} style={{ color, textTransform: 'uppercase' }}>{label}</strong>
}

export function RiskBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const p = score <= 30
    ? { bg: '#dcfce7', color: '#15803d', label: 'LOW' }
    : score <= 60
      ? { bg: '#fef3c7', color: '#b45309', label: 'MEDIUM' }
      : { bg: '#fee2e2', color: '#b91c1c', label: 'HIGH' }
  return (
    <span title={`${p.label} · score ${score}`} style={{
      padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)',
      fontWeight: 600, backgroundColor: p.bg, color: p.color,
    }}>{p.label} · {score}</span>
  )
}

export function OpenTaskButton({ taskId }: { taskId: string }) {
  return (
    <Link to={`/tasks/${taskId}`} onClick={(e) => e.stopPropagation()} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)',
      fontSize: 'var(--font-size-label)', fontWeight: 500,
      color: 'var(--color-brand)', background: 'transparent', textDecoration: 'none',
    }}>
      <ExternalLink size={12} /> Apri
    </Link>
  )
}

export function EyeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'none', border: '1px solid #e5e7eb', borderRadius: 4,
      padding: '2px 6px', cursor: 'pointer', fontSize: 'var(--font-size-label)',
      color: 'var(--color-brand)', fontWeight: 500,
    }}>
      <Eye size={12} /> Vedi
    </button>
  )
}

export function ModalOverlay({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    queueMicrotask(() => {
      const focusable = containerRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    })
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div ref={containerRef} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 600, width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{title}</h3>
          <button type="button" onClick={onClose} aria-label="Chiudi" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={18} color="var(--color-slate-light)" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function TaskStatusRow({ label, code, status, scheduledDate, result, actor, date, assignedTeam, assignee, action }: {
  label: string; code?: string; status: string | null; scheduledDate?: string | null
  result?: string | null; actor?: string | null; date?: string | null
  assignedTeam?: string | null; assignee?: string | null
  action?: React.ReactNode
}) {
  const isScheduled = scheduledDate && status === TASK_STATUS.PENDING && new Date(scheduledDate).getTime() > Date.now()
  const isCompleted = status === TASK_STATUS.COMPLETED
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-label)' }}>
      <span style={{ width: 90, flexShrink: 0, color: 'var(--color-slate)', fontWeight: 500, paddingTop: 1 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {code && <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{code}</span>}
          {isScheduled
            ? <span style={{ color: 'var(--color-slate-light)' }}>Schedulato — {fmtShort(scheduledDate)}</span>
            : status ? <StatusLabel status={status} /> : <span style={{ color: '#d1d5db' }}>—</span>
          }
          {!isScheduled && result && <span style={{ color: 'var(--color-slate)' }}>· {result}</span>}
        </div>
        {isCompleted && (actor || date) && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {actor}{actor && date ? ' · ' : ''}{date ? fmtShort(date) : ''}
          </div>
        )}
        {!isCompleted && assignedTeam && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            Assegnato a: <span style={{ fontWeight: 600 }}>{assignedTeam}</span>{assignee ? ` — ${assignee}` : ''}
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

export function DescriptionField({ value }: { value: string }) {
  const [showFull, setShowFull] = useState(false)
  return (
    <div>
      <div style={fieldLabelStyle}>Descrizione</div>
      <div style={{ ...fieldValueStyle, ...(showFull ? {} : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>
        {value}
      </div>
      {value.length > 150 && (
        <button type="button" onClick={() => setShowFull(p => !p)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', marginTop: 2 }}>
          {showFull ? 'Mostra meno' : 'Mostra tutto'}
        </button>
      )}
    </div>
  )
}
