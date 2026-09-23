/**
 * Pure form for the deploy plan: the list of steps is owned by the parent,
 * so the parent decides when state resets (e.g. on task change). The form
 * notifies the parent on every edit and on explicit save/complete.
 */
import { useId } from 'react'
import { useTenantTimezone } from '@/hooks/useTenantTimezone'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { TASK_STATUS } from '@/lib/taskStatus'
import type { DeployPlanTaskData, DeployStep } from '@/types/change'
import { StickyAction, inputStyle, labelStyle, toLocal, fromLocal } from './shared'
import { colors, palette } from '@/lib/tokens'

const emptyStep = (): DeployStep => ({
  title: '',
  validationWindow: { start: '', end: '' },
  releaseWindow: { start: '', end: '' },
})

const isStepComplete = (s: DeployStep) =>
  s.title.trim().length > 0 &&
  !!s.validationWindow.start && !!s.validationWindow.end &&
  !!s.releaseWindow.start    && !!s.releaseWindow.end

export function PlanTaskForm({ task, steps, setSteps, dirty, setDirty, canEdit, onSave, onComplete, busyLabel = null }: {
  task: DeployPlanTaskData
  steps: DeployStep[]
  setSteps: (s: DeployStep[]) => void
  dirty: boolean
  setDirty: (d: boolean) => void
  canEdit: boolean
  onSave: () => void
  onComplete: () => void
  /** The plan is being saved or completed: «Complete» waits (D24). */
  busyLabel?: string | null
}) {
  const { t } = useTranslation()
  const baseId = useId()
  /**
   * F-13: le finestre si pianificano nel fuso dell'ORGANIZZAZIONE, non in
   * quello del browser. Finché non è arrivato vale il fuso del browser, e
   * l'etichetta dice sempre quale dei due si sta usando.
   */
  const { timeZone } = useTenantTimezone()
  const zoneLabel = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const completed = task.status === TASK_STATUS.COMPLETED
  const allComplete = steps.length >= 1 && steps.every(isStepComplete)
  const updateStep = (i: number, patch: Partial<DeployStep>) => {
    setSteps(steps.map((x, j) => j === i ? { ...x, ...patch } : x))
    setDirty(true)
  }

  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 14, marginBottom: 10, background: 'var(--color-slate-bg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={labelStyle}>{t('changeTasks.stepN', { n: i + 1 })}</span>
            {canEdit && !completed && (
              <button
                type="button"
                // Only an icon inside: the name says what it does, and to which step.
                aria-label={t('pages.planTask.removeStep', { n: i + 1 })}
                onClick={() => { setSteps(steps.filter((_, j) => j !== i)); setDirty(true) }}
                style={{ background: 'none', border: `1px solid ${palette.danger.border}`, color: 'var(--color-danger)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              ><X size={12} /></button>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <label htmlFor={`${baseId}-title-${i}`} style={labelStyle}>{t('pages.serviceRequestDetail.titleRequired')}</label>
            <input
              id={`${baseId}-title-${i}`}
              type="text" disabled={!canEdit || completed} value={s.title}
              onChange={e => updateStep(i, { title: e.target.value })}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            {/* F-13: l'etichetta dice in quale fuso si stanno scrivendo le ore. */}
            <label htmlFor={`${baseId}-val-start-${i}`} style={labelStyle}>{t('pages.planTask.validation')} <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>({zoneLabel})</span></label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input id={`${baseId}-val-start-${i}`} type="datetime-local" disabled={!canEdit || completed}
                value={s.validationWindow.start ? toLocal(s.validationWindow.start, timeZone) : ''}
                onChange={e => updateStep(i, { validationWindow: { ...s.validationWindow, start: fromLocal(e.target.value, timeZone) } })}
                style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed} aria-label={t('pages.planTask.validationEnd')}
                value={s.validationWindow.end ? toLocal(s.validationWindow.end, timeZone) : ''}
                onChange={e => updateStep(i, { validationWindow: { ...s.validationWindow, end: fromLocal(e.target.value, timeZone) } })}
                style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
          <div>
            <label htmlFor={`${baseId}-rel-start-${i}`} style={labelStyle}>{t('changeTasks.deploy')} * <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>({zoneLabel})</span></label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input id={`${baseId}-rel-start-${i}`} type="datetime-local" disabled={!canEdit || completed}
                value={s.releaseWindow.start ? toLocal(s.releaseWindow.start, timeZone) : ''}
                onChange={e => updateStep(i, { releaseWindow: { ...s.releaseWindow, start: fromLocal(e.target.value, timeZone) } })}
                style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed} aria-label={t('pages.planTask.deployEnd')}
                value={s.releaseWindow.end ? toLocal(s.releaseWindow.end, timeZone) : ''}
                onChange={e => updateStep(i, { releaseWindow: { ...s.releaseWindow, end: fromLocal(e.target.value, timeZone) } })}
                style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
        </div>
      ))}

      {canEdit && !completed && (
        <button type="button" onClick={() => { setSteps([...steps, emptyStep()]); setDirty(true) }}
          style={{ background: 'none', border: `1.5px dashed ${colors.border}`, borderRadius: 8, padding: '8px 16px', color: 'var(--color-brand)', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
          <Plus size={14} /> {t('changeTasks.addStep')}
        </button>
      )}

      {canEdit && !completed && dirty && allComplete && (
        <button type="button" onClick={onSave}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--color-brand)', background: colors.white, color: 'var(--color-brand)', fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
          {t('changeTasks.savePlan')}
        </button>
      )}

      {!completed && (
        <StickyAction
          label={t('pages.planTask.complete')}
          disabled={!canEdit || !allComplete || dirty}
          blockReason={!canEdit ? t('pages.planTask.wrongTeam') : !allComplete ? t('pages.planTask.fillAll') : dirty ? t('pages.planTask.saveFirst') : undefined}
          onClick={onComplete}
          busyLabel={busyLabel}
        />
      )}
    </div>
  )
}
