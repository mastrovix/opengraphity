/**
 * Modifica di una sorgente di monitoraggio (admin): nome, attiva/disattiva,
 * per il connettore generic il mappatore visuale con anteprima (le regole
 * salvate vengono rilette da parseSourceConfig, mai mostrate come JSON), per
 * gli altri strumenti le regole facoltative (traduzione dei valori, risorsa
 * predefinita: PresetRules.tsx, rilette da parsePresetConfig), rigenerazione
 * del token con conferma (nuovo token visibile UNA volta).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Radar, KeyRound, Loader2, Save } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_MONITORING_SOURCE_SETTINGS } from '@/graphql/queries'
import { UPDATE_MONITORING_SOURCE, REGENERATE_SOURCE_TOKEN } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'
import type { MonitoringSource } from '@/types/events'
import { GenericMapper } from './GenericMapper'
import { PresetRulesEditor } from './PresetRules'
import { EMPTY_MAPPING, EMPTY_PRESET_RULES, RATE_LIMIT_MAX, RATE_LIMIT_MIN, buildPresetConfig, buildSourceConfig, isMappingComplete, isPresetRulesComplete, parsePresetConfig, parseRateLimit, parseSourceConfig, type GenericMapping, type PresetConnectorKind, type PresetRules, type SourceRateLimit } from './sourceConfig'
import { sourceEndpointUrl } from './configSnippets'
import { ToolBadge, SecretBox, hintStyle } from './monitoringShared'

export function EditSourcePage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()

  const { data, loading, error, refetch } = useQuery<{ monitoringSources: (MonitoringSource & SourceRateLimit)[] }>(GET_MONITORING_SOURCE_SETTINGS, { fetchPolicy: 'cache-and-network' })
  const source = data?.monitoringSources.find((s) => s.id === id) ?? null

  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  // Testo, non numero: un campo vuoto mentre si digita non deve diventare un limite.
  const [rateLimitText, setRateLimitText] = useState('')
  const rateLimit = parseRateLimit(rateLimitText)
  const [mapping, setMapping] = useState<GenericMapping>(EMPTY_MAPPING)
  const [presetRules, setPresetRules] = useState<PresetRules>(EMPTY_PRESET_RULES)
  const [payload, setPayload] = useState('')
  const [configError, setConfigError] = useState<string | null>(null)
  const [dropped, setDropped] = useState<string[]>([])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [initialisedFor, setInitialisedFor] = useState<string | null>(null)

  // Popola il form una volta per sorgente (il polling/refetch non deve sovrascrivere le modifiche in corso).
  useEffect(() => {
    if (!source || initialisedFor === source.id) return
    setName(source.name)
    setEnabled(source.enabled)
    setRateLimitText(String(source.rateLimitPerMinute))
    if (source.connectorKind === 'generic') {
      const parsed = parseSourceConfig(source)
      setMapping(parsed.mapping)
      setConfigError(parsed.error)
      setDropped(parsed.dropped)
    } else if (source.connectorKind) {
      const parsed = parsePresetConfig(source.connectorKind, source)
      setPresetRules(parsed.rules)
      setConfigError(parsed.error)
    }
    setInitialisedFor(source.id)
  }, [source, initialisedFor])

  const [updateSource, { loading: saving }] = useMutation(UPDATE_MONITORING_SOURCE)
  const [regenToken] = useMutation<{ regenerateWebhookToken: { id: string; token: string } }>(REGENERATE_SOURCE_TOKEN)

  const isGeneric = source?.connectorKind === 'generic'
  // Connettore preset (forma nota): null per generic e per i webhook senza connectorKind (trattati come generic dall'API).
  const presetKind: PresetConnectorKind | null = source?.connectorKind && source.connectorKind !== 'generic' ? source.connectorKind : null
  // Una configurazione che l'editor non sa rappresentare (configError) non si salva: si perderebbero regole in silenzio.
  const canSave = name.trim() !== '' && rateLimit !== null
    && (!isGeneric || isMappingComplete(mapping))
    && (!presetKind || (configError === null && isPresetRulesComplete(presetRules)))
  const endpoint = useMemo(() => (source ? sourceEndpointUrl(source.id) : ''), [source])

  async function handleSave() {
    if (!source || rateLimit === null) return
    const input: Record<string, unknown> = { name: name.trim(), enabled, rateLimitPerMinute: rateLimit }
    if (isGeneric) Object.assign(input, buildSourceConfig(mapping))
    if (presetKind) Object.assign(input, buildPresetConfig(presetKind, presetRules))
    try {
      await updateSource({ variables: { id: source.id, input } })
      toast.success(t('toast.monitoring.sourceUpdated'))
      void refetch()
      navigate('/monitoring/sources')
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  async function handleRegen() {
    if (!source) return
    const ok = await confirm({ title: t('monitoring.sources.regenTitle'), body: t('monitoring.sources.regenBody'), danger: true, confirmLabel: t('monitoring.sources.regenToken') })
    if (!ok) return
    try {
      const res = await regenToken({ variables: { id: source.id } })
      const token = res.data?.regenerateWebhookToken.token
      if (!token) throw new Error('regenerateWebhookToken: token mancante nella risposta')
      toast.success(t('toast.monitoring.tokenRegenerated'))
      setNewToken(token)
    } catch (e) { toast.error(t('toast.events.actionFailed', { error: errorMessage(e) })) }
  }

  if (loading && !data) return <PageLoader />
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (!source) {
    return (
      <PageContainer>
        <EmptyState icon={<Radar size={32} />} title={t('monitoring.edit.notFound')} action={<Button variant="secondary" onClick={() => navigate('/monitoring/sources')}>{t('monitoring.edit.back')}</Button>} />
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <Link to="/monitoring/sources" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, color: 'var(--text-muted)', textDecoration: 'none', fontSize: 'var(--font-size-card-title)' }}>
        <ArrowLeft size={14} aria-hidden="true" />{t('monitoring.edit.back')}
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('monitoring.edit.title')} — {source.name}</PageTitle>
        <Button icon={saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} disabled={!canSave || saving} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
      </div>

      <SectionCard title={t('detail.sections.information')} defaultOpen>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <div>
            <FieldLabel htmlFor="edit-source-name">{t('monitoring.wizard.nameLabel')}</FieldLabel>
            <Input id="edit-source-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <DetailField label={t('monitoring.edit.tool')} value={<ToolBadge kind={source.connectorKind} />} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={enabled} onChange={setEnabled} label={t('monitoring.edit.enabled')} />
            <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{t('monitoring.edit.enabled')}</span>
          </div>
          <DetailField label={t('monitoring.wizard.endpoint')} value={endpoint} mono />
          <div>
            <FieldLabel htmlFor="edit-source-rate-limit">{t('monitoring.wizard.rateLimitLabel')}</FieldLabel>
            <Input id="edit-source-rate-limit" type="number" inputMode="numeric" min={RATE_LIMIT_MIN} max={RATE_LIMIT_MAX} step={1} value={rateLimitText} onChange={(e) => setRateLimitText(e.target.value)} aria-invalid={rateLimit === null} required />
            <p style={{ ...hintStyle, marginTop: 4, ...(rateLimit === null ? { color: colors.danger } : {}) }}>
              {rateLimit === null ? t('monitoring.wizard.rateLimitInvalid', { min: RATE_LIMIT_MIN, max: RATE_LIMIT_MAX }) : t('monitoring.wizard.rateLimitHint', { min: RATE_LIMIT_MIN, max: RATE_LIMIT_MAX })}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t('monitoring.edit.tokenTitle')} defaultOpen>
        <p style={hintStyle}>{t('monitoring.edit.tokenHint')}</p>
        {newToken
          ? <SecretBox label={t('monitoring.wizard.token')} value={newToken} copyLabel={t('monitoring.wizard.copyToken')} hint={t('monitoring.sources.newTokenBody')} />
          : <div><Button variant="secondary" size="xs" icon={<KeyRound size={13} aria-hidden="true" />} onClick={() => void handleRegen()}>{t('monitoring.sources.regenToken')}</Button></div>}
      </SectionCard>

      {isGeneric && (
        <SectionCard title={t('monitoring.edit.mappingTitle')} defaultOpen>
          {configError && <p role="alert" style={{ ...hintStyle, color: colors.danger }}>{t('monitoring.mapper.keysError', { error: configError })}</p>}
          {dropped.length > 0 && <p style={{ ...hintStyle, color: '#b45309' }}>{t('monitoring.edit.droppedFields', { fields: dropped.join(', ') })}</p>}
          <GenericMapper mapping={mapping} onChange={setMapping} payload={payload} onPayloadChange={setPayload} />
        </SectionCard>
      )}

      {presetKind && (
        <SectionCard title={t('monitoring.edit.presetRulesTitle')} defaultOpen>
          {configError && <p role="alert" style={{ ...hintStyle, color: colors.danger }}>{t('monitoring.edit.presetConfigError', { error: configError })}</p>}
          <PresetRulesEditor kind={presetKind} rules={presetRules} onChange={setPresetRules} />
        </SectionCard>
      )}
    </PageContainer>
  )
}
