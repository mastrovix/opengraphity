import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { GET_KB_ARTICLE_BY_SLUG, GET_KB_ARTICLES } from '@/graphql/queries'
import { RATE_KB_ARTICLE } from '@/graphql/mutations'

interface KBArticle {
  id: string; title: string; slug: string; body: string; category: string
  authorName: string; views: number; helpfulCount: number; notHelpfulCount: number
  createdAt: string; publishedAt: string | null
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(iso))
  } catch { return iso }
}

export function KBArticlePage() {
  const { slug }    = useParams<{ slug: string }>()
  const { t }       = useTranslation()
  const [voted, setVoted] = useState<boolean | null>(null)

  const { data, loading } = useQuery<{ kbArticleBySlug: KBArticle }>(
    GET_KB_ARTICLE_BY_SLUG,
    { variables: { slug }, skip: !slug },
  )

  const article = data?.kbArticleBySlug

  const { data: relatedData } = useQuery<{ kbArticles: { items: KBArticle[] } }>(
    GET_KB_ARTICLES,
    { variables: { category: article?.category, pageSize: 4 }, skip: !article },
  )
  const related = (relatedData?.kbArticles?.items ?? []).filter(a => a.id !== article?.id).slice(0, 3)

  const [rateArticle, { data: ratedData }] = useMutation<{ rateKBArticle: { helpfulCount: number; notHelpfulCount: number } }>(RATE_KB_ARTICLE)
  const helpfulCount    = ratedData?.rateKBArticle?.helpfulCount    ?? article?.helpfulCount    ?? 0
  const notHelpfulCount = ratedData?.rateKBArticle?.notHelpfulCount ?? article?.notHelpfulCount ?? 0

  function handleVote(helpful: boolean) {
    if (voted !== null || !article) return
    setVoted(helpful)
    void rateArticle({ variables: { id: article.id, helpful } })
  }

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: '#94A3B8' }}>{t('common.loading')}</div>
  if (!article) return <div style={{ padding: 48, textAlign: 'center', color: '#94A3B8' }}>Articolo non trovato</div>

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#94A3B8', marginBottom: 20 }}>
        <Link to="/kb" style={{ color: '#0EA5E9' }}>{t('kb.breadcrumb')}</Link>
        <span>›</span>
        <span style={{ textTransform: 'capitalize' }}>{article.category}</span>
        <span>›</span>
        <span style={{ color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {article.title}
        </span>
      </div>

      {/* Article header */}
      <h1 style={{ fontSize: 26, fontWeight: 700, color: '#0F172A', marginBottom: 12, lineHeight: 1.3 }}>
        {article.title}
      </h1>
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: '#94A3B8', marginBottom: 32, flexWrap: 'wrap' }}>
        <span>{t('kb.by')} <strong style={{ color: '#64748B' }}>{article.authorName}</strong></span>
        {article.publishedAt && <span>{t('kb.published')}: {fmtDate(article.publishedAt)}</span>}
        <span>{article.views} {t('kb.views')}</span>
      </div>

      {/* Article body */}
      <div className="md-body" style={{ fontSize: 10, lineHeight: 1.8, color: '#0F172A', marginBottom: 40 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {article.body}
        </ReactMarkdown>
      </div>

      {/* Feedback */}
      <div style={{
        padding:         24,
        backgroundColor: '#F8FAFC',
        borderRadius:    12,
        textAlign:       'center',
        marginBottom:    32,
      }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#0F172A', marginBottom: 14 }}>
          {t('kb.helpful')}
        </div>
        {voted !== null ? (
          <p style={{ fontSize: 10, color: '#64748B' }}>Grazie per il tuo feedback!</p>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button
              onClick={() => handleVote(true)}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          6,
                padding:      '9px 20px',
                borderRadius: 8,
                border:       '1px solid #E2E8F0',
                background:   '#fff',
                cursor:       'pointer',
                fontSize:     14,
                color:        '#22C55E',
                fontWeight:   500,
              }}
            >
              <ThumbsUp size={16} />
              {t('kb.yes')} ({helpfulCount})
            </button>
            <button
              onClick={() => handleVote(false)}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          6,
                padding:      '9px 20px',
                borderRadius: 8,
                border:       '1px solid #E2E8F0',
                background:   '#fff',
                cursor:       'pointer',
                fontSize:     14,
                color:        '#EF4444',
                fontWeight:   500,
              }}
            >
              <ThumbsDown size={16} />
              {t('kb.no')} ({notHelpfulCount})
            </button>
          </div>
        )}
      </div>

      {/* Related articles */}
      {related.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, color: '#0F172A', marginBottom: 14 }}>
            {t('kb.related')}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {related.map(a => (
              <Link
                key={a.id}
                to={`/kb/${a.slug}`}
                style={{
                  padding:         '12px 16px',
                  backgroundColor: '#F8FAFC',
                  border:          '1px solid #E2E8F0',
                  borderRadius:    8,
                  fontSize:        14,
                  color:           '#0EA5E9',
                  textDecoration:  'none',
                  fontWeight:      500,
                  display:         'block',
                }}
              >
                {a.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* CTA */}
      <div style={{
        padding:         20,
        backgroundColor: '#FFF7ED',
        border:          '1px solid #FED7AA',
        borderRadius:    10,
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
        flexWrap:        'wrap',
        gap:             12,
      }}>
        <span style={{ fontSize: 10, color: '#92400E', fontWeight: 500 }}>
          {t('kb.notSolved')}
        </span>
        <Link
          to="/tickets/new"
          style={{
            padding:         '9px 18px',
            backgroundColor: '#0EA5E9',
            color:           '#fff',
            borderRadius:    8,
            fontSize:        14,
            fontWeight:      600,
            textDecoration:  'none',
          }}
        >
          {t('kb.openTicket')}
        </Link>
      </div>
    </div>
  )
}
