/**
 * THE FIRST SUSPECTS OF AN INCIDENT (owner, 25 Sep 2026): the changes on its
 * CIs that were being released when it opened, then those whose release ended
 * in the days before (the tenant's recent-changes window). A card of its own,
 * beside the suggested problems.
 *
 * Shown, never linked: the only link between an incident and a change is
 * «resolved by», and a suspect is not that — so no button here.
 */
import { Loading } from '@/components/ui/Loading'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { GitPullRequestArrow } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { colors, palette } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { formatDateTime } from '@/lib/datetime'

export const GET_CHANGE_SUSPECTS = gql`
  query IncidentChangeSuspects($incidentId: ID!) {
    incidentChangeSuspects(incidentId: $incidentId) {
      id code title status runningAtOpening releasedAt
      cis { id name }
    }
  }
`

interface Suspect {
  id: string
  code: string
  title: string
  status: string
  runningAtOpening: boolean
  releasedAt: string | null
  cis: Array<{ id: string; name: string }>
}

const muted = { fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 } as const
const badge = { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase' } as const

export function ChangeSuspectsCard({ incidentId }: { incidentId: string }) {
  const { t } = useTranslation()
  const { labelFor } = useWorkflowSteps('change')
  const { data, loading, error } = useQuery<{ incidentChangeSuspects: Suspect[] }>(GET_CHANGE_SUSPECTS, {
    variables: { incidentId },
    fetchPolicy: 'cache-and-network',
  })
  const items = data?.incidentChangeSuspects ?? []

  return (
    <SectionCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <GitPullRequestArrow size={14} color="var(--color-brand)" /> {t('components.changeSuspects.title')}
        </span>
      }
      count={items.length}
      defaultOpen
    >
      <p style={{ ...muted, marginBottom: 10 }}>{t('components.changeSuspects.intro')}</p>
      {error ? (
        <div role="alert" style={{ padding: '8px 10px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 6, color: 'var(--color-danger)', fontSize: 'var(--font-size-body)' }}>
          {t('components.changeSuspects.failed', { reason: error.message })}
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : items.length === 0 ? (
        <p style={muted}>{t('components.changeSuspects.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((c) => (
            <li key={c.id} style={{ padding: '10px 12px', border: `1px solid ${c.runningAtOpening ? palette.warning.border : colors.border}`, borderRadius: 8, background: colors.white }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Link to={`/changes/${c.id}`} style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                  {c.code || c.id.slice(0, 8)}
                </Link>
                {c.runningAtOpening ? (
                  <span style={{ ...badge, background: palette.warning.tint, color: palette.warning.text }}>{t('components.changeSuspects.running')}</span>
                ) : (
                  <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
                    {t('components.changeSuspects.releasedAt', { when: formatDateTime(c.releasedAt) })}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ ...badge, background: colors.slateBg, color: 'var(--color-slate)' }}>{labelFor(c.status)}</span>
              </div>
              <Link to={`/changes/${c.id}`} style={{ display: 'block', fontSize: 'var(--font-size-body)', color: 'var(--color-link)', fontWeight: 500, margin: '4px 0', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {c.title}
              </Link>
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                {t('components.changeSuspects.on', { cis: c.cis.map((ci) => ci.name).join(', ') })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
