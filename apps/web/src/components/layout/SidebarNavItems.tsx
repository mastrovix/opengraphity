import { NavLink } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

// ── Colours (shared with Sidebar) ────────────────────────────────────────────
export const C = {
  bg:           '#3d4856',
  border:       '#4f5e70',
  textDefault:  '#e2e8f0',
  textSection:  '#94a3b8',
  textChevron:  '#94a3b8',
  hoverBg:      'rgba(255,255,255,0.08)',
  activeBg:     'rgba(255,255,255,0.08)',
  brand:        '#38bdf8',
}

// ── Style helpers ─────────────────────────────────────────────────────────────

export function navItemStyle(isActive: boolean, isCollapsed: boolean): React.CSSProperties {
  return {
    display:         'flex',
    alignItems:      'center',
    gap:             isCollapsed ? 0 : 10,
    justifyContent:  isCollapsed ? 'center' : 'flex-start',
    padding:         isCollapsed ? 0 : '7px 10px',
    width:           isCollapsed ? 40 : 'auto',
    height:          isCollapsed ? 40 : 'auto',
    margin:          isCollapsed ? '2px auto' : '1px 0',
    borderRadius:    6,
    textDecoration:  'none',
    fontWeight:      isActive ? 600 : 400,
    fontSize:        13,
    color:           isActive ? C.brand : C.textDefault,
    backgroundColor: isActive ? C.activeBg : 'transparent',
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
    transition:      'background 150ms, color 150ms',
    cursor:          'pointer',
    boxSizing:       'border-box' as const,
  }
}

export function subItemStyle(isActive: boolean): React.CSSProperties {
  return {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '5px 8px',
    borderRadius:   4,
    fontSize:       12,
    color:          isActive ? C.brand : C.textDefault,
    fontWeight:     isActive ? 600 : 400,
    textDecoration: 'none',
    cursor:         'pointer',
    marginBottom:   1,
  }
}

export function parentGroupStyle(isActive: boolean): React.CSSProperties {
  return {
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'space-between',
    padding:         '7px 10px',
    borderRadius:    6,
    cursor:          'pointer',
    backgroundColor: isActive ? C.activeBg : 'transparent',
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
    transition:      'background 150ms',
    margin:          '1px 0',
  }
}

export function hoverOn(e: React.MouseEvent, active: boolean) {
  if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg
}

export function hoverOff(e: React.MouseEvent, active: boolean) {
  if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
}

// ── NavItem component ─────────────────────────────────────────────────────────

interface NavItemProps {
  to:        string
  label:     string
  icon:      LucideIcon
  collapsed: boolean
  isActive:  boolean
  badge?:    number
}

export function NavItem({ to, label, icon: Icon, collapsed, isActive, badge = 0 }: NavItemProps) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      style={navItemStyle(isActive, collapsed)}
      onMouseEnter={(e) => hoverOn(e, isActive)}
      onMouseLeave={(e) => hoverOff(e, isActive)}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
      {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
      {!collapsed && badge > 0 && (
        <span
          aria-label={`${badge} notifiche`}
          style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, lineHeight: 1, padding: '2px 5px', borderRadius: 8, background: 'var(--danger)', color: '#fff' }}
        >
          {badge}
        </span>
      )}
    </NavLink>
  )
}
