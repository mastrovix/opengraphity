import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, LogOut, User, Menu, X } from 'lucide-react'
import { keycloak } from '@/lib/keycloak'
import { colors, alpha } from '@/lib/tokens'

interface Props {
  userName: string
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0] ?? '').slice(0, 2).join('').toUpperCase() || '?'
}

const NAV_STYLE_BASE: React.CSSProperties = {
  padding:    '6px 14px',
  borderRadius: 20,
  fontSize:   14,
  fontWeight: 500,
  color:      colors.slate,
  transition: 'background 0.15s, color 0.15s',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}

export function PortalHeader({ userName }: Props) {
  const { t }                   = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  function logout() {
    keycloak.logout({ redirectUri: window.location.origin })
  }

  // The portal has no profile page of its own: identity (name, email,
  // password, sessions) is managed in the Keycloak account console.
  function openProfile() {
    setMenuOpen(false)
    void keycloak.accountManagement()
  }

  return (
    <header style={{
      position:        'fixed',
      top:             0,
      left:            0,
      right:           0,
      zIndex:          100,
      backgroundColor: colors.white,
      borderBottom:    `1px solid ${colors.border}`,
      height:          60,
    }}>
      <div style={{
        maxWidth:      1024,
        margin:        '0 auto',
        padding:       '0 24px',
        height:        '100%',
        display:       'flex',
        alignItems:    'center',
        justifyContent:'space-between',
        gap:           16,
      }}>
        {/* Logo */}
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <img src="/opengrafo-logo.svg" alt="OpenGrafo" style={{ height: 28 }} />
          <span style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark }}>
            {t('portal.title')}
          </span>
        </a>

        {/* Nav — desktop */}
        <nav style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center' }} className="portal-nav-desktop">
          {[
            { to: '/',        label: t('nav.home') },
            { to: '/tickets', label: t('nav.tickets') },
            { to: '/catalog', label: t('nav.catalog') },
            { to: '/kb',      label: t('nav.kb') },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                ...NAV_STYLE_BASE,
                backgroundColor: isActive ? colors.brandLight : 'transparent',
                color:           isActive ? colors.brand : colors.slate,
                borderBottom:    isActive ? `2px solid ${colors.brand}` : '2px solid transparent',
                borderRadius:    0,
                padding:         '4px 14px',
              })}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Right: avatar + mobile hamburger */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Avatar + dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          6,
                background:   'none',
                border:       `1px solid ${colors.border}`,
                borderRadius: 24,
                padding:      '4px 10px 4px 4px',
                cursor:       'pointer',
              }}
            >
              <div style={{
                width:           32,
                height:          32,
                borderRadius:    '50%',
                backgroundColor: colors.brand,
                color:           colors.white,
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'center',
                fontSize:        12,
                fontWeight:      700,
                flexShrink:      0,
              }}>
                {initials(userName)}
              </div>
              <span style={{ fontSize: 10, color: colors.slateDark, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {userName}
              </span>
              <ChevronDown size={14} style={{ color: colors.slateLight }} />
            </button>

            {menuOpen && (
              <div
                style={{
                  position:        'absolute',
                  top:             '100%',
                  right:           0,
                  marginTop:       6,
                  backgroundColor: colors.white,
                  border:          `1px solid ${colors.border}`,
                  borderRadius:    8,
                  boxShadow:       `0 4px 16px ${alpha.black12}`,
                  minWidth:        160,
                  zIndex:          200,
                  overflow:        'hidden',
                }}
              >
                <button
                  onClick={openProfile}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: colors.slateDark }}
                >
                  <User size={14} style={{ color: colors.slate }} />
                  {t('common.profile')}
                </button>
                <div style={{ height: 1, background: colors.border }} />
                <button
                  onClick={logout}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: colors.danger }}
                >
                  <LogOut size={14} />
                  {t('common.logout')}
                </button>
              </div>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(o => !o)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'none', padding: 4 }}
            className="portal-hamburger"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile nav overlay */}
      {mobileOpen && (
        <div style={{
          position:        'absolute',
          top:             60,
          left:            0,
          right:           0,
          backgroundColor: colors.white,
          borderBottom:    `1px solid ${colors.border}`,
          padding:         '12px 24px',
          display:         'flex',
          flexDirection:   'column',
          gap:             4,
        }}>
          {[
            { to: '/',        label: t('nav.home') },
            { to: '/tickets', label: t('nav.tickets') },
            { to: '/catalog', label: t('nav.catalog') },
            { to: '/kb',      label: t('nav.kb') },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobileOpen(false)}
              style={({ isActive }) => ({
                padding:         '10px 14px',
                borderRadius:    8,
                fontSize:        15,
                fontWeight:      500,
                color:           isActive ? colors.brand : colors.slateDark,
                backgroundColor: isActive ? colors.brandLight : 'transparent',
              })}
            >
              {label}
            </NavLink>
          ))}
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          .portal-nav-desktop { display: none !important; }
          .portal-hamburger   { display: block !important; }
        }
      `}</style>
    </header>
  )
}
