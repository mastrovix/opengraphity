import { useEffect } from 'react'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { Sparkles, BookOpen } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'

const GET_SIMILAR_INCIDENTS = gql`
  query SimilarIncidents($incidentId: ID!, $limit: Int) {
    similarIncidents(incidentId: $incidentId, limit: $limit) {
      ready
      items { id number title status severity createdAt resolvedAt score }
    }
    suggestedArticles(incidentId: $incidentId, limit: 3) {
      ready
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
  similarIncidents: { ready: boolean; items: SimilarItem[] }
  suggestedArticles: { ready: boolean; items: ArticleItem[] }
}

// Unknown severity renders RED (fail-visible), never a benign default.
const SEV_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fee2e2', color: '#b91c1c' },
  high:     { bg: '#ffedd5', color: '#c2410c' },
  medium:   { bg: '#fef3c7', color: '#b45309' },
  low:      { bg: '#dcfce7', color: '#15803d' },
}

function scorePct(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

export function SimilarIncidentsPanel({ incidentId }: { incidentId: string }) {
  const { data, loading, error, startPolling, stopPolling } = useQuery<QueryData>(GET_SIMILAR_INCIDENTS, {
    variables: { incidentId, limit: 5 },
    fetchPolicy: 'cache-and-network',
  })

  // The embedding is computed asynchronously right after creation: while the
  // backend reports ready=false, poll until it flips — never show "nessun
  // risultato" for an incident that simply hasn't been embedded yet.
  const pending = !!data && (!data.similarIncidents.ready || !data.suggestedArticles.ready)
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
          <Sparkles size={14} color="var(--color-brand)" /> Incident simili
        </span>
      }
      defaultOpen
    >
      {error ? (
        <div style={{ padding: '8px 10px', background: 'var(--color-danger-bg)', border: '1px solid #fecaca', borderRadius: 6, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>
          Errore ricerca semantica: {error.message}
        </div>
      ) : loading && !data ? (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>Caricamento…</p>
      ) : pending ? (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
          Analisi semantica in corso — l'embedding di questo incident è in calcolo…
        </p>
      ) : (
        <>
          {similar && similar.items.length === 0 && (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
              Nessun incident storico simile.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {similar?.items.map((it) => {
              const sev = SEV_STYLE[it.severity] ?? { bg: 'var(--color-danger)', color: '#fff' }
              const closed = it.status === 'closed' || it.status === 'resolved'
              return (
                <Link
                  key={it.id}
                  to={`/incidents/${it.id}`}
                  style={{ display: 'block', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, textDecoration: 'none', background: '#fff' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {it.number ?? it.id.slice(0, 8)}
                    </span>
                    <span title="Similarità semantica" style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-brand)' }}>
                      {scorePct(it.score)}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: 500, margin: '2px 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: sev.bg, color: sev.color, textTransform: 'uppercase' }}>
                      {it.severity}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: closed ? '#dcfce7' : '#f1f5f9', color: closed ? '#15803d' : 'var(--color-slate)', textTransform: 'uppercase' }}>
                      {it.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>

          {articles && articles.items.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 6px' }}>
                <BookOpen size={12} /> KB suggerita
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {articles.items.map((a) => (
                  <Link
                    key={a.id}
                    to={a.slug ? `/knowledge-base/${a.slug}` : '/knowledge-base'}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, textDecoration: 'none', background: '#fff' }}
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
