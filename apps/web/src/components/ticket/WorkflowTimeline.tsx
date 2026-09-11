/**
 * Timeline del workflow di un ticket (incident, problem, …): un'unica
 * implementazione al posto delle due copie IncidentTimeline/ProblemTimeline.
 *
 * La testata è quella condivisa (`SectionCard`), non una copia: nata il 2
 * aprile 2026 dentro le pagine, la testata era disegnata a mano e ha
 * attraversato intatta due giri di fattorizzazione, finendo col mostrare un
 * colore diverso dalle altre schede della stessa pagina. Qui il riquadro è
 * CONTROLLATO dal chiamante (`timelineOpen`/`onToggle`), come prima.
 */
import { timeAgo, formatDuration } from '@/lib/datetime'
import { alpha, colors } from '@/lib/tokens'
import { SectionCard } from '@/components/ui/SectionCard'

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
    <SectionCard title={title} open={timelineOpen} onToggle={onToggle}>
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
                <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: isCurrent ? 'var(--color-brand)' : 'var(--color-slate)', flexShrink: 0, marginTop: 2, border: `2px solid ${colors.white}`, boxShadow: isCurrent ? `0 0 0 3px ${alpha.brand20}` : `0 0 0 1px ${alpha.black20}` }} />
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
    </SectionCard>
  )
}
