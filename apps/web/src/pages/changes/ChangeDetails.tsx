import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { DetailField } from '@/components/ui/DetailField'
import type { Change } from './change-types'
import { Badge, TYPE_COLORS, PRIORITY_COLORS, STEP_COLORS, cardStyle } from './change-types'

interface Props {
  change: Change
  currentStep: string
  /** When true, renders only the Timeline Workflow card (for the right sidebar). */
  sidebarOnly?: boolean
}

export function ChangeDetails({ change, currentStep, sidebarOnly = false }: Props) {
  const [descOpen,    setDescOpen]    = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(true)

  if (sidebarOnly) {
    if (change.workflowHistory.length === 0) return null
    return (
      <div style={{ ...cardStyle, padding: 0 }}>
        <div
          onClick={() => setTimelineOpen((p) => !p)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: timelineOpen ? '1px solid #e5e7eb' : 'none' }}
        >
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Timeline Workflow</span>
          {timelineOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
        {timelineOpen && (
          <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[...change.workflowHistory].reverse().map((exec, idx, arr) => {
              const isCurrent = idx === 0
              return (
                <div key={exec.id ?? idx} style={{ display: 'flex', gap: 12, paddingBottom: idx < arr.length - 1 ? 16 : 0, position: 'relative' }}>
                  {idx < arr.length - 1 && (
                    <div style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 2, backgroundColor: 'var(--color-slate)', opacity: 0.3 }} />
                  )}
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: isCurrent ? 'var(--color-brand)' : 'var(--color-slate)', flexShrink: 0, marginTop: 2, border: '2px solid #fff', boxShadow: isCurrent ? '0 0 0 3px rgba(2,132,199,0.2)' : '0 0 0 1px rgba(100,116,139,0.3)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{exec.stepName.replace(/_/g, ' ')}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{new Date(exec.enteredAt).toLocaleString('it-IT')}</div>
                    {exec.notes && <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{exec.notes}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Description */}
      <div style={{ ...cardStyle, padding: 0 }}>
        <div
          onClick={() => setDescOpen((p) => !p)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: descOpen ? '1px solid #e5e7eb' : 'none' }}
        >
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Descrizione</span>
          {descOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
        {descOpen && (
          <div style={{ padding: '16px 20px 20px' }}>
            {change.description ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: 0, lineHeight: 1.6 }}>{change.description}</p>
            ) : (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>Nessuna descrizione.</p>
            )}
          </div>
        )}
      </div>

      {/* Details */}
      <div style={{ ...cardStyle, padding: 0 }}>
        <div
          onClick={() => setDetailsOpen((p) => !p)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: detailsOpen ? '1px solid #e5e7eb' : 'none' }}
        >
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Dettagli</span>
          {detailsOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
        {detailsOpen && (
          <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <DetailField label="Tipo" value={<Badge value={change.type} map={TYPE_COLORS} />} />
            <DetailField label="Priorità" value={<Badge value={change.priority} map={PRIORITY_COLORS} />} />
            <DetailField label="Step" value={change.workflowInstance ? <Badge value={currentStep} map={STEP_COLORS} /> : null} />
            <DetailField label="Team" value={change.assignedTeam?.name ?? null} />
            <DetailField label="Assegnato a" value={change.assignee?.name ?? null} />
            <DetailField label="Creato da" value={change.createdBy?.name ?? null} />
            <DetailField label="Scheduled Start" value={change.scheduledStart ? new Date(change.scheduledStart).toLocaleDateString('it-IT') : null} />
            <DetailField label="Scheduled End" value={change.scheduledEnd ? new Date(change.scheduledEnd).toLocaleDateString('it-IT') : null} />
            <DetailField label="Creato il" value={new Date(change.createdAt).toLocaleString('it-IT')} />
            <DetailField label="Aggiornato" value={new Date(change.updatedAt).toLocaleString('it-IT')} />
          </div>
        )}
      </div>

    </>
  )
}
