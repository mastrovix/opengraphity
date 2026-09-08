import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldOff } from 'lucide-react'
import { useMe, type UserRole } from '@/hooks/useMe'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'

interface Props {
  /** Roles allowed to render `children`; anything else gets the forbidden page. */
  roles:    readonly UserRole[]
  children: ReactNode
}

/**
 * Route guard driven by `me.role` (DB), the same source the pages use.
 *
 *   { path: 'admin/audit', element: <RequireRole roles={['admin']}><AuditLogPage /></RequireRole> }
 *
 * While `me` loads it shows the shared PageLoader; if the query fails it shows
 * QueryError (no silent fallback to "allowed"); if `me` is null or the role is
 * not in `roles` it shows an "access denied" page with a link home.
 */
export function RequireRole({ roles, children }: Props) {
  const { me, loading, error, refetch } = useMe()

  if (loading && !me) return <PageLoader />
  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }
  if (!me || !(roles as readonly string[]).includes(me.role)) return <Forbidden />

  return <>{children}</>
}

function Forbidden() {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12, textAlign: 'center', padding: 24 }}>
      <ShieldOff size={36} color="var(--color-danger, #ef4444)" aria-hidden="true" />
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
