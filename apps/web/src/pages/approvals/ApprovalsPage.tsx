import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { CheckSquare, Clock, CheckCircle, XCircle, ChevronDown, ChevronRight, ExternalLink, BookOpen, GitPullRequest, AlertCircle } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Pagination } from '@/components/ui/Pagination'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const MY_PENDING = gql`
  query MyPendingApprovals {
    myPendingApprovals {
      id entityType entityId title description status requestedBy requestedAt
      approvers approvedBy rejectedBy approvalType dueDate resolvedAt resolutionNote
    }
  }
`

const ALL_APPROVALS = gql`
  query AllApprovals($page: Int, $pageSize: Int, $filters: String, $sortField: String, $sortDirection: String) {
    approvalRequests(page: $page, pageSize: $pageSize, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
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

const GET_KB_ARTICLE_PREVIEW = gql`
  query KBArticlePreview($id: ID!) {
    kbArticle(id: $id) {
      id title body category tags status authorName updatedAt
    }
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

interface KBPreviewData {
  id: string; title: string; body: string; category: string
  tags?: string[]; status: string; authorName: string; updatedAt?: string
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
    <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 'var(--font-size-table)', fontWeight: 600, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

/** Link to the entity's detail page, based on entityType. */
function EntityLink({ entityType, entityId }: { entityType: string; entityId: string }) {
  if (entityType === 'change') {
    return (
      <Link
        to={`/changes/${entityId}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)', textDecoration: 'none' }}
      >
        <GitPullRequest size={11} /> Vai al change <ExternalLink size={10} />
      </Link>
    )
  }
  if (entityType === 'incident') {
    return (
      <Link
        to={`/incidents/${entityId}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)', textDecoration: 'none' }}
      >
        <AlertCircle size={11} /> Vai all'incident <ExternalLink size={10} />
      </Link>
    )
  }
  return null
}

/** Expandable KB article preview panel. Fetches content lazily on first open. */
function KBArticlePreviewPanel({ entityId }: { entityId: string }) {
  const [open, setOpen] = useState(false)

  const [fetchArticle, { data, loading, error }] = useLazyQuery<{ kbArticle: KBPreviewData }>(
    GET_KB_ARTICLE_PREVIEW,
  )

  function toggle() {
    if (!open && !data) void fetchArticle({ variables: { id: entityId } })
    setOpen((v) => !v)
  }

  const article = data?.kbArticle

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={toggle}
        style={{
          display:     'inline-flex',
          alignItems:  'center',
          gap:         4,
          padding:     '4px 10px',
          borderRadius: 6,
          border:      '1px solid #e2e8f0',
          background:  open ? '#f0f9ff' : '#fff',
          color:       open ? 'var(--color-brand)' : 'var(--color-slate)',
          fontSize:    12,
          cursor:      'pointer',
          fontWeight:  500,
        }}
      >
        <BookOpen size={13} />
        Anteprima articolo
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>

      {open && (
        <div style={{
          marginTop:    8,
          border:       '1px solid #e2e8f0',
          borderRadius: 8,
          background:   '#fafbfc',
          overflow:     'hidden',
        }}>
          {loading && (
            <div style={{ padding: '20px 16px', fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>Caricamento...</div>
          )}
          {error && (
            <div style={{ padding: '12px 16px', fontSize: 'var(--font-size-body)', color: '#ef4444' }}>
              Errore nel caricamento dell'articolo.
            </div>
          )}
          {article && (
            <>
              {/* Header */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', background: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: '#1a2332' }}>{article.title}</h4>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>
                      <span>{article.category}</span>
                      <span>·</span>
                      <span>di {article.authorName}</span>
                      <span>·</span>
                      {article.updatedAt && <span>aggiornato {new Date(article.updatedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  {(article.tags ?? []).length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {(article.tags ?? []).map((tag) => (
                        <span key={tag} style={{ padding: '1px 6px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', fontSize: 'var(--font-size-table)' }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Body */}
              <div style={{ padding: '16px', maxHeight: 400, overflowY: 'auto' }}>
                <div className="kb-preview-body" style={{ fontSize: 'var(--font-size-body)', lineHeight: 1.7, color: '#334155' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {article.body}
                  </ReactMarkdown>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
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
            <span style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>
              {req.entityType}
            </span>
            <span style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>
              {req.approvalType === 'any' ? '1 approvatore sufficiente' :
               req.approvalType === 'all' ? 'tutti gli approvatori richiesti' :
               'maggioranza richiesta'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: '#1a2332' }}>{req.title}</h3>
            <EntityLink entityType={req.entityType} entityId={req.entityId} />
          </div>

          {req.description && (
            <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-body)', color: '#475569' }}>{req.description}</p>
          )}
          <div style={{ display: 'flex', gap: 16, fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>
            <span><Clock size={11} style={{ verticalAlign: 'middle' }} /> {new Date(req.requestedAt).toLocaleString()}</span>
            <span>{req.approvedBy.length}/{req.approvers.length} approvazioni</span>
            {req.dueDate && <span>Scadenza: {new Date(req.dueDate).toLocaleDateString()}</span>}
          </div>
          {req.resolutionNote && (
            <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-body)', color: '#475569', fontStyle: 'italic' }}>
              Nota: {req.resolutionNote}
            </p>
          )}

          {/* Inline preview for KB articles */}
          {req.entityType === 'kb_article' && (
            <KBArticlePreviewPanel entityId={req.entityId} />
          )}
        </div>

        {showActions && req.status === 'pending' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => setNoteOpen(noteOpen === 'approve' ? null : 'approve')}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 500 }}
            >
              <CheckCircle size={14} /> Approva
            </button>
            <button
              onClick={() => setNoteOpen(noteOpen === 'reject' ? null : 'reject')}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 500 }}
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
            style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #e2e8f0', fontSize: 'var(--font-size-body)', resize: 'vertical', boxSizing: 'border-box' }}
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
              style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: noteOpen === 'approve' ? '#22c55e' : '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 500 }}
            >
              Conferma {noteOpen === 'approve' ? 'Approvazione' : 'Rifiuto'}
            </button>
            <button
              onClick={() => { setNoteOpen(null); setNote('') }}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}
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
  const [page, setPage] = useState(0)
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)

  const PAGE_SIZE = 20
  const APPROVAL_FILTER_FIELDS: FieldConfig[] = [
    { key: 'status', label: 'Stato', type: 'enum', options: [
      { value: 'pending', label: 'In attesa' }, { value: 'approved', label: 'Approvato' }, { value: 'rejected', label: 'Rifiutato' },
    ]},
    { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
      { value: 'change', label: 'Change' }, { value: 'kb_article', label: 'KB Article' },
    ]},
    { key: 'title', label: 'Titolo', type: 'text' },
    { key: 'requestedAt', label: 'Data richiesta', type: 'date' },
  ]

  const { data: myData, loading: myLoading, refetch: refetchMine } = useQuery<{ myPendingApprovals: ApprovalRequest[] }>(
    MY_PENDING,
    { fetchPolicy: 'cache-and-network', skip: tab !== 'mine' },
  )

  const { data: allData, loading: allLoading, refetch: refetchAll } = useQuery<{ approvalRequests: { items: ApprovalRequest[]; total: number } }>(
    ALL_APPROVALS,
    {
      variables: { page: page + 1, pageSize: PAGE_SIZE, filters: filterGroup ? JSON.stringify(filterGroup) : undefined },
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
    padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 500,
    background: active ? 'var(--color-brand)' : 'transparent',
    color: active ? '#fff' : 'var(--color-slate)',
  })

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<CheckSquare size={22} color="#38bdf8" />}>
            {t('pages.approvals.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {t('pages.approvals.subtitle')}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#f1f5f9', padding: 4, borderRadius: 8, width: 'fit-content' }}>
        <button style={tabStyle(tab === 'mine')} onClick={() => setTab('mine')}>
          {t('pages.approvals.tabMine')}
          {myItems.length > 0 && (
            <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, background: '#ef4444', color: '#fff', fontSize: 'var(--font-size-table)' }}>
              {myItems.length}
            </span>
          )}
        </button>
        <button style={tabStyle(tab === 'all')}  onClick={() => setTab('all')}>
          {t('pages.approvals.tabAll')}
        </button>
      </div>

      {tab === 'all' && (
        <FilterBuilder fields={APPROVAL_FILTER_FIELDS} onApply={g => { setFilterGroup(g); setPage(0) }} />
      )}

      {/* Content */}
      {tab === 'mine' ? (
        myLoading ? (
          <div style={{ color: '#94a3b8', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
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
            <div style={{ color: '#94a3b8', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
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
          <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        </>
      )}
    </PageContainer>
  )
}
