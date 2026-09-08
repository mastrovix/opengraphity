/**
 * Personal profile page (`/profile`, every role): language + Slack link.
 * Replaces the two former "Profilo" pages (`/profile` language only,
 * `/settings/profile` Slack only) — E-13.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { gql } from '@apollo/client'
import { UserCircle } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { QueryError } from '@/components/QueryError'
import { useMe } from '@/hooks/useMe'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
import { RoleBadge } from '@/components/ui/badges'

const LINK_SLACK = gql`
  mutation LinkSlack($slackId: String!) {
    linkSlackAccount(slackId: $slackId) { id slackId }
  }
`

const UNLINK_SLACK = gql`
  mutation UnlinkSlack {
    linkSlackAccount(slackId: "") { id slackId }
  }
`

const card: React.CSSProperties = {
  background:   '#fff',
  border:       '1px solid #e5e7eb',
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
            <p style={sectionDesc}>{t('common.loading')}</p>
          ) : me ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 'var(--font-size-body)', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.name')}</span>
              <span style={{ color: 'var(--color-slate-dark)', fontWeight: 500 }}>{me.name}</span>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.email')}</span>
              <span style={{ color: 'var(--color-slate-dark)' }}>{me.email}</span>
              <span style={{ color: 'var(--color-slate)' }}>{t('pages.users.role')}</span>
              <span><RoleBadge role={me.role} /></span>
            </div>
          ) : (
            <p style={sectionDesc}>{t('pages.profile.noAccount')}</p>
          )}
        </div>

        {/* ── Language ── */}
        <div style={card}>
          <h2 style={sectionTitle}>{t('pages.profile.language')}</h2>
          <p style={sectionDesc}>{t('pages.profile.languageDescription')}</p>
          <select
            value={i18n.language.startsWith('it') ? 'it' : 'en'}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #e5e7eb',
              fontSize: 'var(--font-size-card-title)',
              color: 'var(--color-slate-dark)',
              background: '#fff',
              cursor: 'pointer',
              minWidth: 160,
            }}
          >
            <option value="en">{t('pages.profile.english')}</option>
            <option value="it">{t('pages.profile.italian')}</option>
          </select>
        </div>

        {/* ── Slack ── */}
        <div style={card}>
          <h2 style={sectionTitle}>{t('pages.profile.slackTitle')}</h2>
          <p style={sectionDesc}>{t('pages.profile.slackDescription')}</p>

          {slackId ? (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                background: 'var(--color-success-bg)', border: '1px solid #bbf7d0', borderRadius: 6, marginBottom: 12,
              }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: '#15803d', fontWeight: 500 }}>
                  {t('pages.profile.slackLinkedAs')} <code>{slackId}</code>
                </span>
              </div>
              <Button variant="secondary" disabled={unlinking} onClick={() => void unlinkSlack()}>
                {unlinking ? t('pages.profile.slackUnlinking') : t('pages.profile.slackUnlink')}
              </Button>
            </div>
          ) : (
            <div>
              <label style={label}>{t('pages.profile.slackUserId')}</label>
              <Input
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
                onClick={() => void linkSlack({ variables: { slackId: slackInput.trim() } })}
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
