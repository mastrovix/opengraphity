import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { lookupOrError } from '@/lib/tokens'
import { GET_CI_CHANGES } from '@/graphql/queries'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { styleForCategory } from '@/lib/workflowStepStyle'

interface ChangeRow {
  id:                 string
  code:               string
  title:              string
  workflowInstance:   { currentStep: string } | null
  aggregateRiskScore: number | null
  approvalStatus:     string | null
  createdAt:          string
}

function PhaseBadge({ phase, label, category }: {
  phase: string; label?: string; category?: string | null
}) {
  const s = styleForCategory(category)
  return (
    <span style={{
      padding:         '2px 8px',
      borderRadius:    6,
      fontSize:        'var(--font-size-label)',
      fontWeight:      600,
      backgroundColor: s.bg,
      color:           s.color,
      marginTop:       1,
      flexShrink:      0,
      textTransform:   'capitalize',
    }}>
      {label || phase}
    </span>
  )
}

function RiskPill({ score }: { score: number | null }) {
  if (score == null) return null
  const level = score <= 30 ? 'low' : score <= 60 ? 'medium' : 'high'
  const palette: Record<string, { bg: string; color: string }> = {
    low:    { bg: '#dcfce7', color: '#15803d' },
    medium: { bg: '#fef3c7', color: '#b45309' },
    high:   { bg: '#fee2e2', color: '#b91c1c' },
  }
  const p = lookupOrError(palette, level, 'RISK_PALETTE', palette['low']!)
  return (
    <span style={{
      padding:         '1px 6px',
      borderRadius:    4,
      fontSize:        'var(--font-size-label)',
      fontWeight:      600,
      backgroundColor: p.bg,
      color:           p.color,
      flexShrink:      0,
    }}>
      {score}
    </span>
  )
}

export function CIChangeList({ ciId }: { ciId: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const { data } = useQuery<{ ciChanges: ChangeRow[] }>(GET_CI_CHANGES, {
    variables: { ciId },
  })
  const { isTerminal: isChangeTerminal, byName: changeStepByName } = useWorkflowSteps('change')

  const changes = data?.ciChanges ?? []
  const stepOf = (c: ChangeRow) => c.workflowInstance?.currentStep ?? ''
  const active  = changes.filter(c => !isChangeTerminal(stepOf(c)))
  const closed  = changes.filter(c =>  isChangeTerminal(stepOf(c)))

  function renderRow(ch: ChangeRow, faded = false) {
    return (
      <div
        key={ch.id}
        onClick={() => navigate(`/changes/${ch.id}`)}
        style={{
          display:      'flex',
          alignItems:   'flex-start',
          gap:          8,
          padding:      '6px 0',
          borderBottom: '1px solid #f9fafb',
          cursor:       'pointer',
          opacity:      faded ? 0.5 : 1,
        }}
      >
        {(() => {
          const step = stepOf(ch); const meta = changeStepByName.get(step)
          return <PhaseBadge phase={step} label={meta?.label} category={meta?.category ?? null} />
        })()}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize:      'var(--font-size-body)',
            fontWeight:    500,
            color:         'var(--color-slate-dark)',
            whiteSpace:    'nowrap',
            overflow:      'hidden',
            textOverflow:  'ellipsis',
          }}>
            {ch.code}
          </div>
          <div style={{
            fontSize:     'var(--font-size-table)',
            color:        'var(--color-slate-light)',
            whiteSpace:   'nowrap',
            overflow:     'hidden',
            textOverflow: 'ellipsis',
          }}>
            {ch.title}
          </div>
        </div>
        <RiskPill score={ch.aggregateRiskScore} />
      </div>
    )
  }

  function renderGroup(label: string, items: ChangeRow[], faded = false) {
    if (items.length === 0) return null
    return (
      <div style={{ marginTop: 12 }}>
        <div style={{
          fontSize:      'var(--font-size-label)',
          fontWeight:    600,
          color:         'var(--color-slate)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          padding:       '4px 0 6px 0',
        }}>
          {label}
        </div>
        <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
          {items.map(c => renderRow(c, faded))}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      background:   '#fff',
      border:       '1px solid #e5e7eb',
      borderRadius: 10,
      marginBottom: 16,
      overflow:     'hidden',
    }}>
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          cursor:         'pointer',
          padding:        '14px 20px',
          borderBottom:   open ? '1px solid #e5e7eb' : 'none',
        }}
      >
        <span style={{
          fontSize:   'var(--font-size-card-title)',
          fontWeight: 600,
          color:      'var(--color-slate-dark)',
          display:    'flex',
          alignItems: 'center',
        }}>
          Change <CountBadge count={changes.length} />
        </span>
        {open
          ? <ChevronDown size={16} color="var(--color-slate-light)" />
          : <ChevronRight size={16} color="var(--color-slate-light)" />
        }
      </div>
      {open && (
        <div style={{ padding: '0 20px 16px' }}>
          {changes.length === 0
            ? <p style={{
                fontSize: 'var(--font-size-body)',
                color:    'var(--color-slate-light)',
                margin:   '12px 0 0',
              }}>Nessun change su questo CI.</p>
            : (
              <>
                {renderGroup('In corso',   active)}
                {renderGroup('Completati', closed, true)}
              </>
            )
          }
        </div>
      )}
    </div>
  )
}
