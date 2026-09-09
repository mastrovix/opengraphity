/**
 * Procedura guidata "Aggiungi sorgente" (admin), 4 passi:
 *   1. Strumento  — Alertmanager / Grafana / Zabbix / Datadog / Dynatrace / Altro strumento
 *   2. Nome e regole — nome; SOLO per generic il mappatore visuale con anteprima
 *   3. Collegamento — crea la sorgente e mostra UNA VOLTA URL, token e un
 *      frammento di configurazione pronto per lo strumento
 *   4. Prova — invia un evento di prova attraverso la pipeline reale
 * Nessun JSON è visibile: i tre JSON del connettore generic li compone
 * buildSourceConfig (sourceConfig.ts).
 */
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Check, Loader2, Send, Radar } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { CREATE_MONITORING_SOURCE, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'
import { CONNECTOR_KINDS, type ConnectorKind } from '@/types/events'
import { GenericMapper } from './GenericMapper'
import { EMPTY_MAPPING, buildSourceConfig, isMappingComplete, type GenericMapping } from './sourceConfig'
import { configSnippet, sourceEndpointUrl, ZABBIX_FIELDS } from './configSnippets'
import { TOOL_META, SecretBox, SnippetBox, hintStyle, sectionTitleStyle } from './monitoringShared'

const STEPS = ['tool', 'rules', 'connect', 'test'] as const
type Step = (typeof STEPS)[number]

interface CreatedSource { id: string; name: string; token: string }

export function NewSourceWizard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [stepIdx, setStepIdx] = useState(0)
  const [kind, setKind] = useState<ConnectorKind | null>(null)
  const [name, setName] = useState('')
  const [mapping, setMapping] = useState<GenericMapping>(EMPTY_MAPPING)
  const [payload, setPayload] = useState('')
  const [created, setCreated] = useState<CreatedSource | null>(null)
  const [sampleCount, setSampleCount] = useState<number | null>(null)

  const [createSource, { loading: creating }] = useMutation<{ createInboundWebhook: CreatedSource }>(CREATE_MONITORING_SOURCE)
  const [sendSample, { loading: sending }] = useMutation<{ sendSampleEvent: number }>(SEND_SAMPLE_EVENT)

  const step: Step = STEPS[stepIdx]!
  const isGeneric = kind === 'generic'
  const toolName = kind ? t(`monitoring.tools.${kind}.name`) : ''

  /** Perché non si può andare avanti (null = si può). */
  const blocker: string | null =
    step === 'tool'  && !kind ? t('monitoring.wizard.toolRequired')
    : step === 'rules' && !name.trim() ? t('monitoring.wizard.nameRequired')
    : step === 'rules' && isGeneric && !isMappingComplete(mapping) ? t('monitoring.wizard.mappingIncomplete')
    : null

  async function handleCreate() {
    if (!kind) return
    const config = isGeneric ? buildSourceConfig(mapping) : { fieldMapping: '{}' }
    try {
      const res = await createSource({ variables: { input: { name: name.trim(), entityType: 'event', connectorKind: kind, ...config } } })
      const src = res.data?.createInboundWebhook
      if (!src?.token) throw new Error('createInboundWebhook: token mancante nella risposta')
      setCreated(src)
      toast.success(t('toast.monitoring.sourceCreated'))
      setStepIdx(2)
    } catch (e) {
      toast.error(t('monitoring.wizard.createFailed', { error: errorMessage(e) }))
    }
  }

  async function handleSample() {
    if (!created) return
    try {
      const res = await sendSample({ variables: { sourceId: created.id } })
      const n = res.data?.sendSampleEvent
      if (typeof n !== 'number') throw new Error('sendSampleEvent: risposta vuota')
      setSampleCount(n)
      toast.success(t('toast.monitoring.sampleSent'))
    } catch (e) {
      toast.error(t('toast.monitoring.sampleFailed', { error: errorMessage(e) }))
    }
  }

  const next = () => {
    if (step === 'rules') { void handleCreate(); return }
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  }
  const prev = () => setStepIdx((i) => Math.max(i - 1, 0))

  return (
    <PageContainer>
      <Link to="/monitoring/sources" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, color: 'var(--text-muted)', textDecoration: 'none', fontSize: 'var(--font-size-card-title)' }}>
        <ArrowLeft size={14} aria-hidden="true" />{t('monitoring.wizard.back')}
      </Link>
      <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('monitoring.wizard.title')}</PageTitle>

      <WizardProgress current={stepIdx} />

      <section aria-labelledby="wizard-step-title" style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10, padding: 20, marginTop: 16 }}>
        <h2 id="wizard-step-title" style={{ ...sectionTitleStyle, fontSize: 'var(--font-size-section-title)', marginBottom: 12 }}>
          {t('monitoring.wizard.stepOf', { step: stepIdx + 1, total: STEPS.length })} · {t(`monitoring.wizard.steps.${step}`)}
        </h2>

        {step === 'tool' && (
          <>
            <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)', marginBottom: 12 }}>{t('monitoring.wizard.toolIntro')}</p>
            <ToolPicker value={kind} onChange={(k) => { setKind(k); if (k !== 'generic') { setMapping(EMPTY_MAPPING); setPayload('') } }} />
          </>
        )}

        {step === 'rules' && kind && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ maxWidth: 420 }}>
              <FieldLabel htmlFor="source-name">{t('monitoring.wizard.nameLabel')}</FieldLabel>
              <Input id="source-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('monitoring.wizard.namePlaceholder')} required />
              <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.wizard.nameHint')}</p>
            </div>
            {isGeneric
              ? <GenericMapper mapping={mapping} onChange={setMapping} payload={payload} onPayloadChange={setPayload} />
              : <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)', padding: '10px 12px', background: 'var(--color-brand-light)', borderRadius: 8, color: '#0369a1' }}>{t('monitoring.wizard.knownToolHint', { tool: toolName })}</p>}
          </div>
        )}

        {step === 'connect' && kind && created && (
          <ConnectStep kind={kind} created={created} payload={payload} />
        )}

        {step === 'test' && created && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
            <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)' }}>{t('monitoring.wizard.testIntro')}</p>
            <div>
              <Button icon={sending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} disabled={sending} onClick={() => void handleSample()}>
                {t('monitoring.wizard.sendSample')}
              </Button>
            </div>
            {sampleCount !== null && (
              <p role="status" style={{ margin: 0, padding: '10px 12px', background: '#dcfce7', color: '#15803d', borderRadius: 8, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Check size={14} aria-hidden="true" />
                {t('monitoring.wizard.sampleSent', { count: sampleCount })}
                <Link to={`/events?sourceId=${created.id}`} style={{ color: '#15803d', fontWeight: 600 }}>{t('monitoring.wizard.openConsole')}</Link>
              </p>
            )}
          </div>
        )}

        {/* Navigazione */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
          <div>
            {stepIdx > 0 && stepIdx < 2 && <Button variant="secondary" onClick={prev}>{t('common.prev')}</Button>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {blocker && <span style={{ ...hintStyle, color: '#b45309' }}>{blocker}</span>}
            {step === 'test'
              ? <Button onClick={() => navigate('/monitoring/sources')}>{t('monitoring.wizard.finish')}</Button>
              : (
                <Button onClick={next} disabled={blocker !== null || creating} icon={creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined}>
                  {step === 'rules' ? (creating ? t('monitoring.wizard.creating') : t('monitoring.wizard.create')) : t('common.next')}
                </Button>
              )}
          </div>
        </div>
      </section>
    </PageContainer>
  )
}

