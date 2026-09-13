import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncConflict } from './useSyncPage'
import { StatusBadge, btnStyle } from './syncShared'
import { colors, palette } from '../../lib/tokens'
import { formatDateTime } from '@/lib/datetime'

// ── Props ────────────────────────────────────────────────────────────────────

export interface SyncConflictsTabProps {
  conflicts: SyncConflict[]
  loading: boolean
  onResolveConflict: (conflictId: string, resolution: string) => Promise<void>
}

// ── Component ────────────────────────────────────────────────────────────────

export function SyncConflictsTab({ conflicts, loading, onResolveConflict }: SyncConflictsTabProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('open')

  const filtered = filter === 'all' ? conflicts : conflicts.filter(c => c.status === filter)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['open', 'resolved', 'all'].map(s => (
          <button type="button" key={s} onClick={() => setFilter(s)}
            style={{ padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', background: filter === s ? colors.brand : colors.white, color: filter === s ? colors.white : palette.neutral.textMuted }}>
            {s}
          </button>
        ))}
      </div>

      {loading && <div style={{ padding: 24, color: colors.slate }}>Loading...</div>}

      {!loading && (
        <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: colors.slate, fontSize: 'var(--font-size-body)' }}>
              {filter === 'open' ? 'No open conflicts' : 'No conflicts found'}
            </div>
          )}
          {filtered.map((c, i) => {
            const fields: string[] = JSON.parse(c.conflictFields || '[]')
            return (
              <div key={c.id} style={{ padding: '12px 16px', borderBottom: i < filtered.length - 1 ? `1px solid ${palette.neutral.borderLight}` : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{c.externalId}</span>
                      <span style={{ fontSize: 'var(--font-size-table)', background: 'var(--color-border-light)', padding: '2px 6px', borderRadius: 4 }}>{c.ciType}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: colors.slate, marginTop: 2 }}>
                      Locked fields: {fields.join(', ') || '—'} · {formatDateTime(c.createdAt)}
                    </div>
                    {c.resolution && (
                      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-success)', marginTop: 2 }}>{t('pages.sync.conflict.resolution', { resolution: c.resolution })}</div>
                    )}
                  </div>
                  {c.status === 'open' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" onClick={() => onResolveConflict(c.id, 'merged')}   style={btnStyle(colors.brand, colors.white)} title={t('pages.sync.conflict.mergeHint')}>{t('pages.sync.conflict.merge')}</button>
                      <button type="button" onClick={() => onResolveConflict(c.id, 'distinct')} style={btnStyle(colors.white, palette.neutral.textMuted)} title={t('pages.sync.conflict.distinctHint')}>{t('pages.sync.conflict.distinct')}</button>
                      <button type="button" onClick={() => onResolveConflict(c.id, 'linked')}   style={btnStyle(colors.white, palette.purple.base)} title={t('pages.sync.conflict.linkedHint')}>{t('pages.sync.conflict.linked')}</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
