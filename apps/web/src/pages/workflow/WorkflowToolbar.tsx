import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { colors } from '@/lib/tokens'
import type { WorkflowDefinition, WorkflowKey } from './workflow-types'
import { ADD_WORKFLOW_STEP } from '@/graphql/mutations'

const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  incident:  'Incident',
  standard:  'Standard Change',
  normal:    'Normal Change',
  emergency: 'Emergency Change',
}

const SPECIAL_STEP_TYPES = [
  { type: 'parallel_fork', label: '⑂ Fork',       name: 'parallel_fork' },
  { type: 'parallel_join', label: '⑂ Join',       name: 'parallel_join' },
  { type: 'timer_wait',    label: '⏱ Timer Wait', name: 'timer_wait'    },
  { type: 'sub_workflow',  label: '⊞ Sub-Workflow', name: 'sub_workflow' },
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
  const navigate            = useNavigate()
  const [showAddStep, setShowAddStep] = useState(false)
  const [stepType,    setStepType]    = useState('parallel_fork')
  const [stepLabel,   setStepLabel]   = useState('')
  const [timerMins,   setTimerMins]   = useState('')
  const accentColor  = colors.brand
  const canSave      = (hasChanges || pendingCount > 0) && !!def

  const [addWorkflowStep, { loading: addingStep }] = useMutation(ADD_WORKFLOW_STEP, {
    onCompleted: () => { toast.success('Step aggiunto'); setShowAddStep(false); setStepLabel(''); setTimerMins(''); onRefetch?.() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  return (
    <div style={{
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'space-between',
      padding:         '12px 24px',
      borderBottom:    '1px solid #e2e6f0',
      backgroundColor: '#ffffff',
      flexShrink:      0,
    }}>
      <div>
        <button
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
          <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
            {WORKFLOW_LABELS[selectedWorkflow]}
          </h1>
          {def && (
            <span style={{
              fontSize:        11,
              fontWeight:      600,
              padding:         '2px 8px',
              borderRadius:    100,
              backgroundColor: 'var(--color-brand-a08)',
              color:           accentColor,
            }}>
              v{def.version} · Attivo
            </span>
          )}
          {def?.changeSubtype && (() => {
            const subtypeStyles: Record<string, { bg: string; fg: string }> = {
              standard:  { bg: '#dcfce7', fg: '#166534' },
              normal:    { bg: '#dbeafe', fg: '#1e40af' },
              emergency: { bg: '#fee2e2', fg: '#991b1b' },
            }
            const s = subtypeStyles[def.changeSubtype] ?? { bg: '#f3f4f6', fg: '#374151' }
            return (
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px',
                borderRadius: 4, backgroundColor: s.bg, color: s.fg,
              }}>
                {def.changeSubtype === 'standard' ? 'Standard' : def.changeSubtype === 'normal' ? 'Normal' : 'Emergency'}
              </span>
            )
          })()}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {def && (
          <button
            onClick={() => setShowAddStep(true)}
            style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #e2e6f0', background: '#fff', cursor: 'pointer', fontSize: 13, color: 'var(--color-slate)' }}
          >
            + Step
          </button>
        )}
        <button
          disabled={!canSave}
          onClick={onSave}
          style={{
            padding:         '8px 18px',
            backgroundColor: canSave ? accentColor : '#e2e6f0',
            color:           canSave ? '#ffffff' : 'var(--color-slate-light)',
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddStep(false) }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 380, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Aggiungi Step</div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>TIPO</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SPECIAL_STEP_TYPES.map(s => (
                  <button key={s.type} onClick={() => setStepType(s.type)} style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${stepType === s.type ? accentColor : '#e2e6f0'}`, background: stepType === s.type ? 'var(--color-brand-a08)' : '#fff', color: stepType === s.type ? accentColor : 'var(--color-slate)', cursor: 'pointer', fontSize: 13 }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>LABEL</div>
              <input value={stepLabel} onChange={e => setStepLabel(e.target.value)} placeholder="es. Attesa Timer" style={{ width: '100%', padding: '7px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
            </div>
            {stepType === 'timer_wait' && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>RITARDO (minuti)</div>
                <input type="number" min={1} value={timerMins} onChange={e => setTimerMins(e.target.value)} placeholder="es. 60" style={{ width: '100%', padding: '7px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAddStep(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: '#fff', cursor: 'pointer', fontSize: 13, color: 'var(--color-slate)' }}>Annulla</button>
              <button
                disabled={!stepLabel.trim() || addingStep}
                onClick={() => {
                  const name = stepLabel.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
                  void addWorkflowStep({ variables: {
                    definitionId: def.id, name: `${stepType}_${name}_${Date.now().toString(36)}`,
                    label: stepLabel.trim(), type: stepType,
                    timerDelayMinutes: stepType === 'timer_wait' && timerMins ? Number(timerMins) : undefined,
                  } })
                }}
                style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: accentColor, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                Aggiungi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
