/**
 * Presentational bits shared between ChangeDetailPage components.
 * Pure: no data fetching, no mutations, no app-level state.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, ExternalLink, X } from 'lucide-react'
import { TASK_STATUS } from '@/lib/taskStatus'
import { fmtShort } from '@/lib/datetime'
import { StatusLabel } from '@/components/ui/badges'

// Date e badge vivono nei moduli condivisi; i re-export mantengono i path
// storici dei call site delle change.
export { fmtDate, fmtShort } from '@/lib/datetime'
export { StatusLabel, RiskBadge } from '@/components/ui/badges'

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
    // Il click sull'overlay (fuori dal pannello) chiude il dialogo: scorciatoia
    // solo-mouse; l'equivalente da tastiera è Escape (keydown sopra) e il bottone "Chiudi".
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- overlay: chiusura via mouse, Escape/bottone per la tastiera
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-label={title} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 600, width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
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

export function DescriptionField({ value, label = 'Descrizione' }: { value: string; label?: string }) {
  const [showFull, setShowFull] = useState(false)
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
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