// ── Barra di avanzamento ─────────────────────────────────────────────────────

function WizardProgress({ current }: { current: number }) {
  const { t } = useTranslation()
  return (
    <ol aria-label={t('monitoring.wizard.progress')} style={{ display: 'flex', gap: 8, listStyle: 'none', margin: '16px 0 0', padding: 0 }}>
      {STEPS.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s} aria-current={active ? 'step' : undefined} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: active ? colors.brand : done ? '#15803d' : colors.slateLight, fontWeight: active ? 600 : 400 }}>
            <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-table)', fontWeight: 700, background: active ? colors.brand : done ? '#dcfce7' : 'var(--color-slate-bg)', color: active ? '#fff' : done ? '#15803d' : colors.slate }}>
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>{t(`monitoring.wizard.steps.${s}`)}</span>
            <span aria-hidden="true" style={{ flex: 1, height: 2, background: done ? '#86efac' : colors.border, borderRadius: 1 }} />
          </li>
        )
      })}
    </ol>
  )
}

// ── Passo 1: schede degli strumenti ──────────────────────────────────────────

function ToolPicker({ value, onChange }: { value: ConnectorKind | null; onChange: (k: ConnectorKind) => void }) {
  const { t } = useTranslation()
  return (
    <div role="group" aria-label={t('monitoring.wizard.toolGroup')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
      {CONNECTOR_KINDS.map((k) => {
        const meta = TOOL_META[k]
        const Icon = meta.icon
        const selected = value === k
        return (
          <button
            key={k}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(k)}
            style={{
              textAlign: 'left', cursor: 'pointer', font: 'inherit', borderRadius: 10, padding: 14,
              border: selected ? `2px solid ${colors.brand}` : `1px solid ${colors.border}`,
              background: selected ? 'var(--color-brand-light)' : '#fff',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: colors.slateDark }}>
              <Icon size={18} color={meta.color} aria-hidden="true" />
              {t(`monitoring.tools.${k}.name`)}
            </span>
            <span style={{ ...hintStyle }}>{t(`monitoring.tools.${k}.description`)}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Passo 3: URL, token, frammento pronto ────────────────────────────────────

function ConnectStep({ kind, created, payload }: { kind: ConnectorKind; created: CreatedSource; payload: string }) {
  const { t } = useTranslation()
  const url = sourceEndpointUrl(created.id)
  const snippet = configSnippet(kind, url, created.token, payload)
  const toolName = t(`monitoring.tools.${kind}.name`)

  const instructions: ReactNode = (() => {
    switch (kind) {
      case 'alertmanager': return <p style={hintStyle}>{t('monitoring.snippets.alertmanager.intro')}</p>
      case 'grafana': return <Steps keys={['monitoring.snippets.grafana.step1', 'monitoring.snippets.grafana.step2', 'monitoring.snippets.grafana.step3', 'monitoring.snippets.grafana.step4']} />
      case 'zabbix': return (
        <>
          <Steps keys={['monitoring.snippets.zabbix.step1', 'monitoring.snippets.zabbix.step2', 'monitoring.snippets.zabbix.step3']} />
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20, fontSize: 'var(--font-size-body)', color: colors.slateDark, columns: 2 }}>
            {ZABBIX_FIELDS.map(([f, m]) => <li key={f}><code>{f}</code> ← <code>{m}</code></li>)}
          </ul>
          <Steps keys={['monitoring.snippets.zabbix.step4']} start={4} />
        </>
      )
      case 'datadog': return <Steps keys={['monitoring.snippets.datadog.step1', 'monitoring.snippets.datadog.step2', 'monitoring.snippets.datadog.step3']} />
      case 'dynatrace': return <Steps keys={['monitoring.snippets.dynatrace.step1', 'monitoring.snippets.dynatrace.step2', 'monitoring.snippets.dynatrace.step3', 'monitoring.snippets.dynatrace.step4']} />
      case 'generic': return <p style={hintStyle}>{t('monitoring.snippets.generic.intro')}</p>
    }
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
      <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)' }}>{t('monitoring.wizard.connectIntro', { name: created.name, tool: toolName })}</p>
      <SecretBox label={t('monitoring.wizard.endpoint')} value={url} copyLabel={t('monitoring.wizard.copyEndpoint')} />
      <SecretBox label={t('monitoring.wizard.token')} value={created.token} copyLabel={t('monitoring.wizard.copyToken')} hint={t('monitoring.wizard.tokenOnce')} />
      <div>
        <h3 style={sectionTitleStyle}>{t('monitoring.wizard.snippetTitle', { tool: toolName })}</h3>
        {instructions}
      </div>
      <SnippetBox title={toolName} text={snippet} copyLabel={t('monitoring.wizard.copySnippet')} />
    </div>
  )
}

/** Elenco numerato di istruzioni; `keys` sono chiavi i18n complete (verificate da check-i18n tramite i letterali). */
function Steps({ keys, start = 1 }: { keys: string[]; start?: number }) {
  const { t } = useTranslation()
  return (
    <ol start={start} style={{ margin: '4px 0', paddingLeft: 20, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.6 }}>
      {keys.map((k) => <li key={k}>{t(k)}</li>)}
    </ol>
  )
}
