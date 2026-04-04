import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { CheckSquare, Clock, CheckCircle, XCircle } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { toast } from 'sonner'

const MY_PENDING = gql`
  query MyPendingApprovals {
    myPendingApprovals {
      id entityType entityId title description status requestedBy requestedAt
      approvers approvedBy rejectedBy approvalType dueDate resolvedAt resolutionNote
    }
  }
`

const ALL_APPROVALS = gql`
  query AllApprovals($status: String, $entityType: String, $page: Int, $pageSize: Int) {
    approvalRequests(status: $status, entityType: $entityType, page: $page, pageSize: $pageSize) {
      items {
        id entityType entityId title description status requestedBy requestedAt
        approvers approvedBy rejectedBy approvalType dueDate resolvedAt resolutionNote
      }
      total
    }
  }
`

const APPROVE = gql`
  mutation ApproveRequest($id: ID!, $note: String) {
    approveRequest(id: $id, note: $note) { id status approvedBy resolvedAt }
  }
`

const REJECT = gql`
  mutation RejectRequest($id: ID!, $note: String!) {
    rejectRequest(id: $id, note: $note) { id status rejectedBy resolvedAt }
  }
`

interface ApprovalRequest {
  id:             string
  entityType:     string
  entityId:       string
  title:          string
  description:    string | null
  status:         string
  requestedBy:    string
  requestedAt:    string
  approvers:      string[]
  approvedBy:     string[]
  rejectedBy:     string | null
  approvalType:   string
  dueDate:        string | null
  resolvedAt:     string | null
  resolutionNote: string | null
}

