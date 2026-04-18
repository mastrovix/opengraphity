/**
 * Pure form for the deploy plan: the list of steps is owned by the parent,
 * so the parent decides when state resets (e.g. on task change). The form
 * notifies the parent on every edit and on explicit save/complete.
 */
import { Plus, X } from 'lucide-react'
import { TASK_STATUS } from '@/lib/taskStatus'
import type { DeployPlanTaskData, DeployStep } from '@/types/change'
import { StickyAction, inputStyle, labelStyle, toLocal, fromLocal } from './shared'

const emptyStep = (): DeployStep => ({
  title: '',
  validationWindow: { start: '', end: '' },
  releaseWindow: { start: '', end: '' },
})

const isStepComplete = (s: DeployStep) =>
  s.title.trim().length > 0 &&
  !!s.validationWindow.start && !!s.validationWindow.end &&
  !!s.releaseWindow.start    && !!s.releaseWindow.end

export function PlanTaskForm({ task, steps, setSteps, dirty, setDirty, canEdit, onSave, onComplete }: {
  task: DeployPlanTaskData
  steps: DeployStep[]
  setSteps: (s: DeployStep[]) => void
  dirty: boolean
  setDirty: (d: boolean) => void
  canEdit: boolean
  onSave: () => void
  onComplete: () => void
}) {
  const completed = task.status === TASK_STATUS.COMPLETED
  const allComplete = steps.length >= 1 && steps.every(isStepComplete)
  const updateStep = (i: number, patch: Partial<DeployStep>) => {
    setSteps(steps.map((x, j) => j === i ? { ...x, ...patch } : x))
    setDirty(true)
  }

  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginBottom: 10, background: 'var(--color-slate-bg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={labelStyle}>Step {i + 1}</span>
            {canEdit && !completed && (
              <button
                type="button"
                onClick={() => { setSteps(steps.filter((_, j) => j !== i)); setDirty(true) }}
                style={{ background: 'none', border: '1px solid #fecaca', color: 'var(--color-danger)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              ><X size={12} /></button>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Titolo *</label>
            <input
              type="text" disabled={!canEdit || completed} value={s.title}
              onChange={e => updateStep(i, { title: e.target.value })}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Validazione *</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="datetime-local" disabled={!canEdit || completed}
                value={s.validationWindow.start ? toLocal(s.validationWindow.start) : ''}
                onChange={e => updateStep(i, { validationWindow: { ...s.validationWindow, start: fromLocal(e.target.value) } })}
                style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed}
                value={s.validationWindow.end ? toLocal(s.validationWindow.end) : ''}
                onChange={e => updateStep(i, { validationWindow: { ...s.validationWindow, end: fromLocal(e.target.value) } })}
                style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Deploy *</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="datetime-local" disabled={!canEdit || completed}
                value={s.releaseWindow.start ? toLocal(s.releaseWindow.start) : ''}
                onChange={e => updateStep(i, { releaseWindow: { ...s.releaseWindow, start: fromLocal(e.target.value) } })}
                style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed}
                value={s.releaseWindow.end ? toLocal(s.releaseWindow.end) : ''}
                onChange={e => updateStep(i, { releaseWindow: { ...s.releaseWindow, end: fromLocal(e.target.value) } })}
                style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
        </div>
      ))}

      {canEdit && !completed && (
        <button type="button" onClick={() => { setSteps([...steps, emptyStep()]); setDirty(true) }}
          style={{ background: 'none', border: '1.5px dashed #e5e7eb', borderRadius: 8, padding: '8px 16px', color: 'var(--color-brand)', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
          <Plus size={14} /> Aggiungi step
        </button>
      )}

      {canEdit && !completed && dirty && allComplete && (
        <button type="button" onClick={onSave}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--color-brand)', background: '#fff', color: 'var(--color-brand)', fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
          Salva piano
        </button>
      )}

      {!completed && (
        <StickyAction
          label="Completa piano"
          disabled={!canEdit || !allComplete || dirty}
          blockReason={!canEdit ? 'Non sei nel team corretto' : !allComplete ? 'Compila tutti gli step prima di completare' : dirty ? 'Salva le modifiche prima di completare' : undefined}
          onClick={onComplete}
        />
      )}
    </div>
  )
}
