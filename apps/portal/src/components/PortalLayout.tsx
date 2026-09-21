import { useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router-dom'
import { PortalHeader } from './PortalHeader'
import { GET_ME } from '@/graphql/queries'
import { usePortalLanguage } from '@/hooks/usePortalLanguage'
import { colors } from '@/lib/tokens'

interface MeData {
  me: { id: string; name: string; email: string; role: string; permissions: string[] } | null
}

export function PortalLayout() {
  const { t, i18n } = useTranslation()
  // La lingua del cliente, come nel web: qui e la sola che decide.
  usePortalLanguage()
  // Il titolo della scheda nella lingua attiva: era «Portale IT» scritto
  // nell'HTML anche con l'interfaccia inglese (giro del 14 set 2026).
  useEffect(() => { document.title = t('portal.documentTitle') }, [t, i18n.resolvedLanguage])
  const { data }   = useQuery<MeData>(GET_ME)
  const userName   = data?.me?.name ?? data?.me?.email ?? '—'
  // Ondata 7: il portale si apre col permesso `portal.read` del ruolo.
  const noAccess   = !!data?.me && !data.me.permissions.includes('portal.read')
  const year       = new Date().getFullYear()

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: colors.white }}>
      <PortalHeader userName={userName} />

      {/* Page content — below fixed header */}
      <main style={{
        flex:      1,
        marginTop: 60,
        padding:   '32px 24px',
      }}>
        <div style={{ maxWidth: 1024, margin: '0 auto' }}>
          {noAccess ? (
            <div role="alert" style={{ padding: '48px 0', textAlign: 'center' }}>
              <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.slateDark, marginBottom: 8 }}>{t('portal.noAccessTitle')}</h1>
              <p style={{ color: colors.slate, margin: 0 }}>{t('portal.noAccessBody')}</p>
            </div>
          ) : <Outlet />}
        </div>
      </main>

      <footer style={{
        borderTop:   `1px solid ${colors.border}`,
        padding:     '16px 24px',
        textAlign:   'center',
        fontSize:    12,
        color:       colors.slateLight,
      }}>
        {t('portal.poweredBy')} · © {year}
      </footer>
    </div>
  )
}
