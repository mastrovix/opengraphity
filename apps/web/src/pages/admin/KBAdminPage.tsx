import { useState, useRef } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import {
  BookOpen, Plus, Pencil, Trash2,
  CheckCircle, Archive, Clock, Send,
} from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RichTextEditor } from '@/components/RichTextEditor'

// ── GraphQL ───────────────────────────────────────────────────────────────────

const GET_ARTICLES = gql`
  query AdminKBArticles($page: Int, $pageSize: Int, $status: String) {
    kbArticles(page: $page, pageSize: $pageSize, status: $status) {
      items {
        id title slug body category tags status authorName views helpfulCount
        createdAt updatedAt publishedAt workflowInstanceId currentStep
      }
      total
    }
  }
`

const CREATE_ARTICLE = gql`
  mutation CreateKBArticle($title: String!, $body: String!, $category: String!, $tags: [String!]) {
    createKBArticle(title: $title, body: $body, category: $category, tags: $tags) {
      id title slug status workflowInstanceId currentStep
    }
  }
`

const UPDATE_ARTICLE = gql`
  mutation UpdateKBArticle($id: ID!, $title: String, $body: String, $category: String, $tags: [String!]) {
    updateKBArticle(id: $id, title: $title, body: $body, category: $category, tags: $tags) {
      id title slug status workflowInstanceId currentStep
    }
  }
`

const DELETE_ARTICLE = gql`
  mutation DeleteKBArticle($id: ID!) { deleteKBArticle(id: $id) }
`

const EXECUTE_TRANSITION = gql`
  mutation KBTransition($instanceId: ID!, $toStep: String!, $notes: String) {
    executeWorkflowTransition(instanceId: $instanceId, toStep: $toStep, notes: $notes) {
      success error
    }
  }
`

// ── Types ─────────────────────────────────────────────────────────────────────

interface KBArticle {
  id: string; title: string; slug: string; body: string; category: string; tags: string[]
  status: string; authorName: string; views: number; helpfulCount: number
  createdAt: string; updatedAt: string; publishedAt: string | null
  workflowInstanceId: string | null; currentStep: string | null
}

interface ArticleForm {
  title: string; body: string; category: string; tags: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES  = ['hardware', 'software', 'network', 'security', 'how-to', 'faq', 'general']
const STATUS_OPTIONS = ['draft', 'pending_review', 'published', 'archived']
const EMPTY_FORM: ArticleForm = { title: '', body: '', category: 'how-to', tags: '' }
const PAGE_SIZE = 20

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  draft:          { bg: '#FEF9C3', color: '#854D0E' },
  pending_review: { bg: '#FFF7ED', color: '#C2410C' },
  published:      { bg: '#DCFCE7', color: '#166534' },
  archived:       { bg: '#F1F5F9', color: '#475569' },
}

