import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Plus, Pencil, Trash2, Eye, CheckCircle, Archive } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'

const GET_ARTICLES = gql`
  query AdminKBArticles($page: Int, $pageSize: Int, $status: String) {
    kbArticles(page: $page, pageSize: $pageSize, status: $status) {
      items { id title slug category tags status authorName views helpfulCount createdAt updatedAt publishedAt }
      total
    }
  }
`

const CREATE_ARTICLE = gql`
  mutation CreateKBArticle($title: String!, $body: String!, $category: String!, $tags: [String!], $status: String) {
    createKBArticle(title: $title, body: $body, category: $category, tags: $tags, status: $status) {
      id title slug status
    }
  }
`

const UPDATE_ARTICLE = gql`
  mutation UpdateKBArticle($id: ID!, $title: String, $body: String, $category: String, $tags: [String!], $status: String) {
    updateKBArticle(id: $id, title: $title, body: $body, category: $category, tags: $tags, status: $status) {
      id title slug status
    }
  }
`

const DELETE_ARTICLE = gql`
  mutation DeleteKBArticle($id: ID!) { deleteKBArticle(id: $id) }
`

interface KBArticle {
  id: string; title: string; slug: string; category: string; tags: string[]
  status: string; authorName: string; views: number; helpfulCount: number
  createdAt: string; updatedAt: string; publishedAt: string | null
}

const CATEGORIES = ['hardware', 'software', 'network', 'security', 'how-to', 'faq', 'general']
const STATUS_OPTIONS = ['draft', 'published', 'archived']

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  draft:     { bg: '#FEF9C3', color: '#854D0E' },
  published: { bg: '#DCFCE7', color: '#166534' },
  archived:  { bg: '#F1F5F9', color: '#475569' },
}

interface ArticleForm {
  title: string; body: string; category: string; tags: string; status: string
}

const EMPTY_FORM: ArticleForm = { title: '', body: '', category: 'how-to', tags: '', status: 'draft' }

const PAGE_SIZE = 20

export function KBAdminPage() {
  const { t }     = useTranslation()
  const [page,    setPage]    = useState(0)
  const [statusF, setStatusF] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId,   setEditId]   = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [form,     setForm]     = useState<ArticleForm>(EMPTY_FORM)
  const [preview,  setPreview]  = useState(false)

  const { data, loading, refetch } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_ARTICLES,
    { variables: { page: page + 1, pageSize: PAGE_SIZE, status: statusF || undefined }, fetchPolicy: 'cache-and-network' },
  )

  const [createArticle, { loading: creating }] = useMutation(CREATE_ARTICLE, {
    onCompleted: () => { toast.success(t('pages.kbAdmin.created')); setShowForm(false); setForm(EMPTY_FORM); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const [updateArticle, { loading: updating }] = useMutation(UPDATE_ARTICLE, {
    onCompleted: () => { toast.success(t('pages.kbAdmin.updated')); setEditId(null); setShowForm(false); setForm(EMPTY_FORM); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const [deleteArticle] = useMutation(DELETE_ARTICLE, {
    onCompleted: () => { toast.success(t('pages.kbAdmin.deleted')); setDeleteId(null); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const articles   = data?.kbArticles?.items ?? []
  const total      = data?.kbArticles?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function handleSubmit() {
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (!form.title.trim() || !form.body.trim()) { toast.error('Titolo e corpo sono obbligatori'); return }
    if (editId) {
      void updateArticle({ variables: { id: editId, title: form.title, body: form.body, category: form.category, tags, status: form.status } })
    } else {
      void createArticle({ variables: { title: form.title, body: form.body, category: form.category, tags, status: form.status } })
    }
  }

  function startEdit(a: KBArticle) {
    setEditId(a.id)
    setForm({ title: a.title, body: '', category: a.category, tags: a.tags.join(', '), status: a.status })
    setShowForm(true)
    setPreview(false)
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13, boxSizing: 'border-box' }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <BookOpen size={22} color="var(--color-brand)" />
            {t('pages.kbAdmin.title')}
          </h1>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${total} articoli`}
          </p>
        </div>
        <button
          onClick={() => { setEditId(null); setForm(EMPTY_FORM); setShowForm(true); setPreview(false) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
        >
          <Plus size={14} /> {t('pages.kbAdmin.new')}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(0) }} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13 }}>
          <option value="">{t('pages.kbAdmin.allStatuses')}</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Form */}
      {showForm && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 20, marginBottom: 20, background: '#f8fafc' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#1a2332' }}>
            {editId ? t('pages.kbAdmin.editArticle') : t('pages.kbAdmin.newArticle')}
          </h3>
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
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} style={inputStyle}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 4 }}>Tag (separati da virgola)</label>
              <input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} style={inputStyle} placeholder="vpn, windows, accesso" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Corpo (Markdown) *</label>
              <button onClick={() => setPreview((p) => !p)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#64748b' }}>
                <Eye size={10} style={{ verticalAlign: 'middle' }} /> {preview ? 'Modifica' : 'Preview'}
              </button>
            </div>
            {preview ? (
              <div style={{ padding: 12, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', minHeight: 200, fontSize: 14, lineHeight: 1.6 }}>
                {/* Preview placeholder — in production use ReactMarkdown */}
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{form.body}</pre>
              </div>
            ) : (
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={12}
                maxLength={50_000}
                placeholder="# Titolo&#10;&#10;Scrivi l'articolo in Markdown..."
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace' }}
              />
            )}
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{form.body.length} / 50000</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSubmit}
              disabled={creating || updating}
              style={{ padding: '8px 20px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
            >
              {creating || updating ? t('common.loading') : t('common.save')}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditId(null); setForm(EMPTY_FORM) }}
              style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ fontSize: 13, color: '#94a3b8' }}>{t('common.loading')}</div>
      ) : articles.length === 0 ? (
        <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kbAdmin.noArticles')} />
      ) : (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                {['Titolo', 'Categoria', 'Status', 'Autore', 'Views', 'Aggiornato', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500, color: '#1a2332', maxWidth: 280 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.category}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, ...(STATUS_STYLE[a.status] ?? {}) }}>
                      {a.status === 'published' ? <CheckCircle size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} /> :
                       a.status === 'archived'  ? <Archive   size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} /> : null}
                      {a.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.authorName}</td>
                  <td style={{ padding: '10px 12px', color: '#64748b' }}>{a.views}</td>
                  <td style={{ padding: '10px 12px', color: '#94a3b8' }}>{new Date(a.updatedAt).toLocaleDateString()}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => startEdit(a)} style={{ color: '#38bdf8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.edit')}>
                        <Pencil size={14} />
                      </button>
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
    </div>
  )
}
