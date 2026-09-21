import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePortalAccess } from '@/hooks/usePortalAccess'
import { colors } from '@/lib/tokens'

/**
 * La pagina «nuovo ticket» si apre col permesso `portal.submit` del ruolo
 * (ondata 7 di «Nulla cablato»). Senza, lo si dice invece di mostrare un modulo
 * che l'API rifiuterebbe all'invio.
 */
export function RequireSubmit({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { loading, canSubmit } = usePortalAccess()
  if (loading) return null
  if (canSubmit) return <>{children}</>
  return (
    <div role="alert" style={{ padding: '48px 0', textAlign: 'center' }}>
      <p style={{ color: colors.slate, marginBottom: 16 }}>{t('portal.noSubmit')}</p>
      <Link to="/" style={{ color: colors.brand, fontWeight: 500 }}>{t('notFound.home')}</Link>
    </div>
  )
}
