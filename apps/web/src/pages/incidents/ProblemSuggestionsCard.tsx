/**
 * THE PROBLEMS STILL OPEN ON THE INCIDENT'S CIs (owner, 25 Sep 2026): the known
 * error matching of ITIL, on its own card. Each suggestion says why it is there
 * (the incident's CIs it affects) and carries its workaround, so whoever works
 * the incident decides without opening the problem.
 *
 * OpenGrafo proposes and never links on its own: the same CI is not the same
 * cause. «Link» is the operator's decision, and a linked problem leaves this
 * card for the linked tickets above — the suggestion and the decision stay two
 * places (owner: «se premo collega finisce sotto la scheda dei problem
 * collegati»).
 */
import { Loading } from '@/components/ui/Loading'
import { Pill } from '@/components/ui/Pill'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import { useMutation, useQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { Lightbulb } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Button } from '@/components/Button'
import { colors, palette } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { LINK_INCIDENT_TO_PROBLEM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'

export const GET_PROBLEM_SUGGESTIONS = gql`
  query IncidentProblemSuggestions($incidentId: ID!) {
    incidentProblemSuggestions(incidentId: $incidentId) {
      id number title status knownError workaround
      cis { id name }
    }
  }
`

interface Suggestion {
  id: string
  number: string
  title: string
  status: string
  knownError: boolean
  workaround: string | null
  cis: Array<{ id: string; name: string }>
}

const muted = { fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 } as const

export function ProblemSuggestionsCard({ incidentId, canLink }: { incidentId: string; canLink: boolean }) {
  const { t } = useTranslation()
  const { labelFor } = useWorkflowSteps('problem')
  const { data, loading, error } = useQuery<{ incidentProblemSuggestions: Suggestion[] }>(GET_PROBLEM_SUGGESTIONS, {
    variables: { incidentId },
    fetchPolicy: 'cache-and-network',
  })
  // Both lists read again before the button frees: the problem is seen leaving here and arriving there.
  const [link] = useMutation(LINK_INCIDENT_TO_PROBLEM, {
    refetchQueries: ['GetIncident', 'IncidentProblemSuggestions'],
    awaitRefetchQueries: true,
  })
  const items = data?.incidentProblemSuggestions ?? []

  const linkTo = async (problemId: string): Promise<void> => {
    try {
      await link({ variables: { problemId, incidentId } })
    } catch (e) {
      showError(e, t('components.problemSuggestions.linkFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <SectionCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Lightbulb size={14} color="var(--color-brand)" /> {t('components.problemSuggestions.title')}
        </span>
      }
      count={items.length}
      defaultOpen
    >
      <p style={{ ...muted, marginBottom: 10 }}>{t('components.problemSuggestions.intro')}</p>
      {error ? (
        <div role="alert" style={{ padding: '8px 10px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 6, color: 'var(--color-danger)', fontSize: 'var(--font-size-body)' }}>
          {t('components.problemSuggestions.failed', { reason: error.message })}
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : items.length === 0 ? (
        <p style={muted}>{t('components.problemSuggestions.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((p) => (
            <li key={p.id} style={{ padding: '10px 12px', border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.white }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Link to={`/problems/${p.id}`} style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                  {p.number || p.id.slice(0, 8)}
                </Link>
                {/* A known error says so, in green; its step would only say it again (demo: «Known Error (KEDB)»).
                    Any other problem shows its step as the workflow names it. */}
                {p.knownError ? (
                  <Pill bg={palette.success.tint} color={palette.success.text} radius={4} title={labelFor(p.status)} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                    {t('components.problemSuggestions.knownError')}
                  </Pill>
                ) : (
                  <Pill bg={colors.slateBg} color="var(--color-slate)" radius={4} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                    {labelFor(p.status)}
                  </Pill>
                )}
                <span style={{ flex: 1 }} />
                {canLink && (
                  <Button size="xs" onClick={() => linkTo(p.id)}>{t('components.problemSuggestions.link')}</Button>
                )}
              </div>
              <Link to={`/problems/${p.id}`} style={{ display: 'block', fontSize: 'var(--font-size-body)', color: 'var(--color-link)', fontWeight: 500, margin: '4px 0', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {p.title}
              </Link>
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                {t('components.problemSuggestions.on', { cis: p.cis.map((c) => c.name).join(', ') })}
              </div>
              {p.workaround && (
                <div style={{ marginTop: 6, padding: '6px 8px', background: colors.slateBg, borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', whiteSpace: 'pre-wrap' }}>
                  <strong>{t('components.problemSuggestions.workaround')}</strong> {p.workaround}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
