/**
 * Underline tabs (E-10 / E-14): `role="tablist"` / `role="tab"`, arrow-key
 * navigation, `aria-selected`. Content switching stays in the page (the
 * component only owns the strip), so pages can keep their own `tab === …`.
 */
import type { KeyboardEvent, ReactNode } from 'react'

export interface TabItem<K extends string> {
  key:    K
  label:  ReactNode
  badge?: number
}

interface TabsProps<K extends string> {
  items:     readonly TabItem<K>[]
  value:     K
  onChange:  (key: K) => void
  /** Accessible name of the tab list. */
  ariaLabel: string
}

export function Tabs<K extends string>({ items, value, onChange, ariaLabel }: TabsProps<K>) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (idx + 1) % items.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next === null) return
    e.preventDefault()
    const item = items[next]!
    onChange(item.key)
    const el = (e.currentTarget.parentElement?.querySelector(`[data-tab-key="${item.key}"]`) as HTMLButtonElement | null)
    el?.focus()
  }

  return (
    <div role="tablist" aria-label={ariaLabel} style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
      {items.map((item, idx) => {
        const selected = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            data-tab-key={item.key}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 18px', border: 'none', background: 'none', cursor: 'pointer',
              marginBottom: -1,
              borderBottom: selected ? '2px solid var(--color-brand)' : '2px solid transparent',
              fontSize: 'var(--font-size-body)', fontWeight: selected ? 600 : 500,
              color: selected ? 'var(--color-brand)' : 'var(--color-slate)',
            }}
          >
            {item.label}
            {item.badge !== undefined && item.badge > 0 && (
              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: 'var(--color-slate-bg)', color: 'var(--color-slate)' }}>
                {item.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
