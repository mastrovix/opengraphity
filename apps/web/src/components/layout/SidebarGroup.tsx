/**
 * Collapsible navigation group of the Sidebar (E-12): replaces six
 * copy-pasted blocks. The header is a real `<button aria-expanded>` (focusable,
 * Space/Enter toggle, state exposed to assistive tech); when the sidebar is
 * collapsed the group renders as a single icon link to `collapsedTo`.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { C, navItemStyle, parentGroupStyle } from './SidebarNavItems'

interface SidebarGroupProps {
  title:       string
  icon:        LucideIcon
  /** A route inside the group matches the current location. */
  active:      boolean
  open:        boolean
  onToggle:    () => void
  collapsed:   boolean
  /** Link target of the icon-only rendering (sidebar collapsed). */
  collapsedTo: string
  children:    ReactNode
}

export function SidebarGroup({ title, icon: Icon, active, open, onToggle, collapsed, collapsedTo, children }: SidebarGroupProps) {
  const panelId = useId()

  if (collapsed) {
    return (
      <NavLink to={collapsedTo} title={title} style={navItemStyle(active, true)} className="hover-bg">
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
      </NavLink>
    )
  }

  return (
    <div style={{ marginBottom: 2 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        style={parentGroupStyle(active)}
        className="hover-bg"
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          <span style={{ fontSize: 'var(--font-size-body)', fontWeight: active ? 600 : 400, color: active ? C.brand : C.textDefault }}>
            {title}
          </span>
        </span>
        {open
          ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
          : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
      </button>

      {open && (
        <div id={panelId} style={{ paddingLeft: 28, marginTop: 2 }}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Open state of a group: starts from `active` and re-opens whenever the
 * location enters the group (e.g. navigation via GlobalSearch into a section
 * whose group was closed). Closing by hand stays closed until the next entry.
 */
export function useGroupOpen(active: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(active)
  useEffect(() => { if (active) setOpen(true) }, [active])
  return [open, () => setOpen((p) => !p)]
}
