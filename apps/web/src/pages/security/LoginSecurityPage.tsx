/**
 * ACCESSO E PASSWORD (ondata 8 di «Nulla cablato»): le regole delle password
 * e il login con l'account aziendale, scritti nel realm Keycloak
 * dell'organizzazione. Prima si cambiavano solo nella console di Keycloak.
 *
 * Scelte del proprietario: chi entra da Microsoft/Google/SAML ma non esiste in
 * OpenGrafo è rifiutato; le password restano accanto al login aziendale.
 * Un provider si attiva solo dopo una prova superata, e il segreto — che non
 * si legge mai — va riscritto per attivarlo.
 */
import { useEffect, useId, useState } from 'react'
import { PASSWORD_RULE_RANGES } from '@opengraphity/types'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, FlaskConical, KeyRound, Power, Save, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { FieldLabel, Input } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { Pill } from '@/components/ui/Pill'
import { OrgSection, Hint, GroupLabel } from '@/pages/settings/organization/shared'
import { GET_LOGIN_SETTINGS } from '@/graphql/queries'
import { DEACTIVATE_LOGIN_PROVIDER, REMOVE_LOGIN_PROVIDER, SAVE_LOGIN_PROVIDER, SET_PASSWORD_RULES, TEST_LOGIN_PROVIDER } from '@/graphql/mutations'
import { useConfirm } from '@/hooks/useConfirm'
import { showError } from '@/lib/showError'
import { colors } from '@/lib/tokens'

export interface PasswordRules {
  minLength: number; uppercase: number; lowercase: number; digits: number; special: number
  notUsername: boolean; notEmail: boolean; history: number; expireDays: number
  lockoutEnabled: boolean; lockoutFailures: number; lockoutMinutes: number
}
type ProviderKind = 'microsoft' | 'google' | 'saml'
interface Provider {
  kind: ProviderKind; displayName: string; enabled: boolean; clientId: string | null; tenant: string | null
  hostedDomain: string | null; metadataUrl: string | null; redirectUri: string; samlSpMetadataUrl: string | null
}
interface Check { key: string; ok: boolean; detail: string | null }
/** The addresses to register at the provider: one per origin through which people reach the sign-in page. */
interface Addresses { kind: ProviderKind; redirectUris: string[]; samlSpMetadataUrls: string[] }

const KINDS: readonly ProviderKind[] = ['microsoft', 'google', 'saml']

/** Una regola che il realm porta fuori dagli intervalli del prodotto (A-19). */
interface OutOfRange { rule: string; value: number; min: number; max: number }

/**
 * Gli intervalli vengono da @opengraphity/types, la stessa sorgente che l'API
 * usa per validarli (revisione totale · G-25): erano copiati a mano.
 */
export const RULE_RANGES: Record<Exclude<keyof PasswordRules, 'notUsername' | 'notEmail' | 'lockoutEnabled'>, readonly [number, number]> = PASSWORD_RULE_RANGES

/** Il motivo per cui le regole non si possono salvare (chiave i18n), o null. */
export function rulesProblem(r: PasswordRules): string | null {
  for (const [k, [min, max]] of Object.entries(RULE_RANGES)) {
    const v = r[k as keyof typeof RULE_RANGES]
    if (!Number.isInteger(v) || v < min || v > max) return 'pages.loginSecurity.rules.outOfRange'
  }
  if (r.uppercase + r.lowercase + r.digits + r.special > r.minLength) return 'pages.loginSecurity.rules.tooManyRequired'
  return null
}

const RULE_KEYS: readonly (keyof PasswordRules)[] = ['minLength', 'uppercase', 'lowercase', 'digits', 'special', 'notUsername', 'notEmail', 'history', 'expireDays', 'lockoutEnabled', 'lockoutFailures', 'lockoutMinutes']
function pickRules(r: PasswordRules): PasswordRules {
  return Object.fromEntries(RULE_KEYS.map((k) => [k, r[k]])) as unknown as PasswordRules
}

