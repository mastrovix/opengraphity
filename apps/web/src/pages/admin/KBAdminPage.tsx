import { useId, useState, useRef } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  BookOpen, Plus, Pencil, Trash2,
  CheckCircle, Archive, Clock, Send,
} from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RichTextEditor } from '@/components/RichTextEditor'
import { Pagination } from '@/components/ui/Pagination'
import { inputS } from '@/components/ui/styles'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { styleForCategory } from '@/lib/workflowStepStyle'
import { colors } from '@/lib/tokens'
import { formatDate, formatDateTime } from '@/lib/datetime'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { Link, useSearchParams } from 'react-router-dom'
import { transitionErrorText, type TransitionFailure } from '@/lib/transitionError'
import { showError } from '@/lib/showError'

// ── GraphQL ───────────────────────────────────────────────────────────────────

// `kbArticles` accepts exactly search/category/status (+ paging), ordered by
// updated_at DESC server-side: no sortField/filters JSON exists for it (E-03).
const GET_ARTICLES = gql`
  query AdminKBArticles($page: Int, $pageSize: Int, $status: String, $category: String, $search: String) {
    kbArticles(page: $page, pageSize: $pageSize, status: $status, category: $category, search: $search) {
      items {
        id title slug body category tags status authorName views helpfulCount audience
        createdAt updatedAt publishedAt workflowInstanceId currentStep version
      }
      total
    }
  }
`

const CREATE_ARTICLE = gql`
  mutation CreateKBArticle($title: String!, $body: String!, $category: String!, $tags: [String!], $audience: String) {
    createKBArticle(title: $title, body: $body, category: $category, tags: $tags, audience: $audience) {
      id title slug status workflowInstanceId currentStep
    }
  }
`

/*
 * `expectedVersion`: la versione che questa pagina ha LETTO quando ha aperto
 * l'articolo. Se nel frattempo qualcun altro l'ha modificato, il salvataggio
 * viene rifiutato invece di sovrascriverlo in silenzio — e chi scriveva lo
 * scopriva solo rileggendo la pagina pubblicata (22 set 2026).
 */
const UPDATE_ARTICLE = gql`
  mutation UpdateKBArticle($id: ID!, $title: String, $body: String, $category: String, $tags: [String!], $audience: String, $expectedVersion: Int) {
    updateKBArticle(id: $id, title: $title, body: $body, category: $category, tags: $tags, audience: $audience, expectedVersion: $expectedVersion) {
      id title slug status workflowInstanceId currentStep version
    }
  }
`

const DELETE_ARTICLE = gql`
  mutation DeleteKBArticle($id: ID!) { deleteKBArticle(id: $id) }
`

const EXECUTE_TRANSITION = gql`
  mutation KBTransition($instanceId: ID!, $toStep: String!, $notes: String) {
    executeWorkflowTransition(instanceId: $instanceId, toStep: $toStep, notes: $notes) {
      success error errorKey errorParams { name value }
    }
  }
`


const GET_KB_VERSIONS = gql`
  query KBArticleVersions($articleId: ID!) {
    kbArticleVersions(articleId: $articleId) {
      version title category tags editedByName editedAt
    }
  }
`

const RESTORE_KB_VERSION = gql`
  mutation RestoreKBArticleVersion($articleId: ID!, $version: Int!) {
    restoreKBArticleVersion(articleId: $articleId, version: $version) {
      id title body category tags version
    }
  }
`

interface KBVersion { version: number; title: string; category: string; tags: string[]; editedByName: string | null; editedAt: string }

interface RestoredArticle { title: string; body: string; category: string; tags: string[]; version: number }

