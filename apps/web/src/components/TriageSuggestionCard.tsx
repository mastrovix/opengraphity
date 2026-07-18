import { gql } from '@apollo/client'
import { useLazyQuery } from '@apollo/client/react'
import { Sparkles } from 'lucide-react'

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

const CONF_LABEL: Record<string, { label: string; bg: string; color: string }> = {
  high:   { label: 'confidenza alta',  bg: '#dcfce7', color: '#15803d' },
  medium: { label: 'confidenza media', bg: '#fef3c7', color: '#b45309' },
  low:    { label: 'confidenza bassa', bg: '#fee2e2', color: '#b91c1c' },
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
  const [run, { data, loading, error }] = useLazyQuery<{ triageSuggestion: Suggestion }>(TRIAGE_SUGGESTION, {
    fetchPolicy: 'network-only',
  })

  const s = data?.triageSuggestion
  const conf = s ? (CONF_LABEL[s.confidence] ?? { label: s.confidence, bg: 'var(--color-danger)', color: '#fff' }) : null

  return (
    <div style={{ marginBottom: 20 }}>
      <button
        type="button"
        disabled={loading || title.trim() === ''}
        onClick={() => void run({ variables: { title, description: description || null, ciIds } })}
        title={title.trim() === '' ? 'Inserisci prima un titolo' : 'Suggerimento AI basato su incident simili e impatto CI'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 14px', borderRadius: 8,
          border: '1px solid var(--color-brand)', background: 'transparent',
          color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', fontWeight: 500,
          cursor: loading || title.trim() === '' ? 'not-allowed' : 'pointer',
          opacity: title.trim() === '' ? 0.5 : 1,
        }}
      >
        <Sparkles size={14} /> {loading ? 'Analisi in corso…' : 'Suggerisci triage'}
      </button>

      {error && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--color-danger-bg)', border: '1px solid #fecaca', borderRadius: 8, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>
          Errore triage AI: {error.message}
        </div>
      )}

      {s && conf && !loading && (
        <div style={{ marginTop: 10, padding: '14px 16px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
              <Sparkles size={13} color="var(--color-brand)" /> Suggerimento AI
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: conf.bg, color: conf.color, textTransform: 'uppercase' }}>
              {conf.label}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--font-size-label)', padding: '3px 10px', borderRadius: 6, background: '#fff', border: '1px solid #e5e7eb' }}>
              Severity: <strong>{s.severity}</strong>
            </span>
            <span style={{ fontSize: 'var(--font-size-label)', padding: '3px 10px', borderRadius: 6, background: '#fff', border: '1px solid #e5e7eb' }}>
              Categoria: <strong>{s.category}</strong>
            </span>
            {s.teamName && (
              <span style={{ fontSize: 'var(--font-size-label)', padding: '3px 10px', borderRadius: 6, background: '#fff', border: '1px solid #e5e7eb' }}>
                Team: <strong>{s.teamName}</strong>
              </span>
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
              Basato su {s.similarUsed.length} incident simili, tra cui{' '}
              {s.similarUsed.slice(0, 2).map(x => x.number ?? x.title).join(', ')}.
            </p>
          )}

          <button
            type="button"
            onClick={() => onApply({ severity: s.severity, category: s.category, teamName: s.teamName })}
            style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: 'pointer' }}
          >
            Applica suggerimento
          </button>
        </div>
      )}
    </div>
  )
}
