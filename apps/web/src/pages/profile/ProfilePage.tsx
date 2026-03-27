import { useTranslation } from 'react-i18next'
import { UserCircle } from 'lucide-react'

export function ProfilePage() {
  const { t, i18n } = useTranslation()

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <UserCircle size={22} color="var(--color-brand)" />
          {t('pages.profile.title')}
        </h1>
      </div>

      <div className="card-border" style={{ padding: '20px 24px', maxWidth: 480 }}>
        <div style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('pages.profile.language')}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--color-slate)', marginTop: 2, marginBottom: 12 }}>
          {t('pages.profile.languageDescription')}
        </p>
        <select
          value={i18n.language.startsWith('it') ? 'it' : 'en'}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #e5e7eb',
            fontSize: 14,
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
    </div>
  )
}
