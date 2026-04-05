import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BookOpen, Search, Eye, ThumbsUp, Tag } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'

const GET_CATEGORIES = gql`
  query KBCategories { kbCategories { name count } }
`

const GET_ARTICLES = gql`
  query KBArticles($search: String, $category: String, $page: Int, $pageSize: Int) {
    kbArticles(search: $search, category: $category, status: "published", page: $page, pageSize: $pageSize) {
      items { id title slug category tags status authorName views helpfulCount createdAt updatedAt publishedAt }
      total
    }
  }
`

interface KBArticle {
  id: string; title: string; slug: string; category: string; tags: string[]
  status: string; authorName: string; views: number; helpfulCount: number
  createdAt: string; updatedAt: string; publishedAt: string | null
}

interface KBCategory { name: string; count: number }

const CATEGORY_ICONS: Record<string, string> = {
  hardware: '🖥️', software: '💿', network: '🌐', security: '🔐',
  'how-to': '📖', faq: '❓', general: '📋',
}

const CATEGORY_COLORS: Record<string, string> = {
  hardware: '#3b82f6', software: '#8b5cf6', network: '#06b6d4',
  security: '#ef4444', 'how-to': '#22c55e', faq: '#f59e0b', general: '#94a3b8',
}

const PAGE_SIZE = 15

export function KnowledgeBasePage() {
  const { t } = useTranslation()
  const [search,   setSearch]   = useState('')
  const [category, setCategory] = useState('')
  const [page,     setPage]     = useState(0)
  const [inputVal, setInputVal] = useState('')

  const { data: catData } = useQuery<{ kbCategories: KBCategory[] }>(GET_CATEGORIES, { fetchPolicy: 'cache-and-network' })
  const { data, loading }  = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(GET_ARTICLES, {
    variables: { search: search || undefined, category: category || undefined, page: page + 1, pageSize: PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
  })

  const categories = catData?.kbCategories ?? []
  const articles   = data?.kbArticles?.items ?? []
  const total      = data?.kbArticles?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearch(inputVal)
    setPage(0)
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ textAlign: 'center', paddingBottom: 32, borderBottom: '1px solid #e2e8f0', marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 12 }}>
          <BookOpen size={28} color="var(--color-brand)" />
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-slate-dark)', margin: 0 }}>
            {t('pages.kb.title')}
          </h1>
        </div>
        <p style={{ fontSize: 15, color: '#64748b', margin: '0 0 24px' }}>{t('pages.kb.subtitle')}</p>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, maxWidth: 500, margin: '0 auto' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            <input
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder={t('pages.kb.searchPlaceholder')}
              style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 8, border: '2px solid #e2e8f0', fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#38bdf8' }}
              onBlur={(e)  => { e.currentTarget.style.borderColor = '#e2e8f0' }}
            />
          </div>
          <button type="submit" style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            {t('common.search')}
          </button>
          {(search || category) && (
            <button
              type="button"
              onClick={() => { setSearch(''); setInputVal(''); setCategory(''); setPage(0) }}
              style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 14, cursor: 'pointer', color: '#64748b' }}
            >
              ✕
            </button>
          )}
        </form>
      </div>

      {/* Categories grid */}
      {!search && !category && categories.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>
            {t('pages.kb.browseCategories')}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {categories.map((cat) => (
              <button
                key={cat.name}
                onClick={() => { setCategory(cat.name); setPage(0) }}
                style={{
                  padding: '16px 12px', borderRadius: 10, border: '1px solid #e2e8f0',
                  background: '#fff', cursor: 'pointer', textAlign: 'center',
                  transition: 'all 150ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = CATEGORY_COLORS[cat.name] ?? '#38bdf8' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#e2e8f0' }}
              >
                <div style={{ fontSize: 24, marginBottom: 6 }}>{CATEGORY_ICONS[cat.name] ?? '📄'}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1a2332', marginBottom: 2 }}>{cat.name}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{cat.count} articoli</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active category filter */}
      {category && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 14, color: '#64748b' }}>{t('pages.kb.category')}:</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 12, background: CATEGORY_COLORS[category] ?? '#38bdf8', color: '#fff', fontSize: 13, fontWeight: 500 }}>
            {CATEGORY_ICONS[category] ?? '📄'} {category}
            <button onClick={() => { setCategory(''); setPage(0) }} style={{ marginLeft: 4, background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, fontSize: 12 }}>✕</button>
          </span>
        </div>
      )}

      {/* Articles list */}
      <div>
        {search && (
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>
            {loading ? '...' : `${total} risultati per "${search}"`}
          </h2>
        )}

        {loading ? (
          <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: 32 }}>{t('common.loading')}</div>
        ) : articles.length === 0 ? (
          <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kb.noArticles')} />
        ) : (
          <div>
            {articles.map((a) => (
              <Link
                key={a.id}
                to={`/knowledge-base/${a.slug}`}
                style={{ display: 'block', textDecoration: 'none', marginBottom: 8 }}
              >
                <div
                  style={{ padding: '16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', transition: 'all 150ms' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#38bdf8'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(56,189,248,0.1)' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#e2e8f0'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: (CATEGORY_COLORS[a.category] ?? '#94a3b8') + '20', color: CATEGORY_COLORS[a.category] ?? '#94a3b8', fontWeight: 600 }}>
                          {CATEGORY_ICONS[a.category] ?? '📄'} {a.category}
                        </span>
                        {a.tags.slice(0, 3).map((tag) => (
                          <span key={tag} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: '#f1f5f9', color: '#64748b' }}>
                            <Tag size={8} style={{ verticalAlign: 'middle' }} /> {tag}
                          </span>
                        ))}
                      </div>
                      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#1a2332' }}>{a.title}</h3>
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#94a3b8' }}>
                        <span>{a.authorName}</span>
                        <span>{a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : '—'}</span>
                        <span><Eye size={10} style={{ verticalAlign: 'middle' }} /> {a.views}</span>
                        <span><ThumbsUp size={10} style={{ verticalAlign: 'middle' }} /> {a.helpfulCount}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {total > PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', fontSize: 12, color: '#94a3b8' }}>
            <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('common.of')} {total}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>{t('common.prev')}</button>
              <span style={{ padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer' }}>{t('common.next')}</button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  )
}
