import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { keycloak } from '../../lib/keycloak'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

const SIDEBAR_WIDTH     = 240
const SIDEBAR_COLLAPSED = 56

export function AppLayout() {
  if (!keycloak.authenticated) {
    keycloak.login()
    return null
  }

  const [collapsed, setCollapsed] = useState(false)
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: '#f1f5f9' }}>
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
          backgroundColor: '#1a2332',
          color:           '#fff',
          textDecoration:  'none',
          borderRadius:    '4px',
          fontSize:        '14px',
          transition:      'top 0.2s',
        }}
        onFocus={(e) => { e.currentTarget.style.top = '16px' }}
        onBlur={(e) => { e.currentTarget.style.top = '-40px' }}
      >
        Salta al contenuto
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
        <main
          id="main-content"
          style={{
            flex:            1,
            overflowY:       'auto',
            padding:         24,
            backgroundColor: '#f8fafc',
          }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
