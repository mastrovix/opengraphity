/**
 * Personal profile page (`/profile`, every role): language, e-mail notifications + Slack link.
 * Replaces the two former "Profilo" pages (`/profile` language only,
 * `/settings/profile` Slack only) — E-13.
 */
import { Loading } from '@/components/ui/Loading'
import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import { UserCircle } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { QueryError } from '@/components/QueryError'
import { useMe } from '@/hooks/useMe'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
import { RoleBadge } from '@/components/ui/badges'
import { Toggle } from '@/components/ui/Toggle'
import { SET_MY_EMAIL_NOTIFICATIONS, SET_MY_LANGUAGE } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors, palette } from '@/lib/tokens'
import { scegliLinguaPersonale, usaLinguaDellOrganizzazione, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'

/** Valore della tendina per «usa la lingua dell'organizzazione». */
const ORGANIZATION = 'organization'

const LINK_SLACK = gql`
  mutation LinkSlack($slackId: String!) {
    linkSlackAccount(slackId: $slackId) { id slackId }
  }
`

/**
 * Scollegare è `slackId: null`, non la stringa vuota (revisione totale ·
 * F-20): con la stringa vuota il nodo restava con un id vuoto, uguale per
 * tutti gli «scollegati».
 */
const UNLINK_SLACK = gql`
  mutation UnlinkSlack {
    linkSlackAccount(slackId: null) { id slackId }
  }
`

const card: React.CSSProperties = {
  background:   colors.white,
  border:       '1px solid var(--border)',
  borderRadius: 10,
  padding:      '20px 24px',
  maxWidth:     520,
}
const sectionTitle: React.CSSProperties = {
  fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px',
}
const sectionDesc: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 12px', lineHeight: 1.5,
}
const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6,
}

