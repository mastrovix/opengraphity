import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import type { WorkflowDefinition, WorkflowKey } from './workflow-types'
import { ADD_WORKFLOW_STEP } from '@/graphql/mutations'
import { Pill } from '@/components/ui/Pill'

const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  incident:  'Incident',
  standard:  'Standard Change',
  normal:    'Normal Change',
  emergency: 'Emergency Change',
}

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
  { type: 'standard',      label: '▢ Passo',        name: 'step'          },
  { type: 'parallel_fork', label: '⑂ Fork',         name: 'parallel_fork' },
  { type: 'parallel_join', label: '⑂ Join',         name: 'parallel_join' },
  { type: 'timer_wait',    label: '⏱ Timer Wait',   name: 'timer_wait'    },
  { type: 'sub_workflow',  label: '⊞ Sub-Workflow', name: 'sub_workflow'  },
]

interface WorkflowToolbarProps {
  def:              WorkflowDefinition | null
  selectedWorkflow: WorkflowKey
  hasChanges:       boolean
  pendingCount:     number
  onSave:           () => void
  onRefetch?:       () => void
}

export function WorkflowToolbar({
  def,
  selectedWorkflow,
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
  // Lo slug dell'etichetta: per un passo di processo È il nome, e il nome
  // diventa lo stato del ticket. Un'etichetta che non produce nessuno slug
  // («!!!», «2») darebbe un nome che il server rifiuta: meglio non offrirlo.
  const stepSlug = stepLabel.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '')

  const [addWorkflowStep, { loading: addingStep }] = useMutation(ADD_WORKFLOW_STEP, {
    onCompleted: () => { toast.success(t('toast.workflow.stepAdded')); setShowAddStep(false); setStepLabel(''); setTimerMins(''); onRefetch?.() },
    onError: (e: { message: string }) => toast.error(e.message),
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
        <button
          type="button"
          onClick={() => navigate('/workflow')}
          style={{
            display:      'inline-flex',
            alignItems:   'center',
            gap:          6,
            marginBottom: 8,
            background:   'none',
            border:       'none',
            cursor:       'pointer',
            color:        'var(--color-slate-light)',
            fontSize:     12,
            padding:      0,
          }}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Workflow
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
            {WORKFLOW_LABELS[selectedWorkflow]}
          </h1>
          {def && (
            <Pill bg="var(--color-brand-a08)" color={accentColor} radius={100} style={{ fontSize: 11 }}>
              v{def.version} · Attivo
            </Pill>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {def && (
          <button
            type="button"
            onClick={() => setShowAddStep(true)}
            style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--color-border)', background: colors.white, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}
          >
            + Step
          </button>
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
          Salva modifiche
          {pendingCount > 0 && (
            <span style={{
              fontSize:        11,
              fontWeight:      700,
              padding:         '1px 7px',
              borderRadius:    100,
              backgroundColor: colors.brand,
              color:           colors.white,
            }}>
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {/* Add Step Dialog */}
      {showAddStep && def && (
        <Modal
          open
          onClose={() => setShowAddStep(false)}
          title="Aggiungi Step"
          width={380}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowAddStep(false)} style={{ padding: '7px 14px', border: '1px solid var(--color-border)' }}>Annulla</Button>
              <Button
                disabled={!stepLabel.trim() || addingStep || (stepType === 'standard' && !stepSlug)}
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
                Aggiungi
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>TIPO</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SPECIAL_STEP_TYPES.map(s => (
                  <button type="button" key={s.type} aria-pressed={stepType === s.type} onClick={() => setStepType(s.type)} style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${stepType === s.type ? accentColor : 'var(--color-border)'}`, background: stepType === s.type ? 'var(--color-brand-a08)' : colors.white, color: stepType === s.type ? accentColor : 'var(--color-slate)', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>LABEL</div>
              <input value={stepLabel} onChange={e => setStepLabel(e.target.value)} placeholder={stepType === 'standard' ? 'es. CAB settimanale' : 'es. Attesa Timer'} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }} />
            </div>
            {stepType === 'standard' && (
              <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.45 }}>
                {t('workflow.addStepStandardHint')}
              </div>
            )}
            {stepType === 'timer_wait' && (
              <div>
                <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 4 }}>RITARDO (minuti)</div>
                <input type="number" min={1} value={timerMins} onChange={e => setTimerMins(e.target.value)} placeholder="es. 60" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
