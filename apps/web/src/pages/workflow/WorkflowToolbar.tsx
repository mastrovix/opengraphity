import { Chip } from '@/components/ui/Chip'
import { BackLink } from '@/components/ui/BackLink'
import { Input } from '@/components/ui/FormControls'
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard'
import { useConfirm } from '@/hooks/useConfirm'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import type { WorkflowDefinition } from './workflow-types'
import { ADD_WORKFLOW_STEP } from '@/graphql/mutations'
import { Pill } from '@/components/ui/Pill'
import { showError } from '@/lib/showError'

/**
 * I tipi di passo che si possono aggiungere.
 *
 * Revisione delle otto ondate · B·M-1: qui c'erano solo i quattro tipi
 * TECNICI, e per le change il bottone era nascosto del tutto. Quindi tutte e
 * otto le ondate ragionavano sull'amministratore che «inserisce un passo CAB
 * fra approvazione e programmazione» — e dall'interfaccia non si poteva: il
 * solo modo era la mutation GraphQL a mano. Il difetto che le ondate hanno
 * chiuso era raggiungibile solo via API, mentre quello che restava aperto
 * (togliere lo scopo dalla tendina) con due clic.
 *
 * `standard` è il passo di processo, ed è il primo della lista perché è quello
 * che serve normalmente.
 */
const SPECIAL_STEP_TYPES = [
  // Terza revisione: le etichette erano LETTERALI, e mescolavano due lingue nel
  // medesimo menu («Passo», «Fork», «Join», «Timer Wait», «Sub-Workflow»). Per
  // un cliente inglese «Passo» restava «Passo». Il simbolo resta qui — e
  // grafica, non testo — e la parola viene dal vocabolario delle traduzioni.
  //
  // ONDATA 10: qui c'erano anche «Biforcazione», «Ricongiunzione» e
  // «Sotto-workflow». Il motore non li esegue — un `parallel_fork` seguiva UNA
  // transizione come un passo normale, e chi aveva disegnato due rami ne
  // vedeva partire uno solo, senza un errore. Offrire un attrezzo che non fa
  // quello che disegna è peggio che non averlo. L'elenco di quello che il
  // motore sa fare è `ADDABLE_STEP_TYPES` in `@opengraphity/types`, e un test
  // tiene insieme le due sponde.
  { type: 'standard',      glyph: '▢', labelKey: 'workflow.stepType.standard',      name: 'step'          },
  { type: 'timer_wait',    glyph: '⏱', labelKey: 'workflow.stepType.timer_wait',    name: 'timer_wait'    },
]

interface WorkflowToolbarProps {
  def:              WorkflowDefinition | null
  hasChanges:       boolean
  pendingCount:     number
  onSave:           () => void
  onRefetch?:       () => void
}

