/**
 * L'AI DELL'ORGANIZZAZIONE (verifica «Cosa resta cablato», ondata 6): un
 * interruttore per funzione e le soglie del raggruppamento degli incident
 * simili. Una funzione spenta non manda niente al modello.
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GET_AI_SETTINGS } from '@/graphql/queries'
import { SET_AI_SETTINGS } from '@/graphql/mutations'
import { Input } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/Button'
import { colors } from '@/lib/tokens'
import { OrgSection, Hint, GroupLabel } from './shared'

export const AI_FEATURE_KEYS = ['triage', 'assistant', 'reportAnalysis', 'postIncident', 'kbArticles', 'embeddings'] as const
export type AIFeatureKey = (typeof AI_FEATURE_KEYS)[number]

interface Settings { features: Record<AIFeatureKey, boolean>; clusterMinSimilarity: number; clusterMinSize: number; platformConfigured: boolean; isDefault: boolean }

export function AISection() {
  const { t } = useTranslation()
  const { data, loading, error, refetch } = useQuery<{ aiSettings: Settings }>(GET_AI_SETTINGS, { fetchPolicy: 'cache-and-network' })
  const saved = data?.aiSettings
  const [features, setFeatures] = useState<Record<AIFeatureKey, boolean> | null>(null)
  const [similarity, setSimilarity] = useState('')
  const [size, setSize] = useState('')
  useEffect(() => {
    if (!saved) return
    // Solo le chiavi delle funzioni: l'oggetto di Apollo porta anche `__typename`, che l'input GraphQL rifiuta.
    setFeatures(Object.fromEntries(AI_FEATURE_KEYS.map((k) => [k, saved.features[k]])) as Record<AIFeatureKey, boolean>); setSimilarity(String(saved.clusterMinSimilarity)); setSize(String(saved.clusterMinSize))
  }, [saved])
  const [save, { loading: saving }] = useMutation(SET_AI_SETTINGS, {
    refetchQueries: [GET_AI_SETTINGS],
    onCompleted: () => toast.success(t('pages.organization.aiSaved')),
  })

  const sim = Number(similarity)
  const sz = Number(size)
  const simOk = Number.isFinite(sim) && sim >= 0.5 && sim <= 0.99
  const sizeOk = Number.isInteger(sz) && sz >= 2 && sz <= 20
  const dirty = !!saved && !!features && (
    AI_FEATURE_KEYS.some((k) => features[k] !== saved.features[k]) || sim !== saved.clusterMinSimilarity || sz !== saved.clusterMinSize)

  return (
    <OrgSection title={t('pages.organization.aiTitle')} description={t('pages.organization.aiDescription')}
      loading={!data && loading} error={error && !data ? error : null} onRetry={() => void refetch()}>
      {saved && features && (
        <>
          {!saved.platformConfigured && <Hint tone="danger">{t('pages.organization.aiPlatformMissing')}</Hint>}
          <GroupLabel>{t('pages.organization.aiFeatures')}</GroupLabel>
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 720 }}>
            {AI_FEATURE_KEYS.map((k) => {
              const labelId = `ai-feature-${k}`
              return (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: '1px solid var(--color-border)' }}>
                  <Toggle checked={features[k]} onChange={(v) => setFeatures({ ...features, [k]: v })} label={t(`pages.organization.aiFeature.${k}`)} labelledBy={labelId} />
                  <div style={{ minWidth: 0 }}>
                    <div id={labelId} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{t(`pages.organization.aiFeature.${k}`)}</div>
                    <div style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t(`pages.organization.aiFeatureHelp.${k}`)}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <GroupLabel>{t('pages.organization.aiClusterGroup')}</GroupLabel>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
              {t('pages.organization.aiClusterSimilarity')}
              <Input type="number" min={0.5} max={0.99} step={0.01} value={similarity} onChange={(e) => setSimilarity(e.target.value)} style={{ width: 110 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
              {t('pages.organization.aiClusterSize')}
              <Input type="number" min={2} max={20} step={1} value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 110 }} />
            </label>
          </div>
          <Hint>{t('pages.organization.aiClusterHint')}</Hint>
          {(!simOk || !sizeOk) && <Hint tone="danger">{t(!simOk ? 'pages.organization.aiSimilarityInvalid' : 'pages.organization.aiSizeInvalid')}</Hint>}
          <div>
            <Button disabled={!dirty || !simOk || !sizeOk || saving}
              onClick={() => void save({ variables: { input: { features, clusterMinSimilarity: sim, clusterMinSize: sz } } })}>
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </OrgSection>
  )
}
