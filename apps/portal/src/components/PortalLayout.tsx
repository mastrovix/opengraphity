import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router-dom'
import { PortalHeader } from './PortalHeader'
import { GET_ME } from '@/graphql/queries'

interface MeData {
  me: { id: string; name: string; email: string; role: string } | null
}

export function PortalLayout() {
  const { t }      = useTranslation()
  const { data }   = useQuery<MeData>(GET_ME)
  const userName   = data?.me?.name ?? data?.me?.email ?? '—'
  const year       = new Date().getFullYear()

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#fff' }}>
      <PortalHeader userName={userName} />

      {/* Page content — below fixed header */}
      <main style={{
        flex:      1,
        marginTop: 60,
        padding:   '32px 24px',
      }}>
        <div style={{ maxWidth: 1024, margin: '0 auto' }}>
          <Outlet />
        </div>
      </main>

      <footer style={{
        borderTop:   '1px solid #E2E8F0',
        padding:     '16px 24px',
        textAlign:   'center',
        fontSize:    12,
        color:       '#94A3B8',
      }}>
        {t('portal.poweredBy')} · © {year}
      </footer>
    </div>
  )
}
