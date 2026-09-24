import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useQuery } from '@apollo/client/react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkUnderline } from '@opengraphity/web-core'
import { BookOpen, Eye, ThumbsUp, ThumbsDown, Tag, ArrowLeft, User, Calendar } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { Pill } from '@/components/ui/Pill'
import { DetailLayout } from '@/components/ui/DetailLayout'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useValueStyle } from '@/hooks/useValueStyle'
import { formatDate } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'

const GET_ARTICLE = gql`
  query KBArticleBySlug($slug: String!) {
    kbArticleBySlug(slug: $slug) {
      id title slug body category tags status
      authorId authorName views helpfulCount notHelpfulCount myVote audience
      createdAt updatedAt publishedAt
    }
  }
`

/** Related = sharing tags, the closest first (tour G7): the latest of the same category were not related at all. */
const GET_RELATED = gql`
  query KBRelated($id: ID!) {
    kbRelatedArticles(id: $id, limit: 4) { id title slug category views }
  }
`

const RATE_ARTICLE = gql`
  mutation RateKBArticle($id: ID!, $helpful: Boolean!) {
    rateKBArticle(id: $id, helpful: $helpful) { id helpfulCount notHelpfulCount myVote }
  }
`

export function KBArticlePage() {
  const { slug }  = useParams<{ slug: string }>()
  const { t }     = useTranslation()
  // F5: etichetta e colore della categoria dal vocabolario `kb_category`.
  const { labelOf } = useDomainVocabularies()
  const styleOf = useValueStyle()

  const { data, loading, error, refetch } = useQuery<{ kbArticleBySlug: {
    id: string; title: string; slug: string; body: string; category: string
    tags: string[]; status: string; authorId: string; authorName: string
    views: number; helpfulCount: number; notHelpfulCount: number
    /** One vote per person (G8): the reader's own, or null. */
    myVote: boolean | null; audience: 'staff' | 'everyone'
    createdAt: string; updatedAt: string; publishedAt: string | null
  } }>(GET_ARTICLE, {
    variables: { slug },
    fetchPolicy: 'network-only',
    skip: !slug,
  })

  const article = data?.kbArticleBySlug

  const { data: relData } = useQuery<{ kbRelatedArticles: Array<{ id: string; title: string; slug: string; category: string; views: number }> }>(
    GET_RELATED,
    { variables: { id: article?.id ?? '' }, skip: !article?.id },
  )

  /**
   * The thank-you lives in `onCompleted`: it used to be chained on the
   * promise (`void rateArticle(...).then(toast)`), and Apollo 4 rejects that
   * promise even when `onError` is set — so a failed vote left an unhandled
   * rejection behind (the chained promise had no handler), on top of the
   * error notice. `onCompleted` runs only when the vote was recorded.
   */
  const [rateArticle] = useMutation(RATE_ARTICLE, {
    onError: (e: { message: string }) => showError(e),
    onCompleted: () => toast.success(t('pages.kb.thanks')),
  })

  const related = relData?.kbRelatedArticles ?? []

  if (loading && !data) return <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', padding: 32 }}>{t('common.loading')}</div>
  // A failed request (network, 500, auth) is NOT "article not found" (F-09).
  if (error) {
    return (
      <PageContainer>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </PageContainer>
    )
  }
  if (!article) return <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.kb.articleNotFound')} />

  return (
    <PageContainer>
      <DetailLayout sideWidth={280} gap={32}>
        {/* Main content */}
        <div>
          <Link to="/knowledge-base" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-slate)', textDecoration: 'none', fontSize: 'var(--font-size-body)', marginBottom: 20 }}>
            <ArrowLeft size={14} /> {t('pages.kb.backToList')}
          </Link>

          <div style={{ marginBottom: 12 }}>
            <Pill bg={styleOf('kb_category', article.category).bg} color={styleOf('kb_category', article.category).color} radius={12} style={{ fontSize: 'var(--font-size-body)', padding: '3px 10px' }}>
              {labelOf('kb_category', article.category) ?? article.category}
            </Pill>
            {article.audience === 'staff' && (
              <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" radius={12} style={{ fontSize: 'var(--font-size-body)', padding: '3px 10px', marginLeft: 8 }}>
                {t('pages.kbAdmin.audienceValue.staff')}
              </Pill>
            )}
          </div>

          <h1 style={{ fontSize: 26, fontWeight: 700, color: colors.slateDark, margin: '0 0 16px', lineHeight: 1.3 }}>
            {article.title}
          </h1>

          <div style={{ display: 'flex', gap: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 24, flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <User size={11} /> {article.authorName}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Calendar size={11} /> {formatDate(article.publishedAt)}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Eye size={11} /> {t('pages.kb.views', { count: article.views })}
            </span>
          </div>

          {/* Markdown body */}
          <div style={{
            fontSize: 'var(--font-size-body)', lineHeight: 1.7, color: palette.neutral.textMuted,
            borderTop: `1px solid ${colors.border}`, paddingTop: 24,
          }}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkUnderline]}>
              {article.body}
            </ReactMarkdown>
          </div>

          {/* Tags */}
          {article.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 24, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
              <Tag size={13} color={colors.slateLight} />
              {article.tags.map((tag) => (
                <span key={tag} style={{ padding: '2px 8px', borderRadius: 8, background: colors.slateBg, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Allegati */}
          <div style={{ marginTop: 24 }}>
            <AttachmentsSection entityType="kb_article" entityId={article.id} />
          </div>

          {/* Helpful feedback */}
          <div style={{ marginTop: 32, padding: 20, background: 'var(--color-slate-bg)', borderRadius: 10, border: `1px solid ${colors.border}`, textAlign: 'center' }}>
            <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }}>
              {t('pages.kb.wasHelpful')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
              {([true, false] as const).map((helpful) => {
                // The reader's own vote shows as chosen: pressing it again changes nothing, the other one moves it (G8).
                const mine = article.myVote === helpful
                return (
                  <button
                    key={String(helpful)}
                    type="button"
                    aria-pressed={mine}
                    onClick={() => { if (!mine) void rateArticle({ variables: { id: article.id, helpful } }) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: `1px solid ${mine ? 'var(--color-brand)' : colors.border}`, background: mine ? 'var(--color-brand-light)' : colors.white, cursor: mine ? 'default' : 'pointer', fontSize: 'var(--font-size-body)', fontWeight: mine ? 600 : 400 }}
                  >
                    {helpful
                      ? <><ThumbsUp size={14} color={colors.success} /> {t('pages.kb.yes')} ({article.helpfulCount})</>
                      : <><ThumbsDown size={14} color={colors.danger} /> {t('pages.kb.no')} ({article.notHelpfulCount})</>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {related.length > 0 && (
            <div style={{ background: 'var(--color-slate-bg)', borderRadius: 10, border: `1px solid ${colors.border}`, padding: 16 }}>
              <h3 style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>
                {t('pages.kb.related')}
              </h3>
              {related.map((a) => (
                <Link
                  key={a.id}
                  to={`/knowledge-base/${a.slug}`}
                  style={{ display: 'block', textDecoration: 'none', padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}
                >
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: colors.slateDark, marginBottom: 2 }}>{a.title}</div>
                  <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Eye size={10} /> {a.views}
                  </div>
                </Link>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16, background: 'var(--color-slate-bg)', borderRadius: 10, border: `1px solid ${colors.border}`, padding: 16 }}>
            <h3 style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>
              {t('pages.kb.info')}
            </h3>
            <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div><strong>{t('pages.kb.author')}:</strong> {article.authorName}</div>
              <div><strong>{t('pages.kb.published')}:</strong> {formatDate(article.publishedAt)}</div>
              <div><strong>{t('pages.kb.updated')}:</strong> {formatDate(article.updatedAt)}</div>
              <div><strong>{t('pages.kb.views')}:</strong> {article.views}</div>
            </div>
          </div>
        </div>
      </DetailLayout>
    </PageContainer>
  )
}
