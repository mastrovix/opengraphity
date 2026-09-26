import { Loading } from '@/components/ui/Loading'
import { Pill } from '@/components/ui/Pill'
import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { Sparkles, BookOpen } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { SeverityBadge } from '@/components/ui/badges'
import { colors, palette } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { AIDisabledNotice } from '@/components/ai/AIDisabledNotice'

const GET_SIMILAR_INCIDENTS = gql`
  query SimilarIncidents($incidentId: ID!, $limit: Int) {
    similarIncidents(incidentId: $incidentId, limit: $limit) {
      ready disabled failure
      items { id number title status severity createdAt resolvedAt score }
    }
    suggestedArticles(incidentId: $incidentId, limit: 3) {
      ready disabled failure
      items { id title slug category score }
    }
  }
`

interface SimilarItem {
  id: string; number: string | null; title: string; status: string
  severity: string; createdAt: string | null; resolvedAt: string | null; score: number
}
interface ArticleItem { id: string; title: string; slug: string | null; category: string | null; score: number }
interface QueryData {
  /** `failure`: why computing the incident's embedding failed; null while it is queued or done (D15). */
  similarIncidents: { ready: boolean; disabled: boolean; failure: string | null; items: SimilarItem[] }
  suggestedArticles: { ready: boolean; disabled: boolean; failure: string | null; items: ArticleItem[] }
}

function scorePct(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

export function SimilarIncidentsPanel({ incidentId }: { incidentId: string }) {
  const { t } = useTranslation()
  // Chiuso/risolto si legge dai METADATA del passo di questo cliente, non da
  // `['closed','resolved']` (B-22): un passo terminale aggiunto dal cliente
  // veniva reso come «aperto», e l'etichetta mostrava il nome grezzo del passo
  // al posto di quella scelta nel disegnatore.
  const { isTerminal, categoryOf, labelFor } = useWorkflowSteps('incident')
  const { data, loading, error, startPolling, stopPolling } = useQuery<QueryData>(GET_SIMILAR_INCIDENTS, {
    variables: { incidentId, limit: 5 },
    fetchPolicy: 'cache-and-network',
  })

  // The embedding is computed asynchronously right after creation: while the
  // backend reports ready=false, poll until it flips — never show "nessun
  // risultato" for an incident that simply hasn't been embedded yet.
  // Embedding spenti dall'organizzazione (ondata 6): niente attesa, lo si dice.
  const disabled = !!data && (data.similarIncidents.disabled || data.suggestedArticles.disabled)
  /*
   * D15 (tour of 23 Sep 2026): the API queues the computation itself when the
   * embedding is missing, so «Analysis under way…» is true — until the
   * computation FAILS. Then waiting is a lie: the polling stops and the
   * reason is shown.
   */
  const failure = data ? (data.similarIncidents.failure ?? data.suggestedArticles.failure ?? null) : null
  const pending = !!data && !disabled && failure === null && (!data.similarIncidents.ready || !data.suggestedArticles.ready)
  useEffect(() => {
    if (pending) startPolling(4000)
    else stopPolling()
    return () => stopPolling()
  }, [pending, startPolling, stopPolling])

  const similar = data?.similarIncidents
  const articles = data?.suggestedArticles

  return (
    <SectionCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={14} color="var(--color-brand)" /> {t('components.similar.title')}
        </span>
      }
      defaultOpen
    >
      {error ? (
        <div style={{ padding: '8px 10px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 6, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>
          {t('components.similar.searchError', { message: error.message })}
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : disabled ? (
        <AIDisabledNotice feature="embeddings" />
      ) : failure !== null ? (
        <div role="alert" style={{ padding: '8px 10px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 6, color: 'var(--color-danger)', fontSize: 'var(--font-size-body)' }}>
          {t('components.similar.failed', { reason: failure })}
        </div>
      ) : pending ? (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
          {t('components.similar.pending')}
        </p>
      ) : (
        <>
          {similar && similar.items.length === 0 && (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
              {t('components.similar.empty')}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {similar?.items.map((it) => {
              const closed = isTerminal(it.status) || categoryOf(it.status) === 'resolved'
              return (
                <Link
                  key={it.id}
                  to={`/incidents/${it.id}`}
                  style={{ display: 'block', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 8, textDecoration: 'none', background: colors.white }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {it.number ?? it.id.slice(0, 8)}
                    </span>
                    <span title={t('components.similar.semanticScore')} style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-brand)' }}>
                      {scorePct(it.score)}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: 500, margin: '2px 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <SeverityBadge value={it.severity} />
                    <Pill bg={closed ? palette.success.tint : colors.slateBg} color={closed ? palette.success.text : 'var(--color-slate)'} radius={4} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                      {/* As the workflow names it: a label is shown as written (the underscores were
                          stripped from real labels too), a step nobody labels is made readable by `labelFor`. */}
                      {labelFor(it.status)}
                    </Pill>
                  </div>
                </Link>
              )
            })}
          </div>

          {articles && articles.items.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 6px' }}>
                <BookOpen size={12} /> {t('components.similar.kb')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {articles.items.map((a) => (
                  <Link
                    key={a.id}
                    to={a.slug ? `/knowledge-base/${a.slug}` : '/knowledge-base'}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', border: `1px solid ${colors.border}`, borderRadius: 8, textDecoration: 'none', background: colors.white }}
                  >
                    <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.title}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-brand)', flexShrink: 0 }}>
                      {scorePct(a.score)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </SectionCard>
  )
}
