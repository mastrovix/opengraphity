import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import { GET_KB_ARTICLES, GET_KB_CATEGORIES } from '@/graphql/queries'
import { KBSearchBar } from '@/components/KBSearchBar'
import { fmtDateLong } from '@/lib/format'
import { colors, palette, alpha } from '@/lib/tokens'
import { usePortalAccess } from '@/hooks/usePortalAccess'

interface KBArticle {
  id: string; title: string; slug: string; body: string
  category: string; views: number; publishedAt: string | null
}
/**
 * Una categoria KB: un valore del vocabolario `kb_category` del Dizionario, con
 * l'etichetta nella lingua di chi legge (revisione del 14 set 2026 · F5). Prima
 * c'era qui una tabella di emoji per sei categorie scelte a mano.
 */
interface KBCategory { name: string; label: string; count: number }

function excerpt(body: string, max = 200): string {
  const plain = body.replace(/[#*`[\]]/g, '').trim()
  return plain.length > max ? plain.slice(0, max) + '…' : plain
}


export function KBListPage() {
  const { t, i18n }             = useTranslation()
  const { canSubmit } = usePortalAccess()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch]     = useState(searchParams.get('search') ?? '')
  /**
   * La CATEGORIA scelta (revisione totale · H-13). Il clic su una categoria
   * metteva il suo nome interno nel campo di RICERCA TESTUALE: si vedevano
   * solo gli articoli il cui titolo o corpo contiene quella parola — spesso
   * nessuno — più quelli di altre categorie che la citano, e l'intestazione
   * diceva «N risultati per "how-to"». La query espone `category`: si usa.
   */
  const [category, setCategory] = useState(searchParams.get('category') ?? '')

  const { data: catData } = useQuery<{ kbCategories: KBCategory[] }>(GET_KB_CATEGORIES, {
    variables: { language: i18n.resolvedLanguage ?? i18n.language },
  })
  const { data, loading } = useQuery<{ kbArticles: { items: KBArticle[]; total: number } }>(
    GET_KB_ARTICLES,
    { variables: { search: search || undefined, category: category || undefined, pageSize: 30 }, skip: false },
  )

  const articles   = data?.kbArticles?.items ?? []
  const allCategories = catData?.kbCategories ?? []
  // Nella griglia solo le categorie con articoli pubblicati.
  const categories = allCategories.filter((c) => c.count > 0)
  const categoryLabel = (name: string) => allCategories.find((c) => c.name === name)?.label ?? name

  // Ricerca e categoria stanno nell'URL: un link condiviso mostra la stessa cosa.
  useEffect(() => {
    const currentSearch   = searchParams.get('search') ?? ''
    const currentCategory = searchParams.get('category') ?? ''
    if (currentSearch !== search || currentCategory !== category) {
      const next: Record<string, string> = {}
      if (search) next['search'] = search
      if (category) next['category'] = category
      setSearchParams(next)
    }
  }, [search, category, searchParams, setSearchParams])

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
      {!search && !category && categories.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
            {t('kb.categories')}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {categories.map(cat => (
              <button
                key={cat.name}
                onClick={() => { setCategory(cat.name); setSearch('') }}
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
                <BookOpen size={24} color={colors.brand} aria-hidden="true" />
                <span style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark }}>{cat.label}</span>
                <span style={{ fontSize: 10, color: colors.slateLight }}>{t('kb.articleCount', { count: cat.count })}</span>
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
          {canSubmit && <Link
            to="/tickets/new"
            style={{ color: colors.brand, fontWeight: 500, fontSize: 10 }}
          >
            {t('kb.openTicket')}
          </Link>}
        </div>
      ) : (
        <div>
          {search && (
            <div style={{ marginBottom: 16, fontSize: 10, color: colors.slate }}>
              {t('kb.searchResults', { count: articles.length })} "<strong>{search}</strong>"
              {' '}
              <button type="button" onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: colors.brand, cursor: 'pointer', fontSize: 10 }}>
                {t('kb.clearSearch')}
              </button>
            </div>
          )}
          {/* H-13: si dice che si sta guardando una CATEGORIA, con la sua
              etichetta, e si può tornare all'elenco. */}
          {category && (
            <div style={{ marginBottom: 16, fontSize: 10, color: colors.slate }}>
              {t('kb.categoryResults', { count: articles.length, category: categoryLabel(category) })}
              {' '}
              <button type="button" onClick={() => setCategory('')} style={{ background: 'none', border: 'none', color: colors.brand, cursor: 'pointer', fontSize: 10 }}>
                {t('kb.clearCategory')}
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
                      }}>
                        {categoryLabel(article.category)}
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
