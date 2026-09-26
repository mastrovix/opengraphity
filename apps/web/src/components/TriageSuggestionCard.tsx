import { Pill } from '@/components/ui/Pill'
import { Button } from '@/components/Button'
import { useTranslation } from 'react-i18next'
import { useAIFeature } from '@/hooks/useAIFeature'
import { AIDisabledNotice } from '@/components/ai/AIDisabledNotice'
import i18n from '@/i18n/i18n'
import { gql } from '@apollo/client'
import { useLazyQuery } from '@apollo/client/react'
import { Sparkles } from 'lucide-react'
import { lookupOrError, colors, palette } from '@/lib/tokens'
import { SeverityBadge } from '@/components/ui/badges'

const TRIAGE_SUGGESTION = gql`
  query TriageSuggestion($title: String!, $description: String, $ciIds: [ID!]) {
    triageSuggestion(title: $title, description: $description, ciIds: $ciIds) {
      severity
      category
      teamName
      confidence
      motivation
      riskFactors
      similarUsed { id number title severity score }
    }
  }
`

export interface TriageValues {
  severity: string
  category: string
  teamName: string | null
}

interface Suggestion extends TriageValues {
  confidence: 'low' | 'medium' | 'high'
  motivation: string
  riskFactors: string[]
  similarUsed: { id: string; number: string | null; title: string; severity: string; score: number }[]
}

const CONF_LABEL: Record<string, { labelKey: string; bg: string; color: string }> = {
  high:   { labelKey: 'components.triage.confidenceHigh',   bg: palette.success.tint, color: palette.success.text },
  medium: { labelKey: 'components.triage.confidenceMedium', bg: palette.warning.tint, color: palette.warning.text },
  low:    { labelKey: 'components.triage.confidenceLow',    bg: palette.danger.tint, color: palette.danger.text },
}

/**
 * AI triage suggestion — explicitly requested by the user (button), explicitly
 * applied by the user (Applica). Never auto-fills anything.
 */
export function TriageSuggestionCard({
  title,
  description,
  ciIds,
  onApply,
}: {
  title: string
  description: string
  ciIds: string[]
  onApply: (values: TriageValues) => void
}) {
  const { t } = useTranslation()
  const enabled = useAIFeature('triage')
  const [run, { data, loading, error }] = useLazyQuery<{ triageSuggestion: Suggestion }>(TRIAGE_SUGGESTION, {
    fetchPolicy: 'network-only',
  })

  const s = data?.triageSuggestion
  const conf = s ? lookupOrError(CONF_LABEL, s.confidence, 'CONF_LABEL', { labelKey: s.confidence, bg: 'var(--color-danger)', color: colors.white }) : null

  // Funzione spenta dall'organizzazione (ondata 6 di «Nulla cablato»): lo si dice al posto del bottone.
  if (enabled === false) return <div style={{ marginBottom: 20 }}><AIDisabledNotice feature="triage" /></div>
  if (enabled === null) return null

  return (
    <div style={{ marginBottom: 20 }}>
      <Button variant="secondary"
        disabled={loading || title.trim() === ''}
        onClick={() => run({ variables: { title, description: description || null, ciIds } })}
        title={t(title.trim() === '' ? 'components.triage.needsTitle' : 'components.triage.hint')}
      >
        <Sparkles size={14} /> {loading ? t('components.triage.analyzing') : t('components.triage.suggest')}
      </Button>

      {error && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 8, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>
          {t('components.triage.error', { message: error.message })}
        </div>
      )}

      {s && conf && !loading && (
        <div style={{ marginTop: 10, padding: '14px 16px', background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
              <Sparkles size={13} color="var(--color-brand)" /> {t('components.triage.title')}
            </span>
            <Pill bg={conf.bg} color={conf.color} radius={10} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              {i18n.exists(conf.labelKey) ? t(conf.labelKey) : conf.labelKey}
            </Pill>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Pill bg={colors.white} color="var(--color-slate-dark)" style={{ fontSize: 'var(--font-size-label)', fontWeight: 400, border: `1px solid ${colors.border}`, gap: 4 }}>
              {t('pages.incidents.priority')}: <SeverityBadge value={s.severity} />
            </Pill>
            <Pill bg={colors.white} color="var(--color-slate-dark)" style={{ fontSize: 'var(--font-size-label)', fontWeight: 400, border: `1px solid ${colors.border}` }}>
              {t('pages.kb.category')}: <strong>{s.category}</strong>
            </Pill>
            {s.teamName && (
              <Pill bg={colors.white} color="var(--color-slate-dark)" style={{ fontSize: 'var(--font-size-label)', fontWeight: 400, border: `1px solid ${colors.border}` }}>
                {t('detail.team')}: <strong>{s.teamName}</strong>
              </Pill>
            )}
          </div>

          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', lineHeight: 1.45 }}>
            {s.motivation}
          </p>

          {s.riskFactors.length > 0 && (
            <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
              {s.riskFactors.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {s.similarUsed.length > 0 && (
            <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
              {t('components.triage.basedOn', {
                count: s.similarUsed.length,
                examples: s.similarUsed.slice(0, 2).map(x => x.number ?? x.title).join(', '),
              })}
            </p>
          )}

          <Button variant="primary"
            onClick={() => onApply({ severity: s.severity, category: s.category, teamName: s.teamName })}
          >
            {t('components.triage.apply')}
          </Button>
        </div>
      )}
    </div>
  )
}
