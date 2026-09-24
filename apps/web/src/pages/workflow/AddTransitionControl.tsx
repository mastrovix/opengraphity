/**
 * Adding a transition without dragging.
 *
 * Review of 23 Sep 2026: an arrow could be drawn only by dragging a handle of
 * the step, which a keyboard user cannot do. Under the panel of the selected
 * step, this picks the step the arrow leads to and creates it exactly as a
 * drawn arrow is created (`onConnect` of the canvas).
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Select } from '@/components/ui/FormControls'
import { colors } from '@/lib/tokens'

export interface StepChoice { id: string; name: string; label: string }

export function AddTransitionControl({ fromStepId, steps, onAdd }: {
  /** The step the arrow starts from. */
  fromStepId: string
  /** The steps of the workflow; the one it starts from is not offered. */
  steps: StepChoice[]
  onAdd: (toStepId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const selectId = useId()
  const [target, setTarget] = useState('')
  const choices = steps.filter((s) => s.id !== fromStepId)

  return (
    <div style={{ marginTop: 8, padding: 12, width: 320, boxSizing: 'border-box', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
      <label htmlFor={selectId} style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
        {t('pages.workflow.addTransitionTo')}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <Select id={selectId} value={target} onChange={(e) => setTarget(e.target.value)} style={{ flex: 1 }}>
          <option value="">{t('pages.workflow.pickStep')}</option>
          {choices.map((s) => <option key={s.id} value={s.id}>{s.label || s.name}</option>)}
        </Select>
        <Button size="xs" disabled={!target} onClick={async () => { await onAdd(target); setTarget('') }}>
          {t('pages.workflow.addTransition')}
        </Button>
      </div>
    </div>
  )
}