function NumberField({ id, label, hint, value, onChange, range }: { id: string; label: string; hint?: string; value: number; onChange: (n: number) => void; range: readonly [number, number] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" min={range[0]} max={range[1]} value={Number.isNaN(value) ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} style={{ width: 120 }} />
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}

function PasswordRulesSection({ saved, outOfRange, loading, error, onRetry }: { saved: PasswordRules | undefined; outOfRange: OutOfRange[]; loading: boolean; error: { message: string } | null; onRetry: () => void }) {
  const { t } = useTranslation()
  const uid = useId()
  const [draft, setDraft] = useState<PasswordRules | null>(null)
  // Solo i campi delle regole: la risposta porta anche `__typename`, che l'input rifiuterebbe.
  useEffect(() => { if (saved) setDraft(pickRules(saved)) }, [saved])
  const [save, { loading: saving }] = useMutation(SET_PASSWORD_RULES, { refetchQueries: [GET_LOGIN_SETTINGS] })
  const r = draft
  const set = (patch: Partial<PasswordRules>) => r && setDraft({ ...r, ...patch })
  const problem = r ? rulesProblem(r) : null
  const dirty = !!r && !!saved && JSON.stringify(r) !== JSON.stringify(pickRules(saved))
  const onSave = async () => {
    if (!r) return
    try { await save({ variables: { input: r } }); toast.success(t('pages.loginSecurity.rules.saved')) } catch (e) { showError(e) }
  }
  return (
    <OrgSection title={t('pages.loginSecurity.rules.title')} description={t('pages.loginSecurity.rules.description')} loading={loading} error={error} onRetry={onRetry}>
      {r && (
        <>
          <GroupLabel>{t('pages.loginSecurity.rules.composition')}</GroupLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            <NumberField id={`${uid}-len`} label={t('pages.loginSecurity.rules.minLength')} value={r.minLength} range={RULE_RANGES.minLength} onChange={(v) => set({ minLength: v })} />
            <NumberField id={`${uid}-up`} label={t('pages.loginSecurity.rules.uppercase')} value={r.uppercase} range={RULE_RANGES.uppercase} onChange={(v) => set({ uppercase: v })} />
            <NumberField id={`${uid}-low`} label={t('pages.loginSecurity.rules.lowercase')} value={r.lowercase} range={RULE_RANGES.lowercase} onChange={(v) => set({ lowercase: v })} />
            <NumberField id={`${uid}-dig`} label={t('pages.loginSecurity.rules.digits')} value={r.digits} range={RULE_RANGES.digits} onChange={(v) => set({ digits: v })} />
            <NumberField id={`${uid}-spe`} label={t('pages.loginSecurity.rules.special')} value={r.special} range={RULE_RANGES.special} onChange={(v) => set({ special: v })} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={r.notUsername} onChange={(v) => set({ notUsername: v })} label={t('pages.loginSecurity.rules.notUsername')} />
              <span style={{ fontSize: 'var(--font-size-body)' }}>{t('pages.loginSecurity.rules.notUsername')}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={r.notEmail} onChange={(v) => set({ notEmail: v })} label={t('pages.loginSecurity.rules.notEmail')} />
              <span style={{ fontSize: 'var(--font-size-body)' }}>{t('pages.loginSecurity.rules.notEmail')}</span>
            </label>
          </div>
          <GroupLabel>{t('pages.loginSecurity.rules.lifecycle')}</GroupLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            <NumberField id={`${uid}-hist`} label={t('pages.loginSecurity.rules.history')} hint={t('pages.loginSecurity.rules.zeroOff')} value={r.history} range={RULE_RANGES.history} onChange={(v) => set({ history: v })} />
            <NumberField id={`${uid}-exp`} label={t('pages.loginSecurity.rules.expireDays')} hint={t('pages.loginSecurity.rules.zeroNever')} value={r.expireDays} range={RULE_RANGES.expireDays} onChange={(v) => set({ expireDays: v })} />
          </div>
          <GroupLabel>{t('pages.loginSecurity.rules.lockout')}</GroupLabel>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={r.lockoutEnabled} onChange={(v) => set({ lockoutEnabled: v })} label={t('pages.loginSecurity.rules.lockoutEnabled')} />
            <span style={{ fontSize: 'var(--font-size-body)' }}>{t('pages.loginSecurity.rules.lockoutEnabled')}</span>
          </label>
          {r.lockoutEnabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
              <NumberField id={`${uid}-fail`} label={t('pages.loginSecurity.rules.lockoutFailures')} value={r.lockoutFailures} range={RULE_RANGES.lockoutFailures} onChange={(v) => set({ lockoutFailures: v })} />
              <NumberField id={`${uid}-wait`} label={t('pages.loginSecurity.rules.lockoutMinutes')} value={r.lockoutMinutes} range={RULE_RANGES.lockoutMinutes} onChange={(v) => set({ lockoutMinutes: v })} />
            </div>
          )}
          <Hint>{t('pages.loginSecurity.rules.lockoutTemporary')}</Hint>
          {/*
            A-19: il realm può portare un valore fuori dagli intervalli che
            questa pagina governa (configurato dalla console di Keycloak). Si
            dice quale e perché, invece di mostrarlo e poi rifiutare ogni
            salvataggio. Chi non lo tocca può salvare il resto.
          */}
          {outOfRange.map((o) => (
            <Hint key={o.rule} tone="warning">
              {t('pages.loginSecurity.rules.realmOutOfRange', {
                rule: t(`pages.loginSecurity.rules.${o.rule}`), value: o.value, min: o.min, max: o.max,
              })}
            </Hint>
          ))}
          {problem && dirty && <Hint tone="danger">{t(problem)}</Hint>}
          <div>
            <Button icon={<Save size={14} aria-hidden="true" />} disabled={!dirty || problem !== null || saving} onClick={() => void onSave()}>{t('common.save')}</Button>
          </div>
        </>
      )}
    </OrgSection>
  )
}