export function WorkflowToolbar({
  def,
  hasChanges,
  pendingCount,
  onSave,
  onRefetch,
}: WorkflowToolbarProps) {
  const { t } = useTranslation()
  const navigate            = useNavigate()
  const [showAddStep, setShowAddStep] = useState(false)
  const [stepType,    setStepType]    = useState('standard')
  const [stepLabel,   setStepLabel]   = useState('')
  const [timerMins,   setTimerMins]   = useState('')
  const accentColor  = colors.brand
  const canSave      = (hasChanges || pendingCount > 0) && !!def
  // Changes kept locally until «Save changes»: leaving asks first (review of 23 Sep 2026).
  const dirty        = hasChanges || pendingCount > 0
  const confirm      = useConfirm()
  // Lo slug dell'etichetta: per un passo di processo È il nome, e il nome
  // diventa lo stato del ticket. Un'etichetta che non produce nessuno slug
  // («!!!», «2») darebbe un nome che il server rifiuta: meglio non offrirlo.
  const stepSlug = stepLabel.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '')

  const [addWorkflowStep, { loading: addingStep }] = useMutation(ADD_WORKFLOW_STEP, {
    onCompleted: () => { toast.success(t('toast.workflow.stepAdded')); setShowAddStep(false); setStepLabel(''); setTimerMins(''); onRefetch?.() },
    onError: (e: { message: string }) => showError(e),
  })

  return (
    <div style={{
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'space-between',
      padding:         '12px 24px',
      borderBottom:    '1px solid var(--color-border)',
      backgroundColor: colors.white,
      flexShrink:      0,
    }}>
      <div>
        <UnsavedChangesGuard when={dirty} title={t('workflow.designer.discardTitle')} body={t('workflow.designer.discardBody', { count: pendingCount })} confirmLabel={t('workflow.designer.leave')} />
        <BackLink onClick={async () => {
            if (dirty && !(await confirm({ title: t('workflow.designer.discardTitle'), body: t('workflow.designer.discardBody', { count: pendingCount }), confirmLabel: t('workflow.designer.leave'), danger: true }))) return
            navigate('/workflow', { state: { leaveConfirmed: true } })
          }}>{t('pages.workflow.title')}</BackLink>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
            {/* Il nome del workflow del cliente. Revisione del 14 set 2026 · F16: era
                «Incident» per gli incident e «Standard Change» per TUTTI gli altri
                workflow, problem e service request compresi. */}
            {def?.name ?? ''}
          </h1>
          {def && (
            <Pill bg="var(--color-brand-a08)" color={accentColor} radius={100} style={{ fontSize: 11 }}>
              v{def.version} · {t('common.active')}
            </Pill>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {def && (
          <Button variant="secondary"
            onClick={() => setShowAddStep(true)}
          >
            + {t('workflow.addStep')}
          </Button>
        )}
        <button
          type="button"
          disabled={!canSave}
          onClick={onSave}
          style={{
            padding:         '8px 18px',
            backgroundColor: canSave ? accentColor : colors.border,
            color:           canSave ? colors.white : 'var(--color-slate-light)',
            border:          'none',
            borderRadius:    7,
            fontSize:        13,
            fontWeight:      600,
            cursor:          canSave ? 'pointer' : 'not-allowed',
            display:         'flex',
            alignItems:      'center',
            gap:             8,
          }}
        >
          {t('common.saveChanges')}
          {pendingCount > 0 && (
            <Pill bg={colors.brand} color={colors.white} radius={100} style={{ fontSize:        11, fontWeight:      700 }}>
              {pendingCount}
            </Pill>
          )}
        </button>
      </div>

      {/* Add Step Dialog */}
      {showAddStep && def && (
        <Modal
          open
          onClose={() => setShowAddStep(false)}
          title={t('workflow.addStepDialog')}
          width={380}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowAddStep(false)} style={{ padding: '7px 14px', border: '1px solid var(--color-border)' }}>{t('common.cancel')}</Button>
              <Button
                // A timed wait needs its delay (review of 23 Sep 2026): the server refuses it without one.
                disabled={!stepLabel.trim() || addingStep || (stepType === 'standard' && !stepSlug)
                  || (stepType === 'timer_wait' && !(Number.isInteger(Number(timerMins)) && Number(timerMins) > 0))}
                onClick={() => {
                  const name = stepSlug
                  // Il nome di un passo di processo diventa lo `status` del
                  // ticket, e finisce nei filtri e nei report: è lo slug
                  // dell'etichetta, non `tipo_slug_timestamp` (revisione ·
                  // B·M-1). Se quel nome è già usato il server lo dice; per i
                  // tipi tecnici il nome generato resta, perché non è uno stato
                  // che qualcuno legge.
                  const stepName = stepType === 'standard'
                    ? name
                    : `${stepType}_${name}_${Date.now().toString(36)}`
                  void addWorkflowStep({ variables: {
                    definitionId: def.id, name: stepName,
                    label: stepLabel.trim(), type: stepType,
                    timerDelayMinutes: stepType === 'timer_wait' && timerMins ? Number(timerMins) : undefined,
                  } })
                }}
                style={{ padding: '7px 16px', backgroundColor: accentColor, fontSize: 'var(--font-size-body)', fontWeight: 600 }}
              >
                {t('pages.questions.add')}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>{t('common.type').toUpperCase()}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SPECIAL_STEP_TYPES.map(s => (
                  <Chip pressed={stepType === s.type} key={s.type} onClick={() => setStepType(s.type)}>
                    {s.glyph} {t(s.labelKey)}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>{t('common.label')}</div>
              <Input aria-label={t(stepType === 'standard' ? 'pages.workflowStep.labelPlaceholder' : 'pages.workflowStep.labelPlaceholderTimer')} value={stepLabel} onChange={e => setStepLabel(e.target.value)} placeholder={t(stepType === 'standard' ? 'pages.workflowStep.labelPlaceholder' : 'pages.workflowStep.labelPlaceholderTimer')} />
            </div>
            {stepType === 'standard' && (
              <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.45 }}>
                {t('workflow.addStepStandardHint')}
              </div>
            )}
            {stepType === 'timer_wait' && (
              <div>
                <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>{t('pages.workflowStep.timerDelay')}</div>
                <Input aria-label={t('workflow.timerMinutesPlaceholder')} type="number" min={1} value={timerMins} onChange={e => setTimerMins(e.target.value)} placeholder={t('workflow.timerMinutesPlaceholder')} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
