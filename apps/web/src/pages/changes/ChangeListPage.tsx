import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { GET_CHANGES } from '@/graphql/queries'

interface WorkflowInstance { id: string; currentStep: string; status: string }
interface Team { id: string; name: string }
interface User { id: string; name: string }
interface CI { id: string; name: string; type: string }

interface Change {
  id: string
  title: string
  type: string
  priority: string
  status: string
  scheduledStart: string | null
  scheduledEnd: string | null
  createdAt: string
  assignedTeam: Team | null
  assignee: User | null
  affectedCIs: CI[]
  workflowInstance: WorkflowInstance | null
}

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  standard:  { bg: '#ecfdf5', color: '#059669' },
  normal:    { bg: '#eff6ff', color: '#2563eb' },
  emergency: { bg: '#fef2f2', color: '#dc2626' },
}

const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: '#dc2626' },
  high:     { bg: '#fff7ed', color: '#ea580c' },
  medium:   { bg: '#fefce8', color: '#ca8a04' },
  low:      { bg: '#f0fdf4', color: '#16a34a' },
}

const STEP_COLORS: Record<string, { bg: string; color: string }> = {
  draft:              { bg: '#f3f4f6', color: '#6b7280' },
  assessment:         { bg: '#eff6ff', color: '#2563eb' },
  planning:           { bg: '#f0f9ff', color: '#0369a1' },
  cab_approval:       { bg: '#fefce8', color: '#ca8a04' },
  scheduled:          { bg: '#f5f3ff', color: '#7c3aed' },
  validation:         { bg: '#fff7ed', color: '#ea580c' },
  deployment:         { bg: '#ecfdf5', color: '#059669' },
  completed:          { bg: '#ecfdf5', color: '#059669' },
  failed:             { bg: '#fef2f2', color: '#dc2626' },
  approved:           { bg: '#ecfdf5', color: '#059669' },
  emergency_approval: { bg: '#fef2f2', color: '#dc2626' },
  rejected:           { bg: '#f3f4f6', color: '#6b7280' },
  post_review:        { bg: '#eff6ff', color: '#2563eb' },
}

function TypeBadge({ value }: { value: string }) {
  const c = TYPE_COLORS[value] ?? { bg: '#f3f4f6', color: '#6b7280' }
  return (
    <span style={{ ...c, padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {value}
    </span>
  )
}

function PriorityBadge({ value }: { value: string }) {
  const c = PRIORITY_COLORS[value] ?? { bg: '#f3f4f6', color: '#6b7280' }
  return (
    <span style={{ ...c, padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {value}
    </span>
  )
}

function StepBadge({ value }: { value: string }) {
  const c = STEP_COLORS[value] ?? { bg: '#f3f4f6', color: '#6b7280' }
  return (
    <span style={{ ...c, padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600 }}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

type FilterType = 'all' | 'standard' | 'normal' | 'emergency'
type StatusFilter = 'all' | 'active' | 'completed' | 'failed'

export function ChangeListPage() {
  const navigate = useNavigate()

  const [selectedType, setSelectedType] = useState<FilterType>('all')
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all')

  const { data, loading } = useQuery<{ changes: Change[] }>(GET_CHANGES, {
    variables: {
      type: selectedType !== 'all' ? selectedType : undefined,
    },
    fetchPolicy: 'cache-and-network',
  })

  const changes = data?.changes ?? []

  const filtered = changes.filter((c) => {
    if (selectedStatus === 'all') return true
    if (selectedStatus === 'completed') return c.status === 'completed' || (c.workflowInstance?.currentStep === 'completed')
    if (selectedStatus === 'failed') return c.status === 'failed' || (c.workflowInstance?.currentStep === 'failed')
    if (selectedStatus === 'active') return !['completed', 'failed', 'rejected'].includes(c.workflowInstance?.currentStep ?? c.status)
    return true
  })

  const filterBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    border: `1px solid ${active ? '#4f46e5' : '#e2e6f0'}`,
    borderRadius: 6,
    backgroundColor: active ? '#4f46e5' : '#fff',
    color: active ? '#fff' : '#4a5468',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  })

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>Changes</h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${filtered.length} change${filtered.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button
          onClick={() => navigate('/changes/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          Nuovo Change
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, padding: '4px 8px', backgroundColor: '#f8f9fc', borderRadius: 8, border: '1px solid #e2e6f0' }}>
          {(['all', 'standard', 'normal', 'emergency'] as FilterType[]).map((t) => (
            <button key={t} onClick={() => setSelectedType(t)} style={filterBtnStyle(selectedType === t)}>
              {t === 'all' ? 'Tutti i tipi' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '4px 8px', backgroundColor: '#f8f9fc', borderRadius: 8, border: '1px solid #e2e6f0' }}>
          {(['all', 'active', 'completed', 'failed'] as StatusFilter[]).map((s) => (
            <button key={s} onClick={() => setSelectedStatus(s)} style={filterBtnStyle(selectedStatus === s)}>
              {s === 'all' ? 'Tutti gli status' : s === 'active' ? 'In corso' : s === 'completed' ? 'Completati' : 'Falliti'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e2e6f0', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8892a4', fontSize: 14 }}>Caricamento…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8892a4', fontSize: 14 }}>Nessun change trovato</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e2e6f0', backgroundColor: '#f8f9fc' }}>
                {['Titolo', 'Tipo', 'Priorità', 'Step', 'Team', 'Scheduled Start', 'CI', 'Creato'].map((h) => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, idx) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/changes/${c.id}`)}
                  style={{ borderBottom: idx < filtered.length - 1 ? '1px solid #f1f3f8' : 'none', cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '' }}
                >
                  <td style={{ padding: '12px 16px', maxWidth: 260 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', marginBottom: 2 }}>{c.title}</div>
                    <div style={{ fontSize: 11, color: '#8892a4', fontFamily: 'monospace' }}>{c.id.slice(0, 8)}</div>
                  </td>
                  <td style={{ padding: '12px 16px' }}><TypeBadge value={c.type} /></td>
                  <td style={{ padding: '12px 16px' }}><PriorityBadge value={c.priority} /></td>
                  <td style={{ padding: '12px 16px' }}>
                    {c.workflowInstance ? <StepBadge value={c.workflowInstance.currentStep} /> : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#4a5468' }}>{c.assignedTeam?.name ?? '—'}</td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: '#8892a4', whiteSpace: 'nowrap' }}>
                    {c.scheduledStart ? new Date(c.scheduledStart).toLocaleDateString('it-IT') : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {c.affectedCIs.length > 0 ? (
                      <span style={{ backgroundColor: '#eff6ff', color: '#2563eb', padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600 }}>
                        {c.affectedCIs.length} CI
                      </span>
                    ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: '#8892a4', whiteSpace: 'nowrap' }}>
                    {new Date(c.createdAt).toLocaleDateString('it-IT')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
