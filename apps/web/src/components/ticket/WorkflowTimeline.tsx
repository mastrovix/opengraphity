/**
 * Timeline del workflow di un ticket (incident, problem, …): un'unica
 * implementazione al posto delle due copie IncidentTimeline/ProblemTimeline.
 * Intestazione turchese quando aperta, come le SectionCard.
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { timeAgo, formatDuration } from '@/lib/datetime'

export interface WorkflowStepExecution {
  id:          string
  stepName:    string
  enteredAt:   string
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string
  triggerType: string
  notes:       string | null
}

interface Props {
  historyDesc: WorkflowStepExecution[]
  timelineOpen: boolean
  onToggle:    () => void
  title?:      string
}

export function WorkflowTimeline({ historyDesc, timelineOpen, onToggle, title = 'Timeline workflow' }: Props) {
  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)', padding: 0, marginBottom: 16 }}>
      <div
        role="button" tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: timelineOpen ? '1px solid #e5e7eb' : 'none', background: timelineOpen ? '#0ea5e9' : undefined }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: timelineOpen ? '#fff' : 'var(--color-slate-dark)' }}>{title}</span>
        {timelineOpen ? <ChevronDown size={16} color="#fff" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {timelineOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {historyDesc.length === 0 ? (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>Nessuna storia workflow.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {historyDesc.map((exec, idx) => {
                const isCurrent = idx === 0
                const isLast = idx === historyDesc.length - 1
                return (
                  <div key={exec.id} style={{ display: 'flex', gap: 12, paddingBottom: isLast ? 0 : 16, position: 'relative' }}>
                    {!isLast && <div style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 2, backgroundColor: 'var(--color-slate)', opacity: 0.3 }} />}
                    <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: isCurrent ? 'var(--color-brand)' : 'var(--color-slate)', flexShrink: 0, marginTop: 2, border: '2px solid #fff', boxShadow: isCurrent ? '0 0 0 3px rgba(2,132,199,0.2)' : '0 0 0 1px rgba(100,116,139,0.3)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{exec.stepName.replace(/_/g, ' ')}</div>
                      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', display: 'flex', gap: 6 }}>
                        <span>{timeAgo(exec.enteredAt)}</span>
                        {exec.durationMs != null && <span>({formatDuration(exec.durationMs)})</span>}
                      </div>
                      {exec.notes && <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{exec.notes}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
