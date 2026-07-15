/**
 * Bulk actions bar — shown above a selectable table when at least one row is
 * selected. Renders the selection count, the action buttons passed as
 * children, and a ghost "clear selection" button.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'

interface BulkActionsBarProps {
  /** Number of selected rows. The bar renders nothing when 0. */
  count: number
  /** Clears the selection. */
  onClear: () => void
  /** Action buttons (e.g. design-system <Button>s). */
  children?: ReactNode
}

export function BulkActionsBar({ count, onClear, children }: BulkActionsBarProps) {
  const { t } = useTranslation()

  if (count === 0) return null

  return (
    <div
      role="toolbar"
      aria-label={t('bulk.selected', { count })}
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            8,
        padding:        '8px 12px',
        marginBottom:   8,
        background:     'var(--color-brand-light)',
        border:         '1px solid var(--color-brand-a20)',
        borderRadius:   8,
      }}
    >
      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', marginRight: 4 }}>
        {t('bulk.selected', { count })}
      </span>

      {children}

      <Button
        variant="ghost"
        size="xs"
        onClick={onClear}
        style={{ marginLeft: 'auto', color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', textDecoration: 'underline' }}
      >
        {t('bulk.clear')}
      </Button>
    </div>
  )
}