/** One address and its «Copy» button; the button is described by the address, so several read apart. */
function CopyValue({ value }: { value: string }) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <code id={id} style={{ flex: 1, padding: '6px 10px', background: 'var(--color-slate-bg)', borderRadius: 6, fontSize: 'var(--font-size-label)', wordBreak: 'break-all' }}>{value}</code>
      <Button variant="secondary" size="xs" icon={<Copy size={13} aria-hidden="true" />} aria-describedby={id} onClick={() => { void navigator.clipboard.writeText(value); toast.success(t('toast.integration.copied')) }}>
        {t('admin.integrations.copy')}
      </Button>
    </div>
  )
}

function CopyField({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FieldLabel>{label}</FieldLabel>
      {values.map((v) => <CopyValue key={v} value={v} />)}
    </div>
  )
}

/**
 * THE ADDRESSES TO REGISTER AT THE PROVIDER, ALL OF THEM (D71, tour of 23 Sep
 * 2026). There is one per origin through which people reach the sign-in page
 * (the local one, the Tailscale host, the public domain): the page showed
 * only the first — the localhost one, useless to register at Microsoft or
 * Google. When there are several, one line says to register every one.
 */
function ProviderAddresses({ addresses }: { addresses: Addresses }) {
  const { t } = useTranslation()
  const several = addresses.redirectUris.length > 1 || addresses.samlSpMetadataUrls.length > 1
  return (
    <>
      {several && <Hint>{t('pages.loginSecurity.providers.registerEveryAddress')}</Hint>}
      <CopyField label={t('pages.loginSecurity.providers.redirectUri')} values={addresses.redirectUris} />
      {addresses.samlSpMetadataUrls.length > 0 && <CopyField label={t('pages.loginSecurity.providers.spMetadata')} values={addresses.samlSpMetadataUrls} />}
    </>
  )
}

interface ProviderDraft { displayName: string; clientId: string; clientSecret: string; tenant: string; hostedDomain: string; metadataUrl: string }

