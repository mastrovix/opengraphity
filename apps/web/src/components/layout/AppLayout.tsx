import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { ConfigurationIssuesBanner } from '@/components/ConfigurationIssuesBanner'
import { useTenantLanguage } from '@/hooks/useTenantLanguage'
import { useTranslation } from 'react-i18next'
import { keycloak } from '../../lib/keycloak'
import { ConfirmProvider } from '@/hooks/useConfirm'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { colors } from '@/lib/tokens'

const SIDEBAR_WIDTH     = 240
const SIDEBAR_COLLAPSED = 56
/**
 * Sotto questa larghezza la barra laterale parte chiusa e si chiude da sola
 * quando la finestra si stringe: a 683px occupava un terzo dello schermo e
 * spingeva fuori testata e pulsanti (giro nel browser del 14 set 2026, #28).
 * Riaprirla resta una scelta di chi usa l'app.
 */
const NARROW_QUERY = '(max-width: 900px)'

function isNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches
}

export function AppLayout() {
  const { t } = useTranslation()
  // Hooks must run unconditionally, before any early return
  const [collapsed, setCollapsed] = useState(isNarrow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setCollapsed(true) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  // In che lingua si legge questo cliente: e configurazione, sta nel grafo, e
  // vale per chi non ha scelto la propria dal Profilo.
  useTenantLanguage()

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
