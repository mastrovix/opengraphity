import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useQuery } from '@apollo/client/react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Eye, ThumbsUp, ThumbsDown, Tag, ArrowLeft, User, Calendar } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'

const GET_ARTICLE = gql`
  query KBArticleBySlug($slug: String!) {
    kbArticleBySlug(slug: $slug) {
      id title slug body category tags status
      authorId authorName views helpfulCount notHelpfulCount
      createdAt updatedAt publishedAt
    }
  }
`

const GET_RELATED = gql`
  query KBRelated($category: String!) {
    kbArticles(category: $category, status: "published", pageSize: 5) {
      items { id title slug category views }
    }
  }
`

const RATE_ARTICLE = gql`
  mutation RateKBArticle($id: ID!, $helpful: Boolean!) {
    rateKBArticle(id: $id, helpful: $helpful) { id helpfulCount notHelpfulCount }
  }
`

const CATEGORY_COLORS: Record<string, string> = {
  hardware: '#3b82f6', software: '#8b5cf6', network: '#06b6d4',
  security: '#ef4444', 'how-to': '#22c55e', faq: '#f59e0b', general: '#94a3b8',
}

export function KBArticlePage() {
  const { slug }  = useParams<{ slug: string }>()
  const { t }     = useTranslation()

  const { data, loading, error } = useQuery<{ kbArticleBySlug: {
    id: string; title: string; slug: string; body: string; category: string
    tags: string[]; status: string; authorId: string; authorName: string
    views: number; helpfulCount: number; notHelpfulCount: number
    createdAt: string; updatedAt: string; publishedAt: string | null
  } }>(GET_ARTICLE, {
    variables: { slug },
    fetchPolicy: 'network-only',
    skip: !slug,
  })

  const article = data?.kbArticleBySlug

  const { data: relData } = useQuery<{ kbArticles: { items: Array<{ id: string; title: string; slug: string; category: string; views: number }> } }>(
    GET_RELATED,
    { variables: { category: article?.category ?? '' }, skip: !article?.category },
  )

  const [rateArticle] = useMutation(RATE_ARTICLE, {
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const related = (relData?.kbArticles?.items ?? []).filter((a) => a.id !== article?.id).slice(0, 4)

  if (loading) return <div style={{ fontSize: 13, color: '#94a3b8', padding: 32 }}>{t('common.loading')}</div>
  if (error || !article) return <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kb.articleNotFound')} />

  return (
    <PageContainer style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 32 }}>
      {/* Main content */}
      <div>
        <Link to="/knowledge-base" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#64748b', textDecoration: 'none', fontSize: 13, marginBottom: 20 }}>
          <ArrowLeft size={14} /> {t('pages.kb.backToList')}
        </Link>

        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 12, background: (CATEGORY_COLORS[article.category] ?? '#94a3b8') + '20', color: CATEGORY_COLORS[article.category] ?? '#94a3b8', fontWeight: 600 }}>
            {article.category}
          </span>
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 700, color: '#1a2332', margin: '0 0 16px', lineHeight: 1.3 }}>
          {article.title}
        </h1>

        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#94a3b8', marginBottom: 24, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <User size={11} /> {article.authorName}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Calendar size={11} /> {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : '—'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Eye size={11} /> {article.views} visualizzazioni
          </span>
        </div>

        {/* Markdown body */}
        <div style={{
          fontSize: 14, lineHeight: 1.7, color: '#334155',
          borderTop: '1px solid #e2e8f0', paddingTop: 24,
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {article.body}
          </ReactMarkdown>
        </div>

        {/* Tags */}
        {article.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 24, paddingTop: 16, borderTop: '1px solid #e2e8f0' }}>
            <Tag size={13} color="#94a3b8" />
            {article.tags.map((tag) => (
              <span key={tag} style={{ padding: '2px 8px', borderRadius: 8, background: '#f1f5f9', color: '#64748b', fontSize: 12 }}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Helpful feedback */}
        <div style={{ marginTop: 32, padding: 20, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0', textAlign: 'center' }}>
          <p style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#1a2332' }}>
            {t('pages.kb.wasHelpful')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button
              onClick={() => void rateArticle({ variables: { id: article.id, helpful: true } }).then(() => toast.success(t('pages.kb.thanks')))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              <ThumbsUp size={14} color="#22c55e" /> {t('pages.kb.yes')} ({article.helpfulCount})
            </button>
            <button
              onClick={() => void rateArticle({ variables: { id: article.id, helpful: false } }).then(() => toast.success(t('pages.kb.thanks')))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              <ThumbsDown size={14} color="#ef4444" /> {t('pages.kb.no')} ({article.notHelpfulCount})
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div>
        {related.length > 0 && (
          <div style={{ background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>
              {t('pages.kb.related')}
            </h3>
            {related.map((a) => (
              <Link
                key={a.id}
                to={`/knowledge-base/${a.slug}`}
                style={{ display: 'block', textDecoration: 'none', padding: '8px 0', borderBottom: '1px solid #e2e8f0' }}
              >
                <div style={{ fontSize: 13, fontWeight: 500, color: '#1a2332', marginBottom: 2 }}>{a.title}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Eye size={10} /> {a.views}
                </div>
              </Link>
            ))}
          </div>
        )}

        <div style={{ marginTop: 16, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>
            {t('pages.kb.info')}
          </h3>
          <div style={{ fontSize: 12, color: '#64748b', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div><strong>{t('pages.kb.author')}:</strong> {article.authorName}</div>
            <div><strong>{t('pages.kb.published')}:</strong> {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : '—'}</div>
            <div><strong>{t('pages.kb.updated')}:</strong> {new Date(article.updatedAt).toLocaleDateString()}</div>
            <div><strong>{t('pages.kb.views')}:</strong> {article.views}</div>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}
