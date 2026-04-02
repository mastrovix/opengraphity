import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@/lib/tokens'
import type { WorkflowDefinition, WorkflowKey } from './workflow-types'

const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  incident:  'Incident',
  standard:  'Standard Change',
  normal:    'Normal Change',
  emergency: 'Emergency Change',
}

interface WorkflowToolbarProps {
  def:              WorkflowDefinition | null
  selectedWorkflow: WorkflowKey
  hasChanges:       boolean
  pendingCount:     number
  onSave:           () => void
}

export function WorkflowToolbar({
  def,
  selectedWorkflow,
  hasChanges,
  pendingCount,
  onSave,
}: WorkflowToolbarProps) {
  const navigate     = useNavigate()
  const accentColor  = colors.brand
  const canSave      = (hasChanges || pendingCount > 0) && !!def

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
          <ArrowLeft size={13} />
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
        </div>
      </div>

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
  )
}
