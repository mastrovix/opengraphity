import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldOff } from 'lucide-react'
import type { Permission } from '@opengraphity/types'
import { useMe } from '@/hooks/useMe'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { colors } from '@/lib/tokens'

interface Props {
  /** The page opens with AT LEAST ONE of these permissions; otherwise the forbidden page. */
  anyOf:    readonly Permission[]
  children: ReactNode
}

/**
 * Route guard driven by the permissions of `me.role` (DB), the same source the
 * pages use (wave 7 of «Nulla cablato»; it was a list of role names).
 *
 * While `me` loads it shows the shared PageLoader; if the query fails it shows
 * QueryError (no silent fallback to "allowed"); if `me` is null or the role
 * lacks every permission it shows an "access denied" page with a link home.
 */
export function RequirePermission({ anyOf, children }: Props) {
  const { me, can, loading, error, refetch } = useMe()

  if (loading && !me) return <PageLoader />
  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }
  if (!me || !can(...anyOf)) return <Forbidden />

  return <>{children}</>
}

function Forbidden() {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12, textAlign: 'center', padding: 24 }}>
      <ShieldOff size={36} color={colors.danger} aria-hidden="true" />
      <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
        {t('auth.forbiddenTitle')}
      </h1>
      <p style={{ color: 'var(--color-slate-light)', margin: 0, maxWidth: 480 }}>
        {t('auth.forbiddenBody')}
      </p>
      <Link to="/dashboard" style={{ color: 'var(--color-brand)', textDecoration: 'none', fontSize: 'var(--font-size-body)' }}>
        {t('auth.backHome')}
      </Link>
    </div>
  )
}
