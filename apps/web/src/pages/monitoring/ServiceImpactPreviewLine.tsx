/**
 * Anteprima dal vivo delle impostazioni in corso di modifica (ondata 2):
 * «Con queste impostazioni adesso: <badge salute> punteggio 41 (3 componenti
 * pesano)». Calcolo puro sugli allarmi di adesso (`serviceImpactPreview`),
 * nessuna scrittura.
 *
 * Debounce di 400 ms (`useDebounced`) sulle variabili serializzate: mentre
 * l'admin digita non parte una query per tasto. Le variabili sono ricostruite
 * dal JSON con `useMemo` così l'oggetto passato ad Apollo è stabile.
 *
 * Niente fallback silenziosi: la query che fallisce è una riga `role="alert"`
 * con il messaggio del server, mai un'anteprima vecchia spacciata per nuova.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { useDebounced } from '@/hooks/useDebounced'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { colors, palette } from '@/lib/tokens'
import { ServiceHealthBadge } from './servicesShared'
import type { ServiceImpactPreview, ServiceImpactRulesInput, ServiceMapNodeInput } from '@/types/services'

export const PREVIEW_DEBOUNCE_MS = 400

interface PreviewVars {
  id:     string
  rules:  ServiceImpactRulesInput | null
  nodes:  ServiceMapNodeInput[] | null
}

interface Props {
  mapId: string
  /** Regole in corso di modifica (null = quelle salvate). */
  rules?: ServiceImpactRulesInput | null
  /** Solo i componenti cambiati (null = quelli salvati). */
  nodes?: ServiceMapNodeInput[] | null
  /**
   * Istante dell'ultima valutazione della mappa: quando cambia, «adesso» non è
   * più lo stesso adesso e l'anteprima si rilegge (revisione 2 · C-8). Prima
   * restava ferma all'istante del montaggio e dopo dieci minuti poteva
   * contraddire la testata senza spiegazione.
   */
  evaluatedAt?: string | null
  /** Nome del riquadro che la ospita, per distinguerla nei test. */
  testId: string
}

const box: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12,
  padding: '8px 12px', borderRadius: 8, background: palette.neutral.surface1,
  border: `1px solid ${colors.border}`, fontSize: 'var(--font-size-body)', color: colors.slateDark,
}

export function ServiceImpactPreviewLine({ mapId, rules = null, nodes = null, evaluatedAt = null, testId }: Props) {
  const { t } = useTranslation()

  // La chiave serializzata è il valore su cui si aspetta: un oggetto nuovo a
  // ogni render farebbe ripartire il debounce all'infinito.
  const key = JSON.stringify({ id: mapId, rules, nodes } satisfies PreviewVars)
  const debouncedKey = useDebounced(key, PREVIEW_DEBOUNCE_MS)
  const variables = useMemo(() => JSON.parse(debouncedKey) as PreviewVars, [debouncedKey])

  const { data, previousData, loading, error, refetch } = useQuery<{ serviceImpactPreview: ServiceImpactPreview }>(
    GET_SERVICE_IMPACT_PREVIEW,
    { variables, fetchPolicy: 'network-only' },
  )

  // Rivalutazione della mappa → «adesso» è cambiato: si rilegge (mai al primo
  // giro, che la query l'ha appena fatta).
  const lastEvaluatedAt = useRef<string | null>(evaluatedAt)
  useEffect(() => {
    if (lastEvaluatedAt.current === evaluatedAt) return
    lastEvaluatedAt.current = evaluatedAt
    void refetch()
  }, [evaluatedAt, refetch])

  if (error) {
    return (
      <p role="alert" data-testid={`${testId}-error`} style={{ ...box, color: colors.danger, fontWeight: 500 }}>
        {t('monitoring.services.preview.error', { error: error.message })}
      </p>
    )
  }

  const preview = (data ?? previousData)?.serviceImpactPreview
  if (!preview) {
    return <p style={{ ...box, color: colors.slateLight }}>{t('monitoring.services.preview.loading')}</p>
  }

  return (
    <p role="status" data-testid={testId} style={{ ...box, opacity: loading ? 0.6 : 1 }}>
      <span>{t('monitoring.services.preview.label')}</span>
      <ServiceHealthBadge health={preview.health} />
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t('monitoring.services.preview.score', { score: preview.impactScore })}</span>
      <span style={{ color: colors.slateLight }}>
        {t('monitoring.services.preview.contributing', { count: preview.contributingCount, total: preview.nodeCount })}
      </span>
    </p>
  )
}
