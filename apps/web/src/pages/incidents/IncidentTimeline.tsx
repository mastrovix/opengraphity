import { ChevronDown, ChevronRight } from 'lucide-react'

interface WorkflowStepExecution {
  id:          string
  stepName:    string
  enteredAt:   string
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string
  triggerType: string
  notes:       string | null
}

function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)             return 'adesso'
  const min = Math.floor(sec / 60)
  if (min < 60)             return `${min} min fa`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)             return `${hrs} ore fa`
  const days = Math.floor(hrs / 24)
  if (days < 7)             return `${days} giorni fa`
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 60_000)        return '< 1 min'
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)} min`
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)} ore`
  return `${Math.floor(ms / 86_400_000)} giorni`
}

interface IncidentTimelineProps {
  historyDesc:   WorkflowStepExecution[]
  timelineOpen:  boolean
  onToggle:      () => void
}

export function IncidentTimeline({ historyDesc, timelineOpen, onToggle }: IncidentTimelineProps) {
  return (
    <div style={{
      backgroundColor: '#fff',
      border:          '1px solid #e5e7eb',
      borderRadius:    10,
      boxShadow:       '0 1px 2px rgba(0,0,0,0.05)',
      padding:         0,
      marginBottom:    16,
    }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: timelineOpen ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Timeline workflow</span>
        </div>
        {timelineOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {timelineOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {historyDesc.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna storia workflow.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {historyDesc.map((exec, idx) => {
                const isCurrent = idx === 0
                return (
                  <div key={exec.id} style={{ display: 'flex', gap: 12, paddingBottom: idx < historyDesc.length - 1 ? 16 : 0, position: 'relative' }}>
                    {idx < historyDesc.length - 1 && (
                      <div style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 2, backgroundColor: 'var(--color-slate)', opacity: 0.3 }} />
                    )}
                    <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: isCurrent ? 'var(--color-brand)' : 'var(--color-slate)', flexShrink: 0, marginTop: 2, border: '2px solid #fff', boxShadow: isCurrent ? '0 0 0 3px rgba(2,132,199,0.2)' : '0 0 0 1px rgba(100,116,139,0.3)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{exec.stepName.replace(/_/g, ' ')}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'flex', gap: 6 }}>
                        <span>{timeAgo(exec.enteredAt)}</span>
                        {exec.durationMs != null && <span>({formatDuration(exec.durationMs)})</span>}
                      </div>
                      {exec.notes && <div style={{ fontSize: 12, color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{exec.notes}</div>}
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
