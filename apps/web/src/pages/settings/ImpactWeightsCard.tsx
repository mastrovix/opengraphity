/**
 * I pesi dell'analisi d'impatto della change (verifica «Cosa resta cablato»,
 * ondata 5). Erano scritti in `riskScore.ts` sull'API; il livello ora è la
 * fascia di rischio dichiarata qui sopra, quindi la card lo dice invece di
 * mostrare una scala sua.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Save } from 'lucide-react'
import { toast } from 'sonner'
import { SectionCard } from '@/components/ui/SectionCard'
import { Button } from '@/components/Button'
import { Input } from '@/components/ui/FormControls'
import { GET_IMPACT_ANALYSIS_WEIGHTS } from '@/graphql/queries'
import { UPDATE_IMPACT_ANALYSIS_WEIGHTS } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'
import { IMPACT_LIMITS } from '@opengraphity/types'
import { showError } from '@/lib/showError'

const WEIGHT_KEYS = ['productionCI', 'blastRadiusCI', 'blastRadiusCap', 'openIncident', 'failedChange', 'ongoingChange'] as const
const WINDOW_KEYS = ['recentChangesDays', 'recentIncidentsDays'] as const
type Key = (typeof WEIGHT_KEYS)[number] | (typeof WINDOW_KEYS)[number]
type Weights = Record<Key, number> & { isDefault: boolean }

/**
 * Gli intervalli vengono da @opengraphity/types, che è la stessa sorgente che
 * l'API usa per validarli (revisione totale · G-25): erano copiati a mano, e
 * se il server alzasse un tetto questa pagina continuerebbe a bloccare al
 * vecchio.
 */
export { IMPACT_LIMITS }

export function impactDraftValid(draft: Record<Key, string>): boolean {
  return (Object.keys(IMPACT_LIMITS) as Key[]).every((k) => {
    const raw = draft[k]
    const n = Number(raw)
    return raw !== '' && Number.isInteger(n) && n >= IMPACT_LIMITS[k].min && n <= IMPACT_LIMITS[k].max
  })
}

export function ImpactWeightsCard() {
  const { t } = useTranslation()
  const { data, loading, error } = useQuery<{ impactAnalysisWeights: Weights }>(GET_IMPACT_ANALYSIS_WEIGHTS, { fetchPolicy: 'cache-and-network' })
  const [draft, setDraft] = useState<Record<Key, string> | null>(null)
  const saved = data?.impactAnalysisWeights
  const current: Record<Key, string> | null = draft ?? (saved
    ? Object.fromEntries((Object.keys(IMPACT_LIMITS) as Key[]).map((k) => [k, String(saved[k])])) as Record<Key, string>
    : null)
  const valid = current !== null && impactDraftValid(current)
  const [save, { loading: saving }] = useMutation(UPDATE_IMPACT_ANALYSIS_WEIGHTS, {
    refetchQueries: [GET_IMPACT_ANALYSIS_WEIGHTS],
    onCompleted: () => { toast.success(t('pages.domainMatrices.impactWeights.saved')); setDraft(null) },
    onError: (e) => showError(e),
  })

  const row = (key: Key, unit: string) => current && (
    <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 56px', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
      <div style={{ minWidth: 0 }}>
        <label htmlFor={`impact-${key}`} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
          {t(`pages.domainMatrices.impactWeights.${key}`)}
        </label>
        <div style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t(`pages.domainMatrices.impactWeights.${key}Help`)}</div>
      </div>
      <Input
        id={`impact-${key}`} type="number" step={1} min={IMPACT_LIMITS[key].min} max={IMPACT_LIMITS[key].max}
        value={current[key]}
        onChange={(ev) => setDraft({ ...current, [key]: ev.target.value })}
        style={{ width: 90 }}
      />
      <span style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{unit}</span>
    </div>
  )

  return (
    <SectionCard title={t('pages.domainMatrices.impactWeights.title')} defaultOpen>
      <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, marginTop: 0 }}>
        {t('pages.domainMatrices.impactWeights.help')}
      </p>
      {loading && !data && <p>{t('common.loading')}</p>}
      {error && <p style={{ color: 'var(--color-danger-text)' }}>{error.message}</p>}
      {saved && current && (
        <>
          {saved.isDefault && (
            <p style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight, marginTop: 0 }}>
              {t('pages.domainMatrices.impactWeights.usingFactory')}
            </p>
          )}
          <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.slateLight, marginTop: 8 }}>
            {t('pages.domainMatrices.impactWeights.pointsGroup')}
          </div>
          {WEIGHT_KEYS.map((k) => row(k, t('pages.domainMatrices.impactWeights.points')))}
          <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.slateLight, marginTop: 16 }}>
            {t('pages.domainMatrices.impactWeights.windowsGroup')}
          </div>
          {WINDOW_KEYS.map((k) => row(k, t('pages.domainMatrices.impactWeights.days')))}
          {!valid && <p role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger-text)' }}>{t('pages.domainMatrices.impactWeights.range')}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button
              onClick={() => void save({ variables: { input: Object.fromEntries((Object.keys(IMPACT_LIMITS) as Key[]).map((k) => [k, Number(current[k])])) } })}
              disabled={draft === null || !valid || saving}
            >
              <Save size={14} /> {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </SectionCard>
  )
}
