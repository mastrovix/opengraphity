import { SearchBox } from '@/components/ui/SearchBox'
import { Loading } from '@/components/ui/Loading'
import { Button } from '@/components/Button'
import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useMe } from '@/hooks/useMe'
import { BookOpen, Eye, ThumbsUp, Tag } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { Pagination } from '@/components/ui/Pagination'
import { QueryError } from '@/components/QueryError'
import { Pill } from '@/components/ui/Pill'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useValueStyle } from '@/hooks/useValueStyle'
import { formatDate } from '@/lib/datetime'
import { colors } from '@/lib/tokens'

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

const PAGE_SIZE = 15

export function KnowledgeBasePage() {
  const { t } = useTranslation()
  // F5: etichetta e colore della categoria vengono dal vocabolario `kb_category`.
  const { labelOf } = useDomainVocabularies()
  const styleOf = useValueStyle()
  const categoryLabel = (name: string) => labelOf('kb_category', name) ?? name
  const { can } = useMe()
  // Giro del 14 set 2026 (#45): dalla Knowledge Base non si poteva scrivere un articolo.
  const canWrite = can('kb.write')
  const [search,   setSearch]   = useState('')
  const [category, setCategory] = useState('')
  const [page,     setPage]     = useState(0)
  const [inputVal, setInputVal] = useState('')

  const { data: catData } = useQuery<{ kbCategories: KBCategory[] }>(GET_CATEGORIES, { fetchPolicy: 'cache-and-network' })
  const { data, loading, error, refetch }  = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(GET_ARTICLES, {
    variables: { search: search || undefined, category: category || undefined, page: page + 1, pageSize: PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
  })

  // Nella griglia solo le categorie con articoli pubblicati: una tessera vuota non porta a niente.
  const categories = (catData?.kbCategories ?? []).filter((c) => c.count > 0)
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
      <div style={{ textAlign: 'center', paddingBottom: 32, borderBottom: `1px solid ${colors.border}`, marginBottom: 32 }}>
        {/* The app's page title (26 Sep 2026: it was a 28px h1 of its own), centred over the search. */}
        <PageTitle icon={<BookOpen />} style={{ justifyContent: 'center', marginBottom: 12 }}>{t('pages.kb.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate)', margin: '0 0 24px' }}>{t('pages.kb.subtitle')}</p>
        {canWrite && (
          <Link to="/admin/knowledge-base?new=1" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 20, padding: '8px 14px', borderRadius: 8, background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: 600, textDecoration: 'none' }}>
            + {t('pages.kb.newArticle')}
          </Link>
        )}
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, maxWidth: 500, margin: '0 auto' }}>
          <SearchBox value={inputVal} onChange={setInputVal} placeholder={t('pages.kb.searchPlaceholder')} ariaLabel={t('pages.kb.searchPlaceholder')} style={{ flex: 1 }} />
          <Button variant="primary" type="submit">
            {t('common.search')}
          </Button>
          {(search || category) && (
            <button
              type="button"
              onClick={() => { setSearch(''); setInputVal(''); setCategory(''); setPage(0) }}
              style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, fontSize: 'var(--font-size-card-title)', cursor: 'pointer', color: 'var(--color-slate)' }}
            >
              ✕
            </button>
          )}
        </form>
      </div>

      {/* Categories grid */}
      {!search && !category && categories.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>
            {t('pages.kb.browseCategories')}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {categories.map((cat) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => { setCategory(cat.name); setPage(0) }}
                style={{
                  padding: '16px 12px', borderRadius: 10, border: `1px solid ${colors.border}`,
                  background: colors.white, cursor: 'pointer', textAlign: 'center',
                  transition: 'all 150ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = styleOf('kb_category', cat.name).accent }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
              >
                <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: styleOf('kb_category', cat.name).accent, marginBottom: 8 }} />
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.slateDark, marginBottom: 2 }}>{categoryLabel(cat.name)}</div>
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('pages.kbAdmin.articleCount', { count: cat.count })}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active category filter */}
      {category && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.kb.category')}:</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 12, background: styleOf('kb_category', category).bg, color: styleOf('kb_category', category).color, fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
            {categoryLabel(category)}
            <button type="button" onClick={() => { setCategory(''); setPage(0) }} aria-label={t('common.reset')} style={{ marginLeft: 4, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 'var(--font-size-body)' }}>✕</button>
          </span>
        </div>
      )}

      {/* Articles list */}
      <div>
        {search && (
          <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>
            {loading ? '…' : t('pages.kb.resultsFor', { count: total, query: search })}
          </h2>
        )}

        {error && !data ? (
          <QueryError message={error.message} onRetry={() => void refetch()} />
        ) : (
          <>
            {loading ? (
              <Loading padded />
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
                {/*
                  * Il bordo si accendeva con `onMouseEnter`/`onMouseLeave` che
                  * scrivevano nello stile: chi arriva qui col tasto Tab non ha
                  * un puntatore e non vedeva NIENTE. Ora sta in `.og-kb-card`
                  * (index.css), agganciata sia a `:hover` sia al fuoco del
                  * collegamento che la contiene.
                  */}
                <div
                  className="og-kb-card"
                  style={{ padding: '16px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <Pill bg={styleOf('kb_category', a.category).bg} color={styleOf('kb_category', a.category).color} radius={10}>
                          {categoryLabel(a.category)}
                        </Pill>
                        {a.tags.slice(0, 3).map((tag) => (
                          <Pill bg={colors.slateBg} color="var(--color-slate)" radius={8} key={tag} style={{ fontSize: 'var(--font-size-label)' }}>
                            <Tag size={8} style={{ verticalAlign: 'middle' }} /> {tag}
                          </Pill>
                        ))}
                      </div>
                      <h3 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }}>{a.title}</h3>
                      <div style={{ display: 'flex', gap: 12, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                        <span>{a.authorName}</span>
                        {/* The list is the most recently updated first: the date is that one, and says so
                            (tour of 24 Sep 2026, G4 — the publication dates looked out of order). */}
                        <span>{t('pages.kb.updatedOn', { date: formatDate(a.updatedAt) })}</span>
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

        <Pagination currentPage={page + 1} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
          </>
        )}
      </div>
    </PageContainer>
  )
}