const STATUS_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  pending:   { bg: '#FEF9C3', color: '#854D0E', label: 'In attesa' },
  approved:  { bg: '#DCFCE7', color: '#166534', label: 'Approvato' },
  rejected:  { bg: '#FEE2E2', color: '#991B1B', label: 'Rifiutato' },
  expired:   { bg: '#F1F5F9', color: '#475569', label: 'Scaduto' },
  cancelled: { bg: '#F1F5F9', color: '#475569', label: 'Annullato' },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_COLORS[status] ?? STATUS_COLORS['pending']
  return (
    <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

function ApprovalCard({
  req,
  onApprove,
  onReject,
  showActions,
}: {
  req: ApprovalRequest
  onApprove: (id: string, note: string) => void
  onReject:  (id: string, note: string) => void
  showActions: boolean
}) {
  const [noteOpen, setNoteOpen] = useState<'approve' | 'reject' | null>(null)
  const [note, setNote]         = useState('')

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, background: '#fff', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <StatusBadge status={req.status} />
            <span style={{ fontSize: 11, color: '#94a3b8', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>
              {req.entityType}
            </span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {req.approvalType === 'any' ? '1 approvatore sufficiente' :
               req.approvalType === 'all' ? 'tutti gli approvatori richiesti' :
               'maggioranza richiesta'}
            </span>
          </div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#1a2332' }}>{req.title}</h3>
          {req.description && (
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#475569' }}>{req.description}</p>
          )}
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#94a3b8' }}>
            <span><Clock size={11} style={{ verticalAlign: 'middle' }} /> {new Date(req.requestedAt).toLocaleString()}</span>
            <span>{req.approvedBy.length}/{req.approvers.length} approvazioni</span>
            {req.dueDate && <span>Scadenza: {new Date(req.dueDate).toLocaleDateString()}</span>}
          </div>
          {req.resolutionNote && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#475569', fontStyle: 'italic' }}>
              Nota: {req.resolutionNote}
            </p>
          )}
        </div>

        {showActions && req.status === 'pending' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setNoteOpen(noteOpen === 'approve' ? null : 'approve')}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
            >
              <CheckCircle size={14} /> Approva
            </button>
            <button
              onClick={() => setNoteOpen(noteOpen === 'reject' ? null : 'reject')}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
            >
              <XCircle size={14} /> Rifiuta
            </button>
          </div>
        )}
      </div>

      {noteOpen && (
        <div style={{ marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
          <textarea
            placeholder={noteOpen === 'reject' ? 'Motivo del rifiuto (obbligatorio)...' : 'Nota opzionale...'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #e2e8f0', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => {
                if (noteOpen === 'approve') { onApprove(req.id, note); setNoteOpen(null); setNote('') }
                else if (noteOpen === 'reject') {
                  if (!note.trim()) { toast.error('Il motivo del rifiuto è obbligatorio'); return }
                  onReject(req.id, note); setNoteOpen(null); setNote('')
                }
              }}
              style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: noteOpen === 'approve' ? '#22c55e' : '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
            >
              Conferma {noteOpen === 'approve' ? 'Approvazione' : 'Rifiuto'}
            </button>
            <button
              onClick={() => { setNoteOpen(null); setNote('') }}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              Annulla
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ApprovalsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'mine' | 'all'>('mine')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(0)

  const PAGE_SIZE = 20

  const { data: myData, loading: myLoading, refetch: refetchMine } = useQuery<{ myPendingApprovals: ApprovalRequest[] }>(
    MY_PENDING,
    { fetchPolicy: 'cache-and-network', skip: tab !== 'mine' },
  )

  const { data: allData, loading: allLoading, refetch: refetchAll } = useQuery<{ approvalRequests: { items: ApprovalRequest[]; total: number } }>(
    ALL_APPROVALS,
    {
      variables: { status: statusFilter || undefined, page: page + 1, pageSize: PAGE_SIZE },
      fetchPolicy: 'cache-and-network',
      skip: tab !== 'all',
    },
  )

  const [approve] = useMutation(APPROVE, {
    onCompleted: () => { toast.success('Approvazione registrata'); void refetchMine(); void refetchAll() },
    onError: (e: { message: string }) => toast.error(e.message),
  })
  const [reject] = useMutation(REJECT, {
    onCompleted: () => { toast.success('Richiesta rifiutata'); void refetchMine(); void refetchAll() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const handleApprove = (id: string, note: string) => void approve({ variables: { id, note: note || undefined } })
  const handleReject  = (id: string, note: string) => void reject({ variables: { id, note } })

  const myItems  = myData?.myPendingApprovals ?? []
  const allItems = allData?.approvalRequests?.items ?? []
  const allTotal = allData?.approvalRequests?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(allTotal / PAGE_SIZE))

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
    background: active ? '#38bdf8' : 'transparent',
    color: active ? '#fff' : 'var(--color-slate)',
  })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckSquare size={22} color="var(--color-brand)" />
            {t('pages.approvals.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {t('pages.approvals.subtitle')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#f1f5f9', padding: 4, borderRadius: 8, width: 'fit-content' }}>
        <button style={tabStyle(tab === 'mine')} onClick={() => setTab('mine')}>
          {t('pages.approvals.tabMine')}
          {myItems.length > 0 && (
            <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, background: '#ef4444', color: '#fff', fontSize: 11 }}>
              {myItems.length}
            </span>
          )}
        </button>
        <button style={tabStyle(tab === 'all')}  onClick={() => setTab('all')}>
          {t('pages.approvals.tabAll')}
        </button>
      </div>

      {tab === 'all' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}
          >
            <option value="">{t('pages.approvals.allStatuses')}</option>
            <option value="pending">In attesa</option>
            <option value="approved">Approvato</option>
            <option value="rejected">Rifiutato</option>
            <option value="expired">Scaduto</option>
          </select>
        </div>
      )}

      {/* Content */}
      {tab === 'mine' ? (
        myLoading ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>{t('common.loading')}</div>
        ) : myItems.length === 0 ? (
          <EmptyState
            icon={<CheckSquare size={32} color="var(--color-slate-light)" />}
            title={t('pages.approvals.noPending')}
          />
        ) : (
          myItems.map((req) => (
            <ApprovalCard key={req.id} req={req} onApprove={handleApprove} onReject={handleReject} showActions />
          ))
        )
      ) : (
        <>
          {allLoading ? (
            <div style={{ color: '#94a3b8', fontSize: 13 }}>{t('common.loading')}</div>
          ) : allItems.length === 0 ? (
            <EmptyState
              icon={<CheckSquare size={32} color="var(--color-slate-light)" />}
              title={t('pages.approvals.noApprovals')}
            />
          ) : (
            allItems.map((req) => (
              <ApprovalCard key={req.id} req={req} onApprove={handleApprove} onReject={handleReject} showActions={false} />
            ))
          )}
          {allTotal > PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: 'var(--color-slate-light)' }}>
              <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, allTotal)} {t('common.of')} {allTotal}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page === 0 ? '#f9fafb' : '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>{t('common.prev')}</button>
                <span style={{ padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, background: page >= totalPages - 1 ? '#f9fafb' : '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>{t('common.next')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
