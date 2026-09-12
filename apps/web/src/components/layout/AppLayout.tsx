import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { ConfigurationIssuesBanner } from '@/components/ConfigurationIssuesBanner'
import { useTranslation } from 'react-i18next'
import { keycloak } from '../../lib/keycloak'
import { ConfirmProvider } from '@/hooks/useConfirm'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { colors } from '@/lib/tokens'

const SIDEBAR_WIDTH     = 240
const SIDEBAR_COLLAPSED = 56

export function AppLayout() {
  const { t } = useTranslation()
  // Hooks must run unconditionally, before any early return
  const [collapsed, setCollapsed] = useState(false)

  if (!keycloak.authenticated) {
    keycloak.login()
    return null
  }

  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH

  return (
    <ConfirmProvider>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: 'var(--color-slate-bg)' }}>
        {/* Skip to main content — visibile solo su focus */}
        <a
          href="#main-content"
          className="skip-link"
          style={{
            position:        'absolute',
            top:             '-40px',
            left:            '16px',
            zIndex:          9999,
            padding:         '8px 16px',
            backgroundColor: colors.slateDark,
            color:           colors.white,
            textDecoration:  'none',
            borderRadius:    '4px',
            fontSize:        '14px',
            transition:      'top 0.2s',
          }}
          onFocus={(e) => { e.currentTarget.style.top = '16px' }}
          onBlur={(e) => { e.currentTarget.style.top = '-40px' }}
        >
          {t('layout.skipToContent')}
        </a>
        <Sidebar
          collapsed={collapsed}
          width={sidebarWidth}
          onToggle={() => setCollapsed((c) => !c)}
        />

        <div
          style={{
            marginLeft:     sidebarWidth,
            flex:           1,
            display:        'flex',
            flexDirection:  'column',
            height:         '100vh',
            overflow:       'hidden',
            transition:     'margin-left 200ms ease',
            minWidth:       0,
          }}
        >
          <Topbar />
          {/* Revisione delle otto ondate · A·#3: lo schema degradato, le
              matrici incomplete e i buchi di configurazione avevano metrica,
              log e intestazione HTTP — e l'amministratore del tenant, l'unico
              che può rimediare, vedeva solo pagine che non funzionano. */}
          <ConfigurationIssuesBanner />
          <main
            id="main-content"
            style={{
              flex:            1,
              overflowY:       'auto',
              padding:         0,
              backgroundColor: 'var(--color-slate-bg)',
            }}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </ConfirmProvider>
  )
}
