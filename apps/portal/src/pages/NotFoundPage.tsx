import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

/** Catch-all route: an unknown URL gets a message and a way home, not a blank page. */
export function NotFoundPage() {
  const { t } = useTranslation()
  const { pathname } = useLocation()

  return (
    <div style={{ padding: '64px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 48, fontWeight: 700, color: '#CBD5E1', marginBottom: 8 }}>404</div>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>{t('notFound.title')}</h1>
      <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24 }}>
        {t('notFound.description', { path: pathname })}
      </p>
      <Link
        to="/"
        style={{ display: 'inline-block', padding: '10px 20px', backgroundColor: '#0EA5E9', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
      >
        {t('notFound.home')}
      </Link>
    </div>
  )
}
