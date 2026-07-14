import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { keycloak } from '../../lib/keycloak'
import { CommandPalette } from '@/components/CommandPalette'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

const SIDEBAR_WIDTH     = 240
const SIDEBAR_COLLAPSED = 56

export function AppLayout() {
  // Hooks must run unconditionally, before any early return
  const [collapsed, setCollapsed]     = useState(false)
  const [searchOpen, setSearchOpen]   = useState(false)

  // Global Cmd+K / Ctrl+K shortcut for the command palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!keycloak.authenticated) {
    keycloak.login()
    return null
  }

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
        <Topbar onOpenSearch={() => setSearchOpen(true)} />
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

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