/** Collapsible version-history panel shown in the edit form. */
function VersionHistory({ articleId, onRestored }: { articleId: string; onRestored: (a: RestoredArticle) => void }) {
  const { t } = useTranslation()
  const { data, loading, refetch } = useQuery<{ kbArticleVersions: KBVersion[] }>(GET_KB_VERSIONS, {
    variables: { articleId }, fetchPolicy: 'cache-and-network',
  })
  const [restore, { loading: restoring }] = useMutation<{ restoreKBArticleVersion: RestoredArticle }>(RESTORE_KB_VERSION, {
    onCompleted: (d) => { toast.success(t('toast.kb.versionRestored')); void refetch(); onRestored(d.restoreKBArticleVersion) },
    onError: (e: { message: string }) => showError(e),
  })
  const versions = data?.kbArticleVersions ?? []

  if (loading && !data) return <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '12px 0 0' }}>{t('pages.kbAdmin.loadingHistory')}</p>
  if (versions.length === 0) return <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '12px 0 0' }}>{t('pages.kbAdmin.noVersions')}</p>

  return (
    <div style={{ marginTop: 8, border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
      <div className="og-scroll-x">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-table)' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={{ padding: '7px 12px' }}>{t('pages.kbAdmin.colVersion')}</th>
            <th style={{ padding: '7px 12px' }}>{t('common.title')}</th>
            <th style={{ padding: '7px 12px' }}>{t('pages.kbAdmin.editedBy')}</th>
            <th style={{ padding: '7px 12px' }}>{t('pages.kbAdmin.date')}</th>
            <th style={{ padding: '7px 12px', textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version} style={{ borderTop: `1px solid ${colors.border}`, background: colors.white }}>
              <td style={{ padding: '7px 12px', color: 'var(--color-slate)' }}>v{v.version}</td>
              <td style={{ padding: '7px 12px', color: 'var(--color-slate-dark)' }}>{v.title}</td>
              <td style={{ padding: '7px 12px', color: 'var(--color-slate)' }}>{v.editedByName ?? '—'}</td>
              <td style={{ padding: '7px 12px', color: 'var(--color-slate-light)' }}>{formatDateTime(v.editedAt)}</td>
              <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                <button type="button"
                  disabled={restoring}
                  onClick={() => restore({ variables: { articleId, version: v.version } })}
                  style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.white, color: 'var(--color-brand)', cursor: restoring ? 'default' : 'pointer', fontSize: 'var(--font-size-table)', fontWeight: 600, opacity: restoring ? 0.6 : 1 }}
                >
                  {t('pages.kbAdmin.restore')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface KBArticle {
  id: string; title: string; slug: string; body: string; category: string; tags: string[]
  status: string; authorName: string; views: number; helpfulCount: number
  createdAt: string; updatedAt: string; publishedAt: string | null
  workflowInstanceId: string | null; currentStep: string | null
  /** La versione LETTA: si rimanda al salvataggio come `expectedVersion`. */
  version: number
  /** Who it is for: `staff` (not on the portal) or `everyone` (24 Sep 2026). */
  audience: KbAudience
}

type KbAudience = 'staff' | 'everyone'
const KB_AUDIENCES: readonly KbAudience[] = ['staff', 'everyone']

interface ArticleForm {
  title: string; body: string; category: string; tags: string; audience: KbAudience
}

/** The subset of the FilterBuilder that `kbArticles` can actually honour. */
interface KBListFilter { status?: string; category?: string; search?: string }

/**
 * Maps a FilterBuilder group onto the real `kbArticles` arguments. Anything
 * the API cannot express (OR chains, operators other than equals/contains,
 * the same field twice) throws — the UI shows the reason instead of a filter
 * badge that silently changes nothing.
 */
function kbFilterFromGroup(group: FilterGroup | null, t: TFunction, fields: FieldConfig[]): KBListFilter {
  const out: KBListFilter = {}
  if (!group) return out
  // The reason names the field as the filter shows it, not by its key: «Category», not «category».
  const nameOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key
  group.rules.forEach((rule, i) => {
    const isLast = i === group.rules.length - 1
    if (!isLast && rule.logic !== 'AND') throw new Error(t('pages.kbAdmin.filter.onlyAnd'))
    const value = typeof rule.value === 'string' ? rule.value.trim() : ''
    if (!value) throw new Error(t('pages.kbAdmin.filter.missingValue', { field: nameOf(rule.field) }))
    switch (rule.field) {
      case 'status':
      case 'category':
        if (rule.operator !== 'equals') throw new Error(t('pages.kbAdmin.filter.onlyEquals', { field: nameOf(rule.field) }))
        if (out[rule.field]) throw new Error(t('pages.kbAdmin.filter.onlyOnce', { field: nameOf(rule.field) }))
        out[rule.field] = value
        break
      case 'title':
        if (rule.operator !== 'contains') throw new Error(t('pages.kbAdmin.filter.titleOnlyContains'))
        if (out.search) throw new Error(t('pages.kbAdmin.filter.onlyOnce', { field: nameOf('title') }))
        out.search = value
        break
      default:
        throw new Error(t('pages.kbAdmin.filter.unsupported', { field: rule.field }))
    }
  })
  return out
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Nessuna categoria preselezionata: la sceglie chi scrive, dal vocabolario.
// A new article is for the staff until its author says otherwise: what is not declared public stays off the portal.
const EMPTY_FORM: ArticleForm = { title: '', body: '', category: '', tags: '', audience: 'staff' }
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
  // Le categorie sono il vocabolario «kb_category» del Dizionario (revisione
  // del 14 set 2026 · F5). Nel giro del 14 settembre la tendina era stata
  // agganciata al vocabolario `category` degli incident, perché `kbCategories`
  // contava solo le categorie già pubblicate: la fonte era sbagliata, e le
  // categorie KB avevano tre fonti diverse. Ora ne hanno una, la stessa della
  // lista pubblica e del portale.
  const { entriesOf, labelOf } = useDomainVocabularies()
  const CATEGORY_ENTRIES = entriesOf('kb_category') ?? []
  const { steps: kbSteps, byName: kbStepByName, initialStep: kbInitialStep, reachableFrom: kbReachableFrom } = useWorkflowSteps('kb_article')
  // G-9: dove si può andare dal passo iniziale, secondo gli archi del workflow.
  const kbReachableFromInitial = kbReachableFrom(kbInitialStep?.name).filter((st) => !st.isTerminal)

  // List state
  const [page,    setPage]    = useState(0)

  // Form state — `?new=1` (dal pulsante della Knowledge Base) apre subito il modulo.
  const [searchParams, setSearchParams] = useSearchParams()
  const [showForm,     setShowForm]     = useState(() => searchParams.get('new') === '1')
  const [editId,       setEditId]       = useState<string | null>(null)
  const [editArticle,  setEditArticle]  = useState<KBArticle | null>(null)
  const [form,         setForm]         = useState<ArticleForm>(EMPTY_FORM)

  // Misc
  const [deleteId,  setDeleteId]  = useState<string | null>(null)
  const publishingRef = useRef(false)

  // ── Queries ──
  // Only the fields `kbArticles` can filter on (status/category "equals",
  // title "contains") — see kbFilterFromGroup.
  const [listFilter, setListFilter] = useState<KBListFilter>({})
  const KB_FILTER_FIELDS: FieldConfig[] = [
    { key: 'status', label: t('common.status'), type: 'enum',
      options: kbSteps.map((s) => ({ value: s.name, label: s.label || s.name })) },
    { key: 'category', label: t('pages.kb.category'), type: 'enum',
      options: CATEGORY_ENTRIES.map((c) => ({ value: c.value, label: c.label ?? c.value })) },
    { key: 'title', label: t('common.title'), type: 'text' },
  ]
  function applyListFilter(group: FilterGroup | null) {
    try {
      setListFilter(kbFilterFromGroup(group, t, KB_FILTER_FIELDS))
      setPage(0)
    } catch (e) {
      showError(e)
    }
  }
  const { data, loading, refetch } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_ARTICLES,
    {
      variables: {
        page: page + 1, pageSize: PAGE_SIZE,
        status: listFilter.status ?? null, category: listFilter.category ?? null, search: listFilter.search ?? null,
      },
      fetchPolicy: 'cache-and-network',
    },
  )

  // ── Mutations ──
  const [createArticle, { loading: creating }] = useMutation<{ createKBArticle: KBArticle }>(CREATE_ARTICLE, {
    // «Submit for review» exists only on an article already saved (`handlePublish`):
    // a creation is never followed by a move from here (tour of 23 Sep 2026 — the
    // block that did it could not run, and hid that fact).
    onCompleted: () => {
      toast.success(t('pages.kbAdmin.created'))
      closeForm()
      void refetch()
    },
    onError: (e: { message: string }) => { publishingRef.current = false; showError(e) },
  })

  const [updateArticle, { loading: updating }] = useMutation<{ updateKBArticle: KBArticle }>(UPDATE_ARTICLE, {
    onCompleted: (d) => {
      /*
       * The save made a new version: the form now edits THAT one. It kept the
       * version read when it opened, so after a refused «Submit for review»
       * (the save went through, the move did not) the next save was refused
       * as «changed by someone else» — by the editor's own save.
       */
      setEditArticle((cur) => (cur ? { ...cur, version: d.updateKBArticle.version } : cur))
      if (publishingRef.current) {
        // After content save, trigger the forward transition from the
        // initial step (workflow decides which step that leads to).
        publishingRef.current = false
        const wi = d.updateKBArticle.workflowInstanceId ?? editArticle?.workflowInstanceId
        // G-9: vedi sopra, la destinazione viene dagli archi del workflow.
        const forwardFromInitial = kbReachableFromInitial[0]?.name
        if (wi && forwardFromInitial) {
          void execTransition({ variables: { instanceId: wi, toStep: forwardFromInitial } }).then((res) => {
            const r = res.data?.executeWorkflowTransition
            if (r?.success) {
              toast.success(t('toast.kb.sentForReview'))
              closeForm()
              void refetch()
            } else if (r) {
              toast.error(transitionErrorText(r, t('toast.kb.sendForReviewFailed')))
            }
          }, () => { /* refused outright: its onError has said why, and the form stays open */ })
        } else {
          toast.error(t('toast.kb.reviewStepNotFound'))
        }
      } else {
        toast.success(t('pages.kbAdmin.updated'))
        closeForm()
        void refetch()
      }
    },
    onError: (e: { message: string }) => { publishingRef.current = false; showError(e) },
  })

  const [deleteArticle] = useMutation(DELETE_ARTICLE, {
    onCompleted: () => { toast.success(t('pages.kbAdmin.deleted')); setDeleteId(null); void refetch() },
    onError: (e: { message: string }) => showError(e),
  })

  const [execTransition, { loading: transitioning }] = useMutation<{ executeWorkflowTransition: TransitionFailure & { success: boolean } }>(EXECUTE_TRANSITION, {
    onError: (e: { message: string }) => showError(e),
  })

  // ── Helpers ──

  function closeForm() {
    setShowForm(false); setEditId(null); setEditArticle(null); setForm(EMPTY_FORM)
    // `?new=1` opened the form once: a reload after the save must not open an empty one again (tour G10).
    if (searchParams.has('new')) setSearchParams((p) => { const next = new URLSearchParams(p); next.delete('new'); return next }, { replace: true })
  }

  function startEdit(a: KBArticle) {
    setEditId(a.id)
    setEditArticle(a)
    setForm({ title: a.title, body: a.body ?? '', category: a.category, tags: a.tags.join(', '), audience: a.audience })
    setShowForm(true)
  }

  function handleSave() {
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (!form.title.trim() || !form.body.trim()) { toast.error(t('toast.kb.titleBodyRequired')); return }
    if (!form.category) { toast.error(t('toast.kb.categoryRequired')); return }
    publishingRef.current = false
    if (editId) {
      void updateArticle({ variables: { id: editId, title: form.title, body: form.body, category: form.category, tags, audience: form.audience, expectedVersion: editArticle?.version ?? null } })
    } else {
      void createArticle({ variables: { title: form.title, body: form.body, category: form.category, tags, audience: form.audience } })
    }
  }

  function handlePublish() {
    if (!editId) return  // only available when editing an existing draft
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (!form.title.trim() || !form.body.trim()) { toast.error(t('toast.kb.titleBodyRequiredPublish')); return }
    if (!form.category) { toast.error(t('toast.kb.categoryRequired')); return }
    publishingRef.current = true
    void updateArticle({ variables: { id: editId, title: form.title, body: form.body, category: form.category, tags, audience: form.audience, expectedVersion: editArticle?.version ?? null } })
  }

  const articles   = data?.kbArticles?.items ?? []
  const total      = data?.kbArticles?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isBusy     = creating || updating || transitioning

  // No `sortable`: the API orders by updated_at DESC and paginates server-side,
  // a client-side sort would only reorder the current page.
  const articleColumns: ColumnDef<KBArticle>[] = [
    // The title opens the article in the form, as the pencil does (tour G10).
    { key: 'title', label: t('common.title'), render: (v, row) => (
      <button type="button" onClick={() => startEdit(row)}
        style={{ fontWeight: 500, color: 'var(--color-brand)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
        {String(v)}
      </button>
    ) },
    { key: 'category', label: t('pages.kb.category'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{labelOf('kb_category', String(v)) ?? String(v)}</span> },
    { key: 'audience', label: t('pages.kbAdmin.audience'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{t(`pages.kbAdmin.audienceValue.${String(v)}`)}</span> },
    // Intestazioni TRADOTTE (revisione totale · i 29 warning): «Status» e
    // «Views» erano stringhe inglesi in mezzo a colonne che passano da i18n.
    { key: 'status', label: t('pages.kbAdmin.colStatus'), render: (v) => {
      const status = String(v)
      const meta = kbStepByName.get(status)
      return <StatusBadge status={status} label={meta?.label} category={meta?.category ?? null} />
    } },
    { key: 'authorName', label: t('pages.kbAdmin.colAuthor'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{String(v)}</span> },
    { key: 'views', label: t('pages.kbAdmin.colViews'), render: (v) => <span style={{ color: 'var(--color-slate)' }}>{String(v)}</span> },
    { key: 'updatedAt', label: t('pages.kbAdmin.colUpdated'), render: (v) => <span style={{ color: 'var(--color-slate-light)' }}>{formatDate(String(v))}</span> },
    { key: 'id', label: t('common.actions'), render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={() => startEdit(row)} style={{ color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.edit')}><Pencil size={14} /></button>
        {deleteId === row.id ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" onClick={() => void deleteArticle({ variables: { id: row.id } })} style={{ padding: '2px 6px', fontSize: 'var(--font-size-table)', borderRadius: 4, border: 'none', background: 'var(--color-danger)', color: colors.white, cursor: 'pointer' }}>{t('common.confirm')}</button>
            <button type="button" onClick={() => setDeleteId(null)} style={{ padding: '2px 6px', fontSize: 'var(--font-size-table)', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer' }}>{t('common.cancel')}</button>
          </div>
        ) : (
          <button type="button" onClick={() => setDeleteId(row.id)} style={{ color: 'var(--color-slate-light)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} title={t('common.delete')}><Trash2 size={14} /></button>
        )}
      </div>
    ) },
  ]

  const inputStyle: React.CSSProperties = inputS
  const uid = useId()
  const ids = { title: `${uid}-title`, category: `${uid}-category`, tags: `${uid}-tags`, audience: `${uid}-audience` }

  return (
    <PageContainer>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<BookOpen size={22} color="var(--color-icon-accent)" />}>
            {t('pages.kbAdmin.title')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.kbAdmin.articleCount', { count: total })}
          </p>
        </div>
        <button type="button"
          onClick={() => { closeForm(); setShowForm(true) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
        >
          <Plus size={14} /> {t('pages.kbAdmin.new')}
        </button>
      </div>

      {/* ── Article form ── */}
      {showForm && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 20, marginBottom: 20, background: 'var(--color-slate-bg)' }}>
          {/* Form header: title + status badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }}>
              {editId ? t('pages.kbAdmin.editArticle') : t('pages.kbAdmin.newArticle')}
            </h3>
            {editArticle && (() => {
              const meta = kbStepByName.get(editArticle.status)
              return <StatusBadge status={editArticle.status} label={meta?.label} category={meta?.category ?? null} />
            })()}
          </div>

          {/* Fields */}
          <div className="og-pair" style={{ marginBottom: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor={ids.title} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('common.title')} *</label>
              <input id={ids.title} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} style={inputStyle} placeholder={t('pages.kbAdmin.titlePlaceholder')} />
            </div>
            <div>
              <label htmlFor={ids.category} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.kbAdmin.categoryRequired')}</label>
              <select id={ids.category} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} style={inputStyle}>
                <option value="" disabled>{t('pages.kbAdmin.chooseCategory')}</option>
                {CATEGORY_ENTRIES.map((c) => <option key={c.value} value={c.value}>{c.label ?? c.value}</option>)}
                {/* Una categoria che il vocabolario non ha più resta visibile, invece di sparire dal campo. */}
                {form.category && !CATEGORY_ENTRIES.some((c) => c.value === form.category) && (
                  <option value={form.category}>{labelOf('kb_category', form.category) ?? form.category}</option>
                )}
              </select>
            </div>
            <div>
              <label htmlFor={ids.tags} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.kbAdmin.tags')}</label>
              <input id={ids.tags} value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} style={inputStyle} placeholder={t('pages.kbAdmin.tagsPlaceholder')} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor={ids.audience} style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.kbAdmin.audience')}</label>
              <select id={ids.audience} value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value as KbAudience }))} style={inputStyle} aria-describedby={`${ids.audience}-hint`}>
                {KB_AUDIENCES.map((a) => <option key={a} value={a}>{t(`pages.kbAdmin.audienceValue.${a}`)}</option>)}
              </select>
              <div id={`${ids.audience}-hint`} style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('pages.kbAdmin.audienceHint')}</div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 4 }}>{t('pages.kbAdmin.contentRequired')}</div>
            <RichTextEditor
              key={editId ?? 'new'}
              label={t('pages.kbAdmin.contentRequired')}
              value={form.body}
              onChange={(md) => setForm((f) => ({ ...f, body: md }))}
              placeholder={t('pages.kbAdmin.bodyPlaceholder')}
              minHeight="320px"
            />
            <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('pages.kbAdmin.charCount', { used: form.body.length, max: 50000 })}</div>
          </div>

          {/* ── Action buttons ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Save (content only) */}
            <button type="button"
              onClick={handleSave}
              disabled={isBusy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: 'var(--color-brand)', color: colors.white, cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
            >
              {creating || updating ? t('common.loading') : t('common.save')}
            </button>

            {/* In revisione: la pubblicazione si approva nella pagina Approvazioni. Prima qui non c'era nessuna indicazione. */}
            {editId && editArticle && editArticle.status !== kbInitialStep?.name && kbStepByName.get(editArticle.status)?.category !== 'published' && (
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                {t('pages.kbAdmin.awaitingApproval')} <Link to="/approvals" style={{ color: 'var(--color-brand)' }}>{t('pages.kbAdmin.openApprovals')}</Link>
              </span>
            )}

            {/* Publish — only when editing an existing draft */}
            {editId && editArticle?.status === kbInitialStep?.name && (
              <button type="button"
                onClick={handlePublish}
                disabled={isBusy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: 'none', backgroundColor: 'var(--color-brand)', color: colors.white, cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, opacity: isBusy ? 0.7 : 1, transition: 'background-color 150ms' }}
              >
                <Send size={14} />
                {t('pages.kbAdmin.submitForReview')}
              </button>
            )}

            <div style={{ flex: 1 }} />

            <button type="button"
              onClick={closeForm}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 16px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.white, color: 'var(--color-slate)', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500 }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {/* Info note — only when editing an existing draft */}
          {editId && editArticle?.status === kbInitialStep?.name && (
            <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
              {t('pages.kbAdmin.saveVsSubmitHint')}
            </p>
          )}

          {/* Version history — only when editing an existing article */}
          {editId && (
            <div style={{ marginTop: 20, borderTop: `1px solid ${colors.border}`, paddingTop: 16 }}>
              <h4 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Clock size={14} /> {t('pages.kbAdmin.versions')}
              </h4>
              <VersionHistory
                articleId={editId}
                onRestored={(a) => {
                  // A version keeps the content; who the article is for is not versioned and stays as it is.
                  setForm((f) => ({ title: a.title, body: a.body, category: a.category, tags: a.tags.join(', '), audience: f.audience }))
                  // A restore is a new version too: the next save must send it.
                  setEditArticle((cur) => (cur ? { ...cur, version: a.version } : cur))
                }}
              />
            </div>
          )}
        </div>
      )}

      <FilterBuilder fields={KB_FILTER_FIELDS} onApply={applyListFilter} />

      {/* ── Table ── */}
      <SortableFilterTable<KBArticle>
        columns={articleColumns}
        data={articles}
        loading={loading}
        emptyComponent={<EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kbAdmin.noArticles')} />}
        label={t('pages.kbAdmin.articles')}
      />

      {/* ── Pagination ── */}
      <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
    </PageContainer>
  )
}
