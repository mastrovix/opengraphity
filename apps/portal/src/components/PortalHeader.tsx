import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, LogOut, User, Menu, X } from 'lucide-react'
import { keycloak } from '@/lib/keycloak'

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
  color:      '#64748B',
  transition: 'background 0.15s, color 0.15s',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}

export function PortalHeader({ userName }: Props) {
  const { t }                   = useTranslation()
  const navigate                = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  function logout() {
    keycloak.logout({ redirectUri: window.location.origin })
  }

  return (
    <header style={{
      position:        'fixed',
      top:             0,
      left:            0,
      right:           0,
      zIndex:          100,
      backgroundColor: '#fff',
      borderBottom:    '1px solid #E2E8F0',
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
          <span style={{ fontSize: 10, fontWeight: 600, color: '#0F172A' }}>
            {t('portal.title')}
          </span>
        </a>

        {/* Nav — desktop */}
        <nav style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center' }} className="portal-nav-desktop">
          {[
            { to: '/',        label: t('nav.home') },
            { to: '/tickets', label: t('nav.tickets') },
            { to: '/kb',      label: t('nav.kb') },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                ...NAV_STYLE_BASE,
                backgroundColor: isActive ? '#F0F9FF' : 'transparent',
                color:           isActive ? '#0EA5E9' : '#64748B',
                borderBottom:    isActive ? '2px solid #0EA5E9' : '2px solid transparent',
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
                border:       '1px solid #E2E8F0',
                borderRadius: 24,
                padding:      '4px 10px 4px 4px',
                cursor:       'pointer',
              }}
            >
              <div style={{
                width:           32,
                height:          32,
                borderRadius:    '50%',
                backgroundColor: '#0EA5E9',
                color:           '#fff',
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'center',
                fontSize:        12,
                fontWeight:      700,
                flexShrink:      0,
              }}>
                {initials(userName)}
              </div>
              <span style={{ fontSize: 10, color: '#0F172A', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {userName}
              </span>
              <ChevronDown size={14} style={{ color: '#94A3B8' }} />
            </button>

            {menuOpen && (
              <div
                style={{
                  position:        'absolute',
                  top:             '100%',
                  right:           0,
                  marginTop:       6,
                  backgroundColor: '#fff',
                  border:          '1px solid #E2E8F0',
                  borderRadius:    8,
                  boxShadow:       '0 4px 16px rgba(0,0,0,0.12)',
                  minWidth:        160,
                  zIndex:          200,
                  overflow:        'hidden',
                }}
              >
                <button
                  onClick={() => { setMenuOpen(false); navigate('/profile') }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#0F172A' }}
                >
                  <User size={14} style={{ color: '#64748B' }} />
                  {t('common.profile')}
                </button>
                <div style={{ height: 1, background: '#E2E8F0' }} />
                <button
                  onClick={logout}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#EF4444' }}
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
          backgroundColor: '#fff',
          borderBottom:    '1px solid #E2E8F0',
          padding:         '12px 24px',
          display:         'flex',
          flexDirection:   'column',
          gap:             4,
        }}>
          {[
            { to: '/',        label: t('nav.home') },
            { to: '/tickets', label: t('nav.tickets') },
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
                color:           isActive ? '#0EA5E9' : '#0F172A',
                backgroundColor: isActive ? '#F0F9FF' : 'transparent',
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
