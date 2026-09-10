import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { layoutPalette, colors } from '@/lib/tokens'

// ── Colours: ONE palette shared with Topbar / GlobalSearch (E-23) ────────────
export const C = layoutPalette

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
    backgroundColor: isActive ? C.activeBg : undefined,
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
    transition:      'background 150ms, color 150ms',
    cursor:          'pointer',
    boxSizing:       'border-box' as const,
    ['--hover-bg' as string]: C.hoverBg,
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
    width:           '100%',
    padding:         '7px 10px',
    borderRadius:    6,
    cursor:          'pointer',
    background:      isActive ? C.activeBg : 'none',
    border:          'none',
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
    transition:      'background 150ms',
    margin:          '1px 0',
    font:            'inherit',
    textAlign:       'left',
    boxSizing:       'border-box' as const,
    ['--hover-bg' as string]: C.hoverBg,
  }
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
  const { t } = useTranslation()
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className="hover-bg"
      style={navItemStyle(isActive, collapsed)}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
      {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
      {!collapsed && badge > 0 && (
        <span
          aria-label={t('sidebar.pendingBadge', { count: badge })}
          style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, lineHeight: 1, padding: '2px 5px', borderRadius: 8, background: 'var(--danger)', color: colors.white }}
        >
          {badge}
        </span>
      )}
    </NavLink>
  )
}

// ── Sub item (inside a collapsible group) ─────────────────────────────────────

interface SubItemProps {
  to:        string
  label:     string
  icon?:     LucideIcon
  /** Custom icon node (e.g. CIIcon) when a Lucide icon is not enough. */
  iconNode?: React.ReactNode
  end?:      boolean
  /** Explicit active flag (default: NavLink's own matching). */
  isActive?: boolean
  /** Extra node rendered at the right (badges). */
  trailing?: React.ReactNode
}

export function SubItem({ to, label, icon: Icon, iconNode, end, isActive, trailing }: SubItemProps) {
  return (
    <NavLink key={to} to={to} end={end} style={({ isActive: navActive }) => subItemStyle(isActive ?? navActive)}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {iconNode ?? (Icon && <Icon size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />)}
        {label}
      </span>
      {trailing}
    </NavLink>
  )
}
