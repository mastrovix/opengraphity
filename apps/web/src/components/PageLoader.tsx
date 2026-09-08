import { useTranslation } from 'react-i18next'

/** Fallback shown while a lazy route chunk downloads or a route guard resolves. */
export function PageLoader() {
  const { t } = useTranslation()
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
      {t('common.loading')}
    </div>
  )
}
