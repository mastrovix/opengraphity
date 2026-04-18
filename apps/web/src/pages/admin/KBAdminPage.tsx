import { useState, useRef } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { useTranslation } from 'react-i18next'
import {
  BookOpen, Plus, Pencil, Trash2,
  CheckCircle, Archive, Clock, Send,
} from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RichTextEditor } from '@/components/RichTextEditor'
import { Pagination } from '@/components/ui/Pagination'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { styleForCategory } from '@/lib/workflowStepStyle'

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

const GET_KB_CATEGORIES = gql`query KBAdminCategories { kbCategories { name } }`

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

// KB categories loaded dynamically via kbCategories query inside component
const EMPTY_FORM: ArticleForm = { title: '', body: '', category: 'how-to', tags: '' }
const PAGE_SIZE = 20

// ── Sub-components ────────────────────────────────────────────────────────────

// Icon chosen by step category (admin-editable metadata), not step name.
function CategoryIcon({ category }: { category: string | null | undefined }) {
  if (category === 'published') return <CheckCircle size={10} />
  if (category === 'closed')    return <Archive     size={10} />
  if (category === 'waiting')   return <Clock       size={10} />
  return null
}

function StatusBadge({ status, label, category }: {
  status: string; label?: string; category?: string | null
}) {
  const s = styleForCategory(category)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px', borderRadius: 10, fontSize: 'var(--font-size-table)', fontWeight: 600, backgroundColor: s.bg, color: s.color }}>
      <CategoryIcon category={category} />
      {label || status}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function KBAdminPage() {
  const { t } = useTranslation()
  const { data: catData } = useQuery<{ kbCategories: { name: string }[] }>(GET_KB_CATEGORIES, { fetchPolicy: 'cache-first' })
  const CATEGORIES = (catData?.kbCategories ?? []).map(c => c.name)
  const { steps: kbSteps, byName: kbStepByName, initialStep: kbInitialStep } = useWorkflowSteps('kb_article')

  // List state
  const [page,    setPage]    = useState(0)

  // Form state
  const [showForm,     setShowForm]     = useState(false)
  const [editId,       setEditId]       = useState<string | null>(null)
  const [editArticle,  setEditArticle]  = useState<KBArticle | null>(null)
  const [form,         setForm]         = useState<ArticleForm>(EMPTY_FORM)

  // Misc
  const [deleteId,  setDeleteId]  = useState<string | null>(null)
  const publishingRef = useRef(false)

  // ── Queries ──
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }
  const KB_FILTER_FIELDS: FieldConfig[] = [
    { key: 'status', label: 'Stato', type: 'enum',
      options: kbSteps.map((s) => ({ value: s.name, label: s.label || s.name })) },
    { key: 'category', label: 'Categoria', type: 'enum', options: [
      { value: 'hardware', label: 'Hardware' }, { value: 'software', label: 'Software' },
      { value: 'network', label: 'Network' }, { value: 'security', label: 'Security' },
      { value: 'how-to', label: 'How-to' }, { value: 'faq', label: 'FAQ' }, { value: 'general', label: 'General' },
    ]},
    { key: 'title', label: 'Titolo', type: 'text' },
    { key: 'createdAt', label: 'Data creazione', type: 'date' },
  ]
  const { data, loading, refetch } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_ARTICLES,
    { variables: { page: page + 1, pageSize: PAGE_SIZE, sortField, sortDirection: sortDir, filters: filterGroup ? JSON.stringify(filterGroup) : null }, fetchPolicy: 'cache-and-network' },
  )

  // ── Mutations ──
  const [createArticle, { loading: creating }] = useMutation<{ createKBArticle: KBArticle }>(CREATE_ARTICLE, {
    onCompleted: (d) => {
      toast.success(t('pages.kbAdmin.created'))
      closeForm()
      void refetch()
      // If a publish was requested right after create, trigger the forward
      // transition from the workflow's initial step. The destination is
      // defined by the workflow, not by this page.
      if (publishingRef.current && d.createKBArticle.workflowInstanceId) {
        publishingRef.current = false
        const forwardFromInitial = kbSteps
          .filter((s) => !s.isInitial && !s.isTerminal)
          .map((s) => s.name)[0]
        if (forwardFromInitial) {
          void execTransition({
            variables: { instanceId: d.createKBArticle.workflowInstanceId, toStep: forwardFromInitial },
          }).then((res) => {
            if (res.data?.executeWorkflowTransition.success) {
              toast.success('Articolo inviato per revisione')
              void refetch()
            }
          })
        }
      }
    },
    onError: (e: { message: string }) => { publishingRef.current = false; toast.error(e.message) },
  })

  const [updateArticle, { loading: updating }] = useMutation<{ updateKBArticle: KBArticle }>(UPDATE_ARTICLE, {
    onCompleted: (d) => {
      if (publishingRef.current) {
        // After content save, trigger the forward transition from the
        // initial step (workflow decides which step that leads to).
        publishingRef.current = false
        const wi = d.updateKBArticle.workflowInstanceId ?? editArticle?.workflowInstanceId
        const forwardFromInitial = kbSteps
          .filter((s) => !s.isInitial && !s.isTerminal)
          .map((s) => s.name)[0]
        if (wi && forwardFromInitial) {
          void execTransition({ variables: { instanceId: wi, toStep: forwardFromInitial } }).then((res) => {
            if (res.data?.executeWorkflowTransition.success) {
              toast.success('Articolo inviato per revisione')
              closeForm()
              void refetch()
            }
          })
        } else {
          toast.error('WorkflowInstance o step di revisione non trovato')
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

  const articleColumns: ColumnDef<KBArticle>[] = [
    { key: 'title', label: 'Titolo', sortable: true, render: (v) => (
      <div style={{ fontWeight: 500, color: '#1a2332', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(v)}</div>
    ) },
    { key: 'category', label: 'Categoria', sortable: true, render: (v) => <span style={{ color: '#64748b' }}>{String(v)}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (v) => {
      const status = String(v)
      const meta = kbStepByName.get(status)
      return <StatusBadge status={status} label={meta?.label} category={meta?.category ?? null} />
    } },
    { key: 'authorName', label: 'Autore', sortable: true, render: (v) => <span style={{ color: '#64748b' }}>{String(v)}</span> },
    { key: 'views', label: 'Views', sortable: true, render: (v) => <span style={{ color: '#64748b' }}>{String(v)}</span> },
    { key: 'updatedAt', label: 'Aggiornato', sortable: true, render: (v) => <span style={{ color: '#94a3b8' }}>{new Date(String(v)).toLocaleDateString()}</span> },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button onClick={() => startEdit(row)} style={{ color: '#38bdf8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.edit')}><Pencil size={14} /></button>
        {deleteId === row.id ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => void deleteArticle({ variables: { id: row.id } })} style={{ padding: '2px 6px', fontSize: 'var(--font-size-table)', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}>{t('common.confirm')}</button>
            <button onClick={() => setDeleteId(null)} style={{ padding: '2px 6px', fontSize: 'var(--font-size-table)', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>{t('common.cancel')}</button>
          </div>
        ) : (
          <button onClick={() => setDeleteId(row.id)} style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.delete')}><Trash2 size={14} /></button>
        )}
      </div>
    ) },
  ]

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    border: '1px solid #e2e8f0', fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
  }

  return (
    <PageContainer>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<BookOpen size={22} color="#38bdf8" />}>
            {t('pages.kbAdmin.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : total === 1 ? '1 articolo' : `${total} articoli`}
          </p>
        </div>
        <button
          onClick={() => { closeForm(); setShowForm(true) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
        >
          <Plus size={14} /> {t('pages.kbAdmin.new')}
        </button>
      </div>

      {/* ── Article form ── */}
      {showForm && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 20, marginBottom: 20, background: '#f8fafc' }}>
          {/* Form header: title + status badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: '#1a2332' }}>
              {editId ? t('pages.kbAdmin.editArticle') : t('pages.kbAdmin.newArticle')}
            </h3>
            {editArticle && (() => {
              const meta = kbStepByName.get(editArticle.status)
              return <StatusBadge status={editArticle.status} label={meta?.label} category={meta?.category ?? null} />
            })()}
          </div>

          {/* Fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>{t('common.title')} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} style={inputStyle} placeholder="Titolo articolo" />
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Categoria *</label>
              <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} style={inputStyle}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Tag (separati da virgola)</label>
              <input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} style={inputStyle} placeholder="vpn, windows, accesso" />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Contenuto *</label>
            <RichTextEditor
              key={editId ?? 'new'}
              value={form.body}
              onChange={(md) => setForm((f) => ({ ...f, body: md }))}
              placeholder="Scrivi il contenuto dell'articolo..."
              minHeight="320px"
            />
            <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', marginTop: 4 }}>{form.body.length} / 50000 caratteri</div>
          </div>

          {/* ── Action buttons ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Save (content only) */}
            <button
              onClick={handleSave}
              disabled={isBusy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: '#38bdf8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
              onMouseEnter={(e) => { if (!isBusy) (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
            >
              {creating || updating ? t('common.loading') : t('common.save')}
            </button>

            {/* Publish — only when editing an existing draft */}
            {editId && editArticle?.status === kbInitialStep?.name && (
              <button
                onClick={handlePublish}
                disabled={isBusy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: '#38bdf8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
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
              style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 16px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: 'var(--color-slate)', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500 }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {/* Info note — only when editing an existing draft */}
          {editId && editArticle?.status === kbInitialStep?.name && (
            <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>
              "Salva" aggiorna il contenuto senza cambiare stato. "Invia per revisione" salva e avvia il processo di approvazione.
            </p>
          )}
        </div>
      )}

      <FilterBuilder fields={KB_FILTER_FIELDS} onApply={g => { setFilterGroup(g); setPage(0) }} />

      {/* ── Table ── */}
      <SortableFilterTable<KBArticle>
        columns={articleColumns}
        data={articles}
        loading={loading}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
        emptyComponent={<EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kbAdmin.noArticles')} />}
        label="KB Articles"
      />

      {/* ── Pagination ── */}
      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
    </PageContainer>
  )
}