export function ProfilePage() {
  const { t, i18n } = useTranslation()
  const { me, loading, error, refetch } = useMe()
  const { data: langData } = useQuery<{ tenantLanguageSettings: { defaultLanguage: string | null } }>(GET_TENANT_LANGUAGE_SETTINGS, { fetchPolicy: 'cache-first' })
  const orgLanguage = langData?.tenantLanguageSettings.defaultLanguage ?? null
  const [personal, setPersonal] = useState(linguaSceltaDallUtente)
  /*
    Secondo giro UI del 15 set 2026: la scelta stava solo in questo browser, e il
    portale (un'altra applicazione) non la vedeva. Ora si salva sulla persona e
    si applica qui solo dopo che il server l'ha presa.
  */
  const [saveLanguage] = useMutation(SET_MY_LANGUAGE, { refetchQueries: ['GetMe'] })
  const chooseLanguage = async (v: string) => {
    try {
      await saveLanguage({ variables: { language: v === ORGANIZATION ? null : v } })
    } catch (e) { showError(e); return }
    if (v === ORGANIZATION) { await usaLinguaDellOrganizzazione(orgLanguage); setPersonal(false) }
    else { await scegliLinguaPersonale(v); setPersonal(true) }
  }

  const [slackInput, setSlackInput] = useState('')

  const [linkSlack, { loading: linking }] = useMutationWithToast(LINK_SLACK, {
    successMessage: t('pages.profile.slackLinked'),
    onSuccess:      () => setSlackInput(''),
    refetch,
  })
  const [unlinkSlack, { loading: unlinking }] = useMutationWithToast(UNLINK_SLACK, {
    successMessage: t('pages.profile.slackUnlinked'),
    refetch,
  })

  const [setEmailNotifications, { loading: savingEmail }] = useMutationWithToast<{ setMyEmailNotifications: { emailNotifications: boolean | null } }>(SET_MY_EMAIL_NOTIFICATIONS, {
    successMessage: (d) => d.setMyEmailNotifications.emailNotifications ? t('pages.profile.emailNotificationsOn') : t('pages.profile.emailNotificationsOff'),
    refetch,
  })

  const slackId = me?.slackId ?? null

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<UserCircle size={22} color="var(--color-icon-accent)" />}>
          {t('pages.profile.title')}
        </PageTitle>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* ── Account ── */}
        <div style={card}>
          <h2 style={sectionTitle}>{t('pages.profile.account')}</h2>
          {error ? (
            <QueryError message={error.message} onRetry={() => void refetch()} />
          ) : loading && !me ? (
            <Loading />
          ) : me ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 'var(--font-size-body)', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.name')}</span>
              <span style={{ color: 'var(--color-slate-dark)', fontWeight: 500 }}>{me.name}</span>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.email')}</span>
              <span style={{ color: 'var(--color-slate-dark)' }}>{me.email}</span>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.role')}</span>
              <span><RoleBadge role={me.role} name={me.roleName} /></span>
            </div>
          ) : (
            <p style={sectionDesc}>{t('pages.profile.noAccount')}</p>
          )}
        </div>

        {/* ── Language ── */}
        <div style={card}>
          <h2 style={sectionTitle}>{t('pages.profile.language')}</h2>
          <p style={sectionDesc}>{t('pages.profile.languageDescription')}</p>
          {/*
            Giro nel browser del 14 set 2026 (#61): la scelta era sempre
            personale (una volta toccata, l'azienda non contava più) e non
            c'era modo di tornare alla lingua dell'organizzazione.
          */}
          <Select
            aria-label={t('pages.profile.language')}
            value={personal ? (i18n.language.startsWith('it') ? 'it' : 'en') : ORGANIZATION}
            onChange={(e) => {
              void chooseLanguage(e.target.value)
            }}
            style={{ cursor: 'pointer', minWidth: 160 }}
          >
            <option value={ORGANIZATION}>
              {t('pages.profile.organizationLanguage', { language: orgLanguage ? t(orgLanguage === 'it' ? 'pages.profile.italian' : 'pages.profile.english') : t('pages.profile.notConfigured') })}
            </option>
            <option value="en">{t('pages.profile.english')}</option>
            <option value="it">{t('pages.profile.italian')}</option>
          </Select>
        </div>

        {/* ── E-mail (revisione del 14 set 2026 · CO-1) ── */}
        {me && me.emailNotifications !== null && (
          <div style={card}>
            <h2 style={sectionTitle}>{t('pages.profile.emailNotificationsTitle')}</h2>
            <p style={sectionDesc}>{t('pages.profile.emailNotificationsDescription')}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle
                checked={me.emailNotifications}
                disabled={savingEmail}
                labelledBy="profile-email-notifications"
                label={t('pages.profile.emailNotificationsToggle')}
                onChange={(enabled) => { void setEmailNotifications({ variables: { enabled } }) }}
              />
              <span id="profile-email-notifications" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                {t('pages.profile.emailNotificationsToggle')}
              </span>
            </div>
          </div>
        )}

        {/* ── Slack ── */}
        <div style={card}>
          <h2 style={sectionTitle}>{t('pages.profile.slackTitle')}</h2>
          <p style={sectionDesc}>{t('pages.profile.slackDescription')}</p>

          {slackId ? (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                background: 'var(--color-success-bg)', border: `1px solid ${palette.success.border}`, borderRadius: 6, marginBottom: 12,
              }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: palette.success.text, fontWeight: 500 }}>
                  {t('pages.profile.slackLinkedAs')} <code>{slackId}</code>
                </span>
              </div>
              <Button variant="secondary" disabled={unlinking} onClick={() => unlinkSlack()}>
                {unlinking ? t('pages.profile.slackUnlinking') : t('pages.profile.slackUnlink')}
              </Button>
            </div>
          ) : (
            <div>
              <label htmlFor="profile-slack-id" style={label}>{t('pages.profile.slackUserId')}</label>
              <Input
                id="profile-slack-id"
                value={slackInput}
                onChange={(e) => setSlackInput(e.target.value)}
                placeholder="U0123456789"
                style={{ maxWidth: 320 }}
              />
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '5px 0 14px' }}>
                {t('pages.profile.slackHint')}
              </p>
              <Button
                disabled={linking || !slackInput.trim()}
                onClick={() => linkSlack({ variables: { slackId: slackInput.trim() } })}
              >
                {linking ? t('pages.profile.slackSaving') : t('common.save')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
