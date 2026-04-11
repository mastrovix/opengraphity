import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_KB_ARTICLES, GET_KB_CATEGORIES } from '@/graphql/queries'
import { KBSearchBar } from '@/components/KBSearchBar'

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
  const plain = body.replace(/[#*`\[\]]/g, '').trim()
  return plain.length > max ? plain.slice(0, max) + '…' : plain
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(iso))
  } catch { return iso }
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
      <h1 style={{ fontSize: 20, fontWeight: 600, color: '#0F172A', marginBottom: 20 }}>
        {t('kb.title')}
      </h1>

      {/* Search */}
      <div style={{ marginBottom: 28 }}>
        <KBSearchBar initialValue={search} onSearch={setSearch} />
      </div>

      {/* No search: category grid */}
      {!search && categories.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
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
                  backgroundColor: '#F8FAFC',
                  border:          '1px solid #E2E8F0',
                  borderRadius:    10,
                  cursor:          'pointer',
                  transition:      'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#0EA5E9'; e.currentTarget.style.backgroundColor = '#F0F9FF' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#E2E8F0'; e.currentTarget.style.backgroundColor = '#F8FAFC' }}
              >
                <span style={{ fontSize: 28 }}>{CATEGORY_ICONS[cat.name.toLowerCase()] ?? '📄'}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#0F172A', textTransform: 'capitalize' }}>{cat.name}</span>
                <span style={{ fontSize: 10, color: '#94A3B8' }}>{cat.count} {t('kb.articles')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Articles */}
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>{t('common.loading')}</div>
      ) : articles.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <p style={{ color: '#94A3B8', marginBottom: 16 }}>{t('kb.noResults')}</p>
          <Link
            to="/tickets/new"
            style={{ color: '#0EA5E9', fontWeight: 500, fontSize: 10 }}
          >
            + Apri un ticket
          </Link>
        </div>
      ) : (
        <div>
          {search && (
            <div style={{ marginBottom: 16, fontSize: 10, color: '#64748B' }}>
              {articles.length} risultati per "<strong>{search}</strong>"
              {' '}
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: '#0EA5E9', cursor: 'pointer', fontSize: 10 }}>
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
                  backgroundColor: '#fff',
                  border:          '1px solid #E2E8F0',
                  borderRadius:    10,
                  textDecoration:  'none',
                  transition:      'box-shadow 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#BAE6FD'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(14,165,233,0.08)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#E2E8F0'; e.currentTarget.style.boxShadow = 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#0EA5E9', marginBottom: 6 }}>
                      {article.title}
                    </div>
                    <div style={{ fontSize: 10, color: '#64748B', lineHeight: 1.6 }}>
                      {excerpt(article.body)}
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: '#94A3B8' }}>
                      <span style={{
                        backgroundColor: '#F0F9FF',
                        color:           '#0EA5E9',
                        padding:         '2px 8px',
                        borderRadius:    100,
                        fontWeight:      500,
                        textTransform:   'capitalize',
                      }}>
                        {article.category}
                      </span>
                      {article.publishedAt && <span>{fmtDate(article.publishedAt)}</span>}
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
