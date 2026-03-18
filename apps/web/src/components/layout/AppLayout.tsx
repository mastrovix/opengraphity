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
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: '#f8f9fc' }}>
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
          style={{
            flex:      1,
            overflowY: 'auto',
            padding:   24,
          }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
