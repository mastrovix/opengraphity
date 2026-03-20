import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { Bug } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { GET_PROBLEMS } from '@/graphql/queries'
import { CREATE_PROBLEM } from '@/graphql/mutations'

interface ProblemItem {
  id:         string
  title:      string
  priority:   string
  status:     string
  createdAt:  string
  updatedAt:  string | null
  assignee:   { id: string; name: string } | null
  assignedTeam: { id: string; name: string } | null
  affectedCIs:      { id: string; name: string; type: string }[]
  relatedIncidents: { id: string; title: string; status: string }[]
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#fee2e2',
  high:     '#ffedd5',
  medium:   '#fef9c3',
  low:      '#dcfce7',
}

const PRIORITY_TEXT: Record<string, string> = {
  critical: '#dc2626',
  high:     '#ea580c',
  medium:   '#ca8a04',
  low:      '#16a34a',
}

const STATUS_COLOR: Record<string, string> = {
  new:                '#f3f4f6',
  under_investigation: '#dbeafe',
  change_requested:   '#f3e8ff',
  change_in_progress: '#e0e7ff',
  resolved:           '#dcfce7',
  closed:             '#1f2937',
  rejected:           '#fee2e2',
  deferred:           '#fef9c3',
}

const STATUS_TEXT: Record<string, string> = {
  new:                '#6b7280',
  under_investigation: '#1d4ed8',
  change_requested:   '#7e22ce',
  change_in_progress: '#3730a3',
  resolved:           '#15803d',
  closed:             '#f9fafb',
  rejected:           '#dc2626',
  deferred:           '#a16207',
}

function PriorityBadge({ value }: { value: string }) {
  return (
    <span style={{
      display:         'inline-block',
      padding:         '2px 8px',
      borderRadius:    4,
      backgroundColor: PRIORITY_COLOR[value] ?? '#f3f4f6',
      color:           PRIORITY_TEXT[value]  ?? '#6b7280',
      fontSize:        12,
      fontWeight:      600,
    }}>
      {value}
    </span>
  )
}

function StatusBadge({ value }: { value: string }) {
  return (
    <span style={{
      display:         'inline-block',
      padding:         '2px 8px',
      borderRadius:    4,
      backgroundColor: STATUS_COLOR[value] ?? '#f3f4f6',
      color:           STATUS_TEXT[value]  ?? '#6b7280',
      fontSize:        12,
      fontWeight:      500,
    }}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

const PAGE_SIZE = 50

export function ProblemsPage() {
  const navigate = useNavigate()
  const [page, setPage]         = useState(0)
  const [statusFilter, setStatusFilter]     = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [searchText, setSearchText]         = useState('')
  const [showCreate, setShowCreate]         = useState(false)

  const [newTitle, setNewTitle]           = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPriority, setNewPriority]     = useState('medium')
  const [newWorkaround, setNewWorkaround] = useState('')

  const { data, loading, refetch } = useQuery<{
    problems: { items: ProblemItem[]; total: number }
  }>(GET_PROBLEMS, {
    variables: {
      limit:    PAGE_SIZE,
      offset:   page * PAGE_SIZE,
      status:   statusFilter  || undefined,
      priority: priorityFilter || undefined,
      search:   searchText    || undefined,
    },
  })

  const [createProblem, { loading: creating }] = useMutation<{ createProblem: { id: string } }>(CREATE_PROBLEM, {
    onCompleted: (res) => {
      toast.success('Problem creato')
      setShowCreate(false)
      setNewTitle('')
      setNewDescription('')
      setNewPriority('medium')
      setNewWorkaround('')
      void refetch()
      if (res.createProblem?.id) navigate(`/problems/${res.createProblem.id}`)
    },
    onError: (err) => toast.error(err.message),
  })

  const items = data?.problems?.items ?? []
  const total = data?.problems?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            Problems
          </h1>
          <p style={{ fontSize: 13, color: '#8892a4', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} total`}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          Nuovo Problem
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={searchText}
          onChange={(e) => { setSearchText(e.target.value); setPage(0) }}
          placeholder="Cerca per titolo..."
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, width: 220, outline: 'none' }}
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff' }}
        >
          <option value="">Tutti gli status</option>
          <option value="new">New</option>
          <option value="under_investigation">In Analisi</option>
          <option value="change_requested">Change Richiesta</option>
          <option value="change_in_progress">Change in Progress</option>
          <option value="resolved">Resolved</option>
          <option value="deferred">Deferred</option>
          <option value="closed">Closed</option>
          <option value="rejected">Rejected</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => { setPriorityFilter(e.target.value); setPage(0) }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff' }}
        >
          <option value="">Tutte le priorità</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e5e7eb', backgroundColor: '#f9fafb' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>Titolo</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', width: 120 }}>Priorità</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', width: 160 }}>Status</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', width: 80 }}>CI</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', width: 150 }}>Team</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', width: 120 }}>Creato il</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: '#8892a4' }}>Caricamento...</td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center' }}>
                  <EmptyState icon={<Bug size={32} />} title="Nessun problema trovato" description="Crea un nuovo problem o modifica i filtri." />
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => navigate(`/problems/${item.id}`)}
                  style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f9fafb' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                >
                  <td style={{ padding: '12px 16px', fontWeight: 500, color: '#111827' }}>{item.title}</td>
                  <td style={{ padding: '12px 16px' }}><PriorityBadge value={item.priority} /></td>
                  <td style={{ padding: '12px 16px' }}><StatusBadge value={item.status} /></td>
                  <td style={{ padding: '12px 16px', color: '#6b7280' }}>{item.affectedCIs.length}</td>
                  <td style={{ padding: '12px 16px', color: '#6b7280' }}>{item.assignedTeam?.name ?? '—'}</td>
                  <td style={{ padding: '12px 16px', color: '#8892a4' }}>{new Date(item.createdAt).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 13, color: '#8892a4' }}>
          <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} di {total}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : '#374151', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>← Prev</button>
            <span style={{ padding: '4px 8px', fontSize: 13, color: '#6b7280' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '4px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : '#374151', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>Next →</button>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 28, width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: '0 0 20px 0' }}>Nuovo Problem</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 4 }}>Titolo *</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Titolo del problem..."
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 4 }}>Descrizione</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Descrizione del problem..."
                  rows={3}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none', resize: 'none', fontFamily: 'inherit' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 4 }}>Priorità</label>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff' }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 4 }}>Workaround</label>
                <textarea
                  value={newWorkaround}
                  onChange={(e) => setNewWorkaround(e.target.value)}
                  placeholder="Workaround temporaneo..."
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none', resize: 'none', fontFamily: 'inherit' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                onClick={() => setShowCreate(false)}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: 'transparent', fontSize: 13, cursor: 'pointer' }}
              >
                Annulla
              </button>
              <button
                disabled={!newTitle.trim() || creating}
                onClick={() => {
                  if (!newTitle.trim()) return
                  void createProblem({
                    variables: {
                      input: {
                        title:       newTitle.trim(),
                        description: newDescription.trim() || undefined,
                        priority:    newPriority,
                        workaround:  newWorkaround.trim() || undefined,
                      },
                    },
                  })
                }}
                style={{ padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: (!newTitle.trim() || creating) ? '#e5e7eb' : '#4f46e5', color: (!newTitle.trim() || creating) ? '#9ca3af' : '#fff', fontSize: 13, fontWeight: 500, cursor: (!newTitle.trim() || creating) ? 'not-allowed' : 'pointer' }}
              >
                {creating ? 'Creazione...' : 'Crea Problem'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