const STATUS_LABEL: Record<string, string> = {
  draft:          'Bozza',
  pending_review: 'In revisione',
  published:      'Pubblicato',
  archived:       'Archiviato',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600, ...(s ?? {}) }}>
      {status === 'published'      ? <CheckCircle size={10} /> :
       status === 'archived'       ? <Archive     size={10} /> :
       status === 'pending_review' ? <Clock       size={10} /> : null}
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function KBAdminPage() {
  const { t } = useTranslation()

  // List state
  const [page,    setPage]    = useState(0)
  const [statusF, setStatusF] = useState('')

  // Form state
  const [showForm,     setShowForm]     = useState(false)
  const [editId,       setEditId]       = useState<string | null>(null)
  const [editArticle,  setEditArticle]  = useState<KBArticle | null>(null)
  const [form,         setForm]         = useState<ArticleForm>(EMPTY_FORM)

  // Misc
  const [deleteId,  setDeleteId]  = useState<string | null>(null)
  const publishingRef = useRef(false)

  // ── Queries ──
  const { data, loading, refetch } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_ARTICLES,
    { variables: { page: page + 1, pageSize: PAGE_SIZE, status: statusF || undefined }, fetchPolicy: 'cache-and-network' },
  )

  // ── Mutations ──
  const [createArticle, { loading: creating }] = useMutation<{ createKBArticle: KBArticle }>(CREATE_ARTICLE, {
    onCompleted: (d) => {
      toast.success(t('pages.kbAdmin.created'))
      closeForm()
      void refetch()
      // If a publish was requested right after create, trigger it
      if (publishingRef.current && d.createKBArticle.workflowInstanceId) {
        publishingRef.current = false
        void execTransition({
          variables: { instanceId: d.createKBArticle.workflowInstanceId, toStep: 'pending_review' },
        }).then((res) => {
          if (res.data?.executeWorkflowTransition.success) {
            toast.success('Articolo inviato per revisione')
            void refetch()
          }
        })
      }
    },
    onError: (e: { message: string }) => { publishingRef.current = false; toast.error(e.message) },
  })

  const [updateArticle, { loading: updating }] = useMutation<{ updateKBArticle: KBArticle }>(UPDATE_ARTICLE, {
    onCompleted: (d) => {
      if (publishingRef.current) {
        // After content save, trigger the workflow transition
        publishingRef.current = false
        const wi = d.updateKBArticle.workflowInstanceId ?? editArticle?.workflowInstanceId
        if (wi) {
          void execTransition({ variables: { instanceId: wi, toStep: 'pending_review' } }).then((res) => {
            if (res.data?.executeWorkflowTransition.success) {
              toast.success('Articolo inviato per revisione')
              closeForm()
              void refetch()
            }
          })
        } else {
          toast.error('WorkflowInstance non trovata — impossibile inviare per revisione')
        }
      } else {
        toast.success(t('pages.kbAdmin.updated'))
        closeForm()
        void refetch()
      }
    },
    onError: (e: { message: string }) => { publishingRef.current = false; toast.error(e.message) },
  })

  const [deleteArticle] = useMutation(DELETE_ARTICLE, {
    onCompleted: () => { toast.success(t('pages.kbAdmin.deleted')); setDeleteId(null); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const [execTransition, { loading: transitioning }] = useMutation<{ executeWorkflowTransition: { success: boolean; error: string | null } }>(EXECUTE_TRANSITION, {
    onError: (e: { message: string }) => toast.error(e.message),
  })

  // ── Helpers ──

  function closeForm() {
    setShowForm(false); setEditId(null); setEditArticle(null); setForm(EMPTY_FORM)
  }

  function startEdit(a: KBArticle) {
    setEditId(a.id)
    setEditArticle(a)
    setForm({ title: a.title, body: a.body ?? '', category: a.category, tags: a.tags.join(', ') })
    setShowForm(true)
  }

  function handleSave() {
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (!form.title.trim() || !form.body.trim()) { toast.error('Titolo e corpo sono obbligatori'); return }
    publishingRef.current = false
    if (editId) {
      void updateArticle({ variables: { id: editId, title: form.title, body: form.body, category: form.category, tags } })
    } else {
      void createArticle({ variables: { title: form.title, body: form.body, category: form.category, tags } })
    }
  }

  function handlePublish() {
    if (!editId) return  // only available when editing an existing draft
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (!form.title.trim() || !form.body.trim()) { toast.error('Titolo e corpo sono obbligatori prima di pubblicare'); return }
    publishingRef.current = true
    void updateArticle({ variables: { id: editId, title: form.title, body: form.body, category: form.category, tags } })
  }

  const articles   = data?.kbArticles?.items ?? []
  const total      = data?.kbArticles?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isBusy     = creating || updating || transitioning

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box',
  }

  return (
    <PageContainer>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<BookOpen size={22} color="var(--color-brand)" />}>
            {t('pages.kbAdmin.title')}
          </PageTitle>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : total === 1 ? '1 articolo' : `${total} articoli`}
          </p>
        </div>
        <button
          onClick={() => { closeForm(); setShowForm(true) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          <Plus size={14} /> {t('pages.kbAdmin.new')}
        </button>
      </div>

      {/* ── Filters ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(0) }} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}>
          <option value="">{t('pages.kbAdmin.allStatuses')}</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
        </select>
      </div>

      {/* ── Article form ── */}
      {showForm && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 20, marginBottom: 20, background: '#f8fafc' }}>
          {/* Form header: title + status badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a2332' }}>
              {editId ? t('pages.kbAdmin.editArticle') : t('pages.kbAdmin.newArticle')}
            </h3>
            {editArticle && <StatusBadge status={editArticle.status} />}
          </div>

          {/* Fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>{t('common.title')} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} style={inputStyle} placeholder="Titolo articolo" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Categoria *</label>
              <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} style={inputStyle}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Tag (separati da virgola)</label>
              <input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} style={inputStyle} placeholder="vpn, windows, accesso" />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Contenuto *</label>
            <RichTextEditor
              key={editId ?? 'new'}
              value={form.body}
              onChange={(md) => setForm((f) => ({ ...f, body: md }))}
              placeholder="Scrivi il contenuto dell'articolo..."
              minHeight="320px"
            />
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{form.body.length} / 50000 caratteri</div>
          </div>

          {/* ── Action buttons ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Save (content only) */}
            <button
              onClick={handleSave}
              disabled={isBusy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: '#38bdf8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
              onMouseEnter={(e) => { if (!isBusy) (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
            >
              {creating || updating ? t('common.loading') : t('common.save')}
            </button>

            {/* Publish — only when editing an existing draft */}
            {editId && editArticle?.status === 'draft' && (
              <button
                onClick={handlePublish}
                disabled={isBusy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: '#38bdf8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
                onMouseEnter={(e) => { if (!isBusy) (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
              >
                <Send size={14} />
                Invia per revisione
              </button>
            )}

            <div style={{ flex: 1 }} />

            <button
              onClick={closeForm}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: 'var(--color-slate)', cursor: 'pointer', fontSize: 14, fontWeight: 500 }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {/* Info note — only when editing an existing draft */}
          {editId && editArticle?.status === 'draft' && (
            <p style={{ margin: '10px 0 0', fontSize: 11, color: '#94a3b8' }}>
              "Salva" aggiorna il contenuto senza cambiare stato. "Invia per revisione" salva e avvia il processo di approvazione.
            </p>
          )}
        </div>
      )}

      {/* ── Table ── */}
      {loading ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>{t('common.loading')}</div>
      ) : articles.length === 0 ? (
        <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kbAdmin.noArticles')} />
      ) : (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                {['Titolo', 'Categoria', 'Status', 'Autore', 'Views', 'Aggiornato', 'Azioni'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500, color: '#1a2332', maxWidth: 240 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.category}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.authorName}</td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.views}</td>
                  <td style={{ padding: '10px 12px', color: '#94a3b8' }}>{new Date(a.updatedAt).toLocaleDateString()}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>

                      {/* Edit */}
                      <button
                        onClick={() => startEdit(a)}
                        style={{ color: '#38bdf8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                        title={t('common.edit')}
                      >
                        <Pencil size={14} />
                      </button>

                      {/* Delete */}
                      {deleteId === a.id ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => void deleteArticle({ variables: { id: a.id } })} style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}>{t('common.confirm')}</button>
                          <button onClick={() => setDeleteId(null)} style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>{t('common.cancel')}</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteId(a.id)} style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.delete')}>
                          <Trash2 size={14} />
                        </button>
                      )}

                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', fontSize: 12, color: '#94a3b8' }}>
          <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>{t('common.prev')}</button>
            <span style={{ padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>{t('common.next')}</button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