function ProviderCard({ kind, provider, addresses }: { kind: ProviderKind; provider: Provider | undefined; addresses: Addresses | undefined }) {
  const { t } = useTranslation()
  const uid = useId()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<ProviderDraft>({ displayName: '', clientId: '', clientSecret: '', tenant: '', hostedDomain: '', metadataUrl: '' })
  const [checks, setChecks] = useState<Check[] | null>(null)
  useEffect(() => {
    setDraft({
      displayName: provider?.displayName ?? '', clientId: provider?.clientId ?? '', clientSecret: '',
      tenant: provider?.tenant ?? '', hostedDomain: provider?.hostedDomain ?? '', metadataUrl: provider?.metadataUrl ?? '',
    })
  }, [provider])
  const refetch = { refetchQueries: [GET_LOGIN_SETTINGS] }
  const [test, { loading: testing }] = useMutation<{ testLoginProvider: { ok: boolean; checks: Check[] } }>(TEST_LOGIN_PROVIDER)
  const [save, { loading: saving }] = useMutation(SAVE_LOGIN_PROVIDER, refetch)
  const [deactivate, { loading: deactivating }] = useMutation(DEACTIVATE_LOGIN_PROVIDER, refetch)
  const [remove, { loading: removing }] = useMutation(REMOVE_LOGIN_PROVIDER, refetch)
  const busy = testing || saving || deactivating || removing

  const input = () => ({
    kind,
    displayName: draft.displayName || null,
    clientId: kind === 'saml' ? null : draft.clientId || null,
    clientSecret: kind === 'saml' ? null : draft.clientSecret || null,
    tenant: kind === 'microsoft' ? draft.tenant || null : null,
    hostedDomain: kind === 'google' ? draft.hostedDomain || null : null,
    metadataUrl: kind === 'saml' ? draft.metadataUrl || null : null,
  })
  const complete = kind === 'saml' ? !!draft.metadataUrl.trim() : !!draft.clientId.trim() && !!draft.clientSecret.trim() && (kind !== 'microsoft' || !!draft.tenant.trim())

  const onTest = async () => {
    try { const res = await test({ variables: { input: input() } }); setChecks(res.data?.testLoginProvider.checks ?? null) } catch (e) { showError(e) }
  }
  const onSave = async (activate: boolean) => {
    try {
      await save({ variables: { input: input(), activate } })
      setChecks(null)
      toast.success(t(activate ? 'pages.loginSecurity.providers.activated' : 'pages.loginSecurity.providers.savedOff'))
    } catch (e) { showError(e) }
  }
  const onDeactivate = async () => {
    try { await deactivate({ variables: { kind } }); toast.success(t('pages.loginSecurity.providers.deactivated')) } catch (e) { showError(e) }
  }
  const onRemove = async () => {
    const ok = await confirm({ title: t('pages.loginSecurity.providers.removeTitle', { name: provider?.displayName ?? kind }), body: t('pages.loginSecurity.providers.removeBody'), danger: true, confirmLabel: t('common.delete') })
    if (!ok) return
    try { await remove({ variables: { kind } }); toast.success(t('pages.loginSecurity.providers.removed')) } catch (e) { showError(e) }
  }
  const field = (key: keyof ProviderDraft, label: string, opts: { type?: string; hint?: string; placeholder?: string } = {}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <FieldLabel htmlFor={`${uid}-${key}`}>{label}</FieldLabel>
      <Input id={`${uid}-${key}`} type={opts.type ?? 'text'} autoComplete="off" placeholder={opts.placeholder} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      {opts.hint && <Hint>{opts.hint}</Hint>}
    </div>
  )

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, background: 'var(--surface)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{t(`pages.loginSecurity.providers.kind.${kind}`)}</strong>
        {provider
          ? <Pill bg={provider.enabled ? 'var(--color-success-bg)' : 'var(--color-slate-bg)'} color={provider.enabled ? colors.success : colors.slate} radius={4}>{t(provider.enabled ? 'pages.loginSecurity.providers.on' : 'pages.loginSecurity.providers.off')}</Pill>
          : <Pill bg="var(--color-slate-bg)" color={colors.slate} radius={4}>{t('pages.loginSecurity.providers.notConfigured')}</Pill>}
      </div>
      <p style={{ margin: 0, fontSize: 'var(--font-size-label)', color: colors.slate, lineHeight: 1.5 }}>{t(`pages.loginSecurity.providers.help.${kind}`)}</p>
      {addresses && <ProviderAddresses addresses={addresses} />}
      {field('displayName', t('pages.loginSecurity.providers.displayName'), { placeholder: t(`pages.loginSecurity.providers.kind.${kind}`) })}
      {kind === 'microsoft' && field('tenant', t('pages.loginSecurity.providers.tenant'), { placeholder: 'acme.onmicrosoft.com' })}
      {kind !== 'saml' && field('clientId', t('pages.loginSecurity.providers.clientId'))}
      {kind !== 'saml' && field('clientSecret', t('pages.loginSecurity.providers.clientSecret'), { type: 'password', hint: t(provider ? 'pages.loginSecurity.providers.secretKept' : 'pages.loginSecurity.providers.secretRequired') })}
      {kind === 'google' && field('hostedDomain', t('pages.loginSecurity.providers.hostedDomain'), { placeholder: 'acme.com' })}
      {kind === 'saml' && field('metadataUrl', t('pages.loginSecurity.providers.metadataUrl'), { placeholder: 'https://idp.acme.com/metadata' })}

      {checks && (
        <ul aria-label={t('pages.loginSecurity.providers.testResult')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {checks.map((c) => (
            <li key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--font-size-body)' }}>
              {c.ok ? <CheckCircle2 size={16} color={colors.success} aria-hidden="true" /> : <XCircle size={16} color={colors.danger} aria-hidden="true" />}
              <span>{t(`pages.loginSecurity.providers.check.${c.key}`)}{c.detail ? ` — ${c.detail}` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" icon={<FlaskConical size={14} aria-hidden="true" />} disabled={busy || !complete} onClick={() => void onTest()}>{t('pages.loginSecurity.providers.test')}</Button>
        <Button size="sm" icon={<Power size={14} aria-hidden="true" />} disabled={busy || !complete} onClick={() => void onSave(true)}>{t('pages.loginSecurity.providers.testAndActivate')}</Button>
        {provider?.enabled && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onDeactivate()}>{t('pages.loginSecurity.providers.deactivate')}</Button>}
        {provider && <Button variant="danger" size="sm" icon={<Trash2 size={14} aria-hidden="true" />} disabled={busy} onClick={() => void onRemove()}>{t('common.delete')}</Button>}
      </div>
    </div>
  )
}

export function LoginSecurityPage() {
  const { t } = useTranslation()
  const { data, loading, error, refetch } = useQuery<{ loginSettings: { passwordRules: PasswordRules; passwordRulesOutOfRange: OutOfRange[]; providers: Provider[]; addresses: Addresses[] } }>(GET_LOGIN_SETTINGS, { fetchPolicy: 'cache-and-network' })
  const s = data?.loginSettings
  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <PageTitle icon={<ShieldCheck size={22} color="var(--color-icon-accent)" />}>{t('pages.loginSecurity.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '4px 0 0', maxWidth: '80ch' }}>{t('pages.loginSecurity.subtitle')}</p>
      </div>
      <PasswordRulesSection saved={s?.passwordRules} outOfRange={s?.passwordRulesOutOfRange ?? []} loading={!s && loading} error={error && !s ? error : null} onRetry={() => void refetch()} />
      <OrgSection title={t('pages.loginSecurity.providers.title')} description={t('pages.loginSecurity.providers.description')} loading={!s && loading} error={null}>
        {s && (
          <>
            <p role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, padding: '10px 14px', borderRadius: 8, background: 'var(--color-info-bg)', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
              <KeyRound size={16} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--color-brand)' }} />
              {t('pages.loginSecurity.providers.rules')}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
              {KINDS.map((kind) => <ProviderCard key={kind} kind={kind} provider={s.providers.find((p) => p.kind === kind)} addresses={s.addresses.find((a) => a.kind === kind)} />)}
            </div>
          </>
        )}
      </OrgSection>
    </PageContainer>
  )
}
