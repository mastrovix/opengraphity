/**
 * SLACK DELL'ORGANIZZAZIONE (ondata 8 di «Nulla cablato»), nella pagina
 * Integrazioni. Due modi, scelta del proprietario:
 *  - «Aggiungi a Slack»: l'app OpenGrafo, un clic e l'approvazione in Slack;
 *  - token: l'app Slack dell'organizzazione, di cui l'admin incolla token e
 *    segreto di firma (provati prima di salvarli).
 * I segreti non tornano mai indietro: la pagina mostra solo il workspace.
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, Link2Off, Plug, Slack } from 'lucide-react'
import { toast } from 'sonner'
import { SectionCard } from '@/components/ui/SectionCard'
import { Button } from '@/components/Button'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { QueryError } from '@/components/QueryError'
import { GET_SLACK_SETTINGS } from '@/graphql/queries'
import { CONNECT_SLACK_WITH_TOKEN, DISCONNECT_SLACK, START_SLACK_INSTALL } from '@/graphql/mutations'
import { useConfirm } from '@/hooks/useConfirm'
import { showError } from '@/lib/showError'
import { formatDateTime } from '@/lib/datetime'
import { colors } from '@/lib/tokens'

interface SlackSettings {
  installation: { mode: 'app' | 'token'; teamId: string; teamName: string; installedAt: string; installedByName: string | null } | null
  appInstallAvailable: boolean
  secretsConfigured: boolean
  requestUrls: { commands: string; actions: string; oauthCallback: string } | null
}

function UrlRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ flex: 1, padding: '6px 10px', background: 'var(--color-slate-bg)', borderRadius: 6, fontSize: 'var(--font-size-body)', wordBreak: 'break-all' }}>{value}</code>
        <Button variant="secondary" size="xs" icon={<Copy size={13} aria-hidden="true" />}
          onClick={() => { void navigator.clipboard.writeText(value); toast.success(t('toast.integration.copied')) }}>
          {t('admin.integrations.copy')}
        </Button>
      </div>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  return (
    <p role={tone === 'warning' ? 'alert' : 'status'} style={{
      margin: 0, padding: '10px 14px', borderRadius: 8, fontSize: 'var(--font-size-body)', lineHeight: 1.5, color: 'var(--color-slate-dark)',
      background: tone === 'warning' ? 'var(--color-warning-bg)' : 'var(--color-info-bg)',
    }}>{children}</p>
  )
}

export function SlackSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const { data, loading, error, refetch } = useQuery<{ slackSettings: SlackSettings }>(GET_SLACK_SETTINGS, { fetchPolicy: 'cache-and-network' })
  const [startInstall, { loading: starting }] = useMutation<{ startSlackInstall: string }>(START_SLACK_INSTALL)
  const [connectWithToken, { loading: connecting }] = useMutation(CONNECT_SLACK_WITH_TOKEN, { refetchQueries: [GET_SLACK_SETTINGS] })
  const [disconnect, { loading: disconnecting }] = useMutation(DISCONNECT_SLACK, { refetchQueries: [GET_SLACK_SETTINGS] })
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')

  // Ritorno da Slack dopo «Aggiungi a Slack»: si dice com'è andata e si pulisce l'indirizzo.
  useEffect(() => {
    const outcome = params.get('slack')
    if (!outcome) return
    if (outcome === 'connected') toast.success(t('admin.integrations.slack.connected'))
    else toast.error(t('admin.integrations.slack.installFailed', { reason: t(params.get('reason') ?? '', { defaultValue: params.get('reason') ?? '' }) }))
    const next = new URLSearchParams(params)
    next.delete('slack'); next.delete('reason')
    setParams(next, { replace: true })
    void refetch()
  }, [params, setParams, t, refetch])

  const s = data?.slackSettings
  const onInstall = async () => {
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}?tab=slack`
      const res = await startInstall({ variables: { returnTo } })
      if (res.data) window.location.assign(res.data.startSlackInstall)
    } catch (e) { showError(e) }
  }
  const onConnect = async () => {
    try {
      await connectWithToken({ variables: { botToken, signingSecret } })
      setBotToken(''); setSigningSecret('')
      toast.success(t('admin.integrations.slack.connected'))
    } catch (e) { showError(e) }
  }
  const onDisconnect = async () => {
    const ok = await confirm({ title: t('admin.integrations.slack.disconnectTitle', { team: s?.installation?.teamName ?? '' }), body: t('admin.integrations.slack.disconnectBody'), danger: true, confirmLabel: t('admin.integrations.slack.disconnect') })
    if (!ok) return
    try { await disconnect(); toast.success(t('admin.integrations.slack.disconnected')) } catch (e) { showError(e) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', maxWidth: '80ch', lineHeight: 1.55 }}>
        {t('admin.integrations.slack.intro')}
      </p>
      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {loading && !s && <p style={{ margin: 0 }}>{t('common.loading')}</p>}
      {s && !s.requestUrls && <Notice tone="warning">{t('admin.integrations.slack.noPublicUrl')}</Notice>}
      {s && !s.secretsConfigured && <Notice tone="warning">{t('admin.integrations.slack.noSecretsKey')}</Notice>}

      {s?.installation && (
        <SectionCard collapsible={false} title={t('admin.integrations.slack.connectedTitle')}>
          <div style={{ padding: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <CheckCircle2 size={22} color={colors.success} aria-hidden="true" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 240 }}>
              <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{s.installation.teamName}</strong>
              <span style={{ fontSize: 'var(--font-size-label)', color: colors.slate }}>
                {t(s.installation.mode === 'app' ? 'admin.integrations.slack.modeApp' : 'admin.integrations.slack.modeToken')}
                {' · '}{t('admin.integrations.slack.installedBy', { who: s.installation.installedByName ?? '—', date: formatDateTime(s.installation.installedAt) })}
              </span>
            </div>
            <Button variant="danger" size="sm" disabled={disconnecting} icon={<Link2Off size={14} aria-hidden="true" />} onClick={() => void onDisconnect()}>
              {t('admin.integrations.slack.disconnect')}
            </Button>
          </div>
        </SectionCard>
      )}

      {s && !s.installation && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
          <SectionCard collapsible={false} title={t('admin.integrations.slack.appTitle')}>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.5 }}>{t('admin.integrations.slack.appBody')}</p>
              {s.appInstallAvailable
                ? <div><Button icon={<Slack size={14} aria-hidden="true" />} disabled={starting} onClick={() => void onInstall()}>{t('admin.integrations.slack.addToSlack')}</Button></div>
                : <Notice tone="info">{t('admin.integrations.slack.appUnavailable')}</Notice>}
            </div>
          </SectionCard>
          <SectionCard collapsible={false} title={t('admin.integrations.slack.tokenTitle')}>
            <form style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={(e) => { e.preventDefault(); void onConnect() }}>
              <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.5 }}>{t('admin.integrations.slack.tokenBody')}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <FieldLabel htmlFor="slack-bot-token">{t('admin.integrations.slack.botToken')}</FieldLabel>
                <Input id="slack-bot-token" type="password" autoComplete="off" placeholder="xoxb-…" value={botToken} onChange={(e) => setBotToken(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <FieldLabel htmlFor="slack-signing-secret">{t('admin.integrations.slack.signingSecret')}</FieldLabel>
                <Input id="slack-signing-secret" type="password" autoComplete="off" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} />
              </div>
              <div>
                <Button type="submit" icon={<Plug size={14} aria-hidden="true" />} disabled={connecting || !botToken.trim() || !signingSecret.trim() || !s.secretsConfigured}>
                  {t('admin.integrations.slack.testAndConnect')}
                </Button>
              </div>
            </form>
          </SectionCard>
        </div>
      )}

      {s?.requestUrls && (
        <SectionCard collapsible={false} title={t('admin.integrations.slack.urlsTitle')}>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.5 }}>{t('admin.integrations.slack.urlsBody')}</p>
            <UrlRow label={t('admin.integrations.slack.commandsUrl')} value={s.requestUrls.commands} />
            <UrlRow label={t('admin.integrations.slack.actionsUrl')} value={s.requestUrls.actions} />
          </div>
        </SectionCard>
      )}
    </div>
  )
}
