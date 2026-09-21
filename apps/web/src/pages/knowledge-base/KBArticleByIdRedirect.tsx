/**
 * Rotta `/kb-articles/:id` → `/knowledge-base/:slug`.
 *
 * Revisione totale · B-21/A-20: le notifiche e le approvazioni di un articolo
 * della knowledge base portano il suo ID (`entity_type: 'kb_article'`), ma la
 * pagina dell'articolo si apre per SLUG. Senza questa rotta la tabella dei
 * percorsi delle notifiche non poteva avere una voce per `kb_article`, e la
 * notifica «articolo pubblicato» non era cliccabile. Qui si risolve lo slug e
 * si reindirizza, come fa `CIByIdRedirect` per i CI.
 */
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'

const GET_ARTICLE_SLUG = gql`
  query KBArticleSlug($id: ID!) {
    kbArticle(id: $id) { id slug }
  }
`

export function KBArticleByIdRedirect() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useQuery<{ kbArticle: { id: string; slug: string } | null }>(
    GET_ARTICLE_SLUG, { variables: { id } },
  )
  if (loading && !data) return <PageLoader />
  if (error) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (!data?.kbArticle?.slug) {
    return (
      <PageContainer>
        <EmptyState
          icon={<BookOpen size={32} />}
          title={t('pages.kb.notFound')}
          description={t('pages.kb.notFoundHint', { id: id ?? '' })}
          action={<Button variant="secondary" onClick={() => navigate('/knowledge-base')}>{t('pages.kb.backToKb')}</Button>}
        />
      </PageContainer>
    )
  }
  return <Navigate to={`/knowledge-base/${data.kbArticle.slug}`} replace />
}
