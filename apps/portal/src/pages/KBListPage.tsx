import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_KB_ARTICLES, GET_KB_CATEGORIES } from '@/graphql/queries'
import { KBSearchBar } from '@/components/KBSearchBar'
import { fmtDateLong } from '@/lib/format'
import { colors, palette, alpha } from '@/lib/tokens'

interface KBArticle {
  id: string; title: string; slug: string; body: string
  category: string; views: number; publishedAt: string | null
}
interface KBCategory { name: string; count: number }

const CATEGORY_ICONS: Record<string, string> = {
  hardware:  '🖥️',
  software:  '💻',
  network:   '🌐',
  security:  '🔒',
  email:     '📧',
  general:   '📂',
}

function excerpt(body: string, max = 200): string {
  const plain = body.replace(/[#*`[\]]/g, '').trim()
  return plain.length > max ? plain.slice(0, max) + '…' : plain
}


export function KBListPage() {
  const { t }                   = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch]     = useState(searchParams.get('search') ?? '')

  const { data: catData } = useQuery<{ kbCategories: KBCategory[] }>(GET_KB_CATEGORIES)
  const { data, loading } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_KB_ARTICLES,
    { variables: { search: search || undefined, pageSize: 30 }, skip: false },
  )

  const articles   = data?.kbArticles?.items ?? []
  const categories = catData?.kbCategories ?? []

  useEffect(() => {
    const current = searchParams.get('search') ?? ''
    if (current !== search) {
      setSearchParams(search ? { search } : {})
    }
  }, [search, searchParams, setSearchParams])

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.slateDark, marginBottom: 20 }}>
        {t('kb.title')}
      </h1>

      {/* Search */}
      <div style={{ marginBottom: 28 }}>
        <KBSearchBar initialValue={search} onSearch={setSearch} />
      </div>

      {/* No search: category grid */}
      {!search && categories.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
            {t('kb.categories')}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {categories.map(cat => (
              <button
                key={cat.name}
                onClick={() => setSearch(cat.name)}
                style={{
                  display:         'flex',
                  flexDirection:   'column',
                  alignItems:      'center',
                  gap:             8,
                  padding:         '20px 16px',
                  backgroundColor: palette.neutral.surface1,
                  border:          `1px solid ${colors.border}`,
                  borderRadius:    10,
                  cursor:          'pointer',
                  transition:      'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = colors.brand; e.currentTarget.style.backgroundColor = colors.brandLight }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.backgroundColor = palette.neutral.surface1 }}
              >
                <span style={{ fontSize: 28 }}>{CATEGORY_ICONS[cat.name.toLowerCase()] ?? '📄'}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark, textTransform: 'capitalize' }}>{cat.name}</span>
                <span style={{ fontSize: 10, color: colors.slateLight }}>{cat.count} {t('kb.articles')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Articles */}
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: colors.slateLight }}>{t('common.loading')}</div>
      ) : articles.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <p style={{ color: colors.slateLight, marginBottom: 16 }}>{t('kb.noResults')}</p>
          <Link
            to="/tickets/new"
            style={{ color: colors.brand, fontWeight: 500, fontSize: 10 }}
          >
            + Apri un ticket
          </Link>
        </div>
      ) : (
        <div>
          {search && (
            <div style={{ marginBottom: 16, fontSize: 10, color: colors.slate }}>
              {articles.length} risultati per "<strong>{search}</strong>"
              {' '}
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: colors.brand, cursor: 'pointer', fontSize: 10 }}>
                Cancella
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {articles.map(article => (
              <Link
                key={article.id}
                to={`/kb/${article.slug}`}
                style={{
                  display:         'block',
                  padding:         16,
                  backgroundColor: colors.white,
                  border:          `1px solid ${colors.border}`,
                  borderRadius:    10,
                  textDecoration:  'none',
                  transition:      'box-shadow 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = palette.info.border; e.currentTarget.style.boxShadow = `0 2px 8px ${alpha.brand08}` }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.boxShadow = 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: colors.brand, marginBottom: 6 }}>
                      {article.title}
                    </div>
                    <div style={{ fontSize: 10, color: colors.slate, lineHeight: 1.6 }}>
                      {excerpt(article.body)}
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: colors.slateLight }}>
                      <span style={{
                        backgroundColor: colors.brandLight,
                        color:           colors.brand,
                        padding:         '2px 8px',
                        borderRadius:    100,
                        fontWeight:      500,
                        textTransform:   'capitalize',
                      }}>
                        {article.category}
                      </span>
                      {article.publishedAt && <span>{fmtDateLong(article.publishedAt)}</span>}
                      <span>{article.views} {t('kb.views')}</span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
