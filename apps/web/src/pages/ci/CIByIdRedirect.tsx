/**
 * Rotta `/cis/:id` → `/ci/:typeName/:id`. Le notifiche in-app costruiscono il
 * link come /<entity>s/<id>: per un CI (`ci.health_changed`) arriva /cis/<id>
 * senza il tipo, che serve alla rotta reale. Qui si risolve il tipo e si
 * reindirizza. Un errore di rete resta nel layout con "Riprova" (non lo
 * schermo intero di RouteError); un CI inesistente ha lo stesso stato vuoto
 * degli altri "non trovato", con il ritorno alla CMDB.
 */
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import { GET_CI_BY_ID_REF } from '@/graphql/queries'
import { ciPath } from '@/lib/ciPath'
import { PageContainer } from '@/components/PageContainer'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'

export function CIByIdRedirect() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useQuery<{ ciById: { id: string; type: string } | null }>(GET_CI_BY_ID_REF, { variables: { id } })
  if (loading) return <PageLoader />
  if (error) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (!data?.ciById) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Server size={32} />}
          title={t('errors.ciNotFound')}
          description={t('errors.ciNotFoundHint', { id: id ?? '' })}
          action={<Button variant="secondary" onClick={() => navigate('/cmdb')}>{t('errors.backToCmdb')}</Button>}
        />
      </PageContainer>
    )
  }
  return <Navigate to={ciPath(data.ciById)} replace />
}
