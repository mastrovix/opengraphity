import { useTranslation } from 'react-i18next'
import { UserCircle } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'

export function ProfilePage() {
  const { t, i18n } = useTranslation()

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<UserCircle size={22} color="#38bdf8" />}>
          {t('pages.profile.title')}
        </PageTitle>
      </div>

      <div className="card-border" style={{ padding: '20px 24px', maxWidth: 480 }}>
        <div style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('pages.profile.language')}
          </span>
        </div>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', marginTop: 2, marginBottom: 12 }}>
          {t('pages.profile.languageDescription')}
        </p>
        <select
          value={i18n.language.startsWith('it') ? 'it' : 'en'}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
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
    </PageContainer>
  )
}
