import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

function PriorityBadge({ value }: { value: string }) {
  return <span style={{ color: 'var(--color-slate)', fontSize: 12 }}>{value}</span>
}

function StatusBadge({ value }: { value: string }) {
  return <span style={{ color: 'var(--color-slate)', fontSize: 12 }}>{value.replace(/_/g, ' ')}</span>
}

const PAGE_SIZE = 50

export function ProblemsPage() {
  const { t } = useTranslation()
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
      toast.success(t('pages.problems.problemCreated'))
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
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0 }}>
            {t('pages.problems.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.problems.count', { count: total })}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          {t('pages.problems.new')}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={searchText}
          onChange={(e) => { setSearchText(e.target.value); setPage(0) }}
          placeholder={t('pages.problems.searchPlaceholder')}
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, width: 220, outline: 'none' }}
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none', backgroundColor: '#fff' }}
        >
          <option value="">{t('pages.problems.allStatuses')}</option>
          <option value="new">New</option>
          <option value="under_investigation">{t('pages.problems.statusUnderInvestigation')}</option>
          <option value="change_requested">{t('pages.problems.statusChangeRequested')}</option>
          <option value="change_in_progress">{t('pages.problems.statusChangeInProgress')}</option>
          <option value="resolved">{t('pages.problems.statusResolved')}</option>
          <option value="deferred">{t('pages.problems.statusDeferred')}</option>
          <option value="closed">{t('pages.problems.statusClosed')}</option>
          <option value="rejected">{t('pages.problems.statusRejected')}</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => { setPriorityFilter(e.target.value); setPage(0) }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none', backgroundColor: '#fff' }}
        >
          <option value="">{t('pages.problems.allPriorities')}</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e5e7eb', backgroundColor: '#f9fafb' }}>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)' }}>{t('pages.problems.title_col')}</th>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)', width: 120 }}>{t('pages.problems.priority')}</th>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)', width: 160 }}>{t('pages.problems.status')}</th>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)', width: 80 }}>{t('pages.problems.ci')}</th>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)', width: 150 }}>{t('pages.problems.team')}</th>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-slate-light)', width: 120 }}>{t('pages.problems.createdAt')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 12 }}>{t('common.loading')}</td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center' }}>
                  <EmptyState icon={<Bug size={32} />} title={t('pages.problems.noResults')} description={t('pages.problems.noResultsDesc')} />
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
                  <td style={{ padding: '10px 16px', fontSize: 12, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{item.title}</td>
                  <td style={{ padding: '10px 16px', fontSize: 12 }}><PriorityBadge value={item.priority} /></td>
                  <td style={{ padding: '10px 16px', fontSize: 12 }}><StatusBadge value={item.status} /></td>
                  <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--color-slate)' }}>{item.affectedCIs.length}</td>
                  <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--color-slate)' }}>{item.assignedTeam?.name ?? '—'}</td>
                  <td style={{ padding: '10px 16px', fontSize: 12, color: 'var(--color-slate-light)' }}>{new Date(item.createdAt).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
          <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', color: page === 0 ? '#c4c9d4' : 'var(--color-slate)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>{t('common.prev')}</button>
            <span style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-slate)' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', color: page >= totalPages - 1 ? '#c4c9d4' : 'var(--color-slate)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>{t('common.next')}</button>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 28, width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 20px 0' }}>{t('pages.problems.new')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.problems.titleLabel')}</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder={t('pages.problems.titlePlaceholder')}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.problems.descriptionLabel')}</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder={t('pages.problems.descriptionPlaceholder')}
                  rows={3}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none', resize: 'none', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.problems.priorityLabel')}</label>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none', backgroundColor: '#fff' }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.problems.workaroundLabel')}</label>
                <textarea
                  value={newWorkaround}
                  onChange={(e) => setNewWorkaround(e.target.value)}
                  placeholder={t('pages.problems.workaroundPlaceholder')}
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none', resize: 'none', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                onClick={() => setShowCreate(false)}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: 'transparent', fontSize: 14, cursor: 'pointer' }}
              >
                {t('common.cancel')}
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
                style={{ padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: (!newTitle.trim() || creating) ? '#e5e7eb' : 'var(--color-brand)', color: (!newTitle.trim() || creating) ? 'var(--color-slate-light)' : '#fff', fontSize: 14, fontWeight: 500, cursor: (!newTitle.trim() || creating) ? 'not-allowed' : 'pointer' }}
              >
                {creating ? t('common.loading') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
