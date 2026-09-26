import { Loading } from '@/components/ui/Loading'
import { Chip } from '@/components/ui/Chip'
import { useTranslation } from 'react-i18next'
import type { SyncConflict } from './useSyncPage'
import { StatusBadge, btnStyle } from './syncShared'
import { colors, palette } from '../../lib/tokens'
import { formatDateTime } from '@/lib/datetime'

// ── Props ────────────────────────────────────────────────────────────────────

export interface SyncConflictsTabProps {
  /** G-21: quanti conflitti ci sono in tutto con questo filtro. */
  total:          number
  status:         'open' | 'resolved' | 'all'
  onStatusChange: (s: 'open' | 'resolved' | 'all') => void
  conflicts: SyncConflict[]
  loading: boolean
  onResolveConflict: (conflictId: string, resolution: string) => Promise<void>
}

// ── Component ────────────────────────────────────────────────────────────────

export function SyncConflictsTab({ conflicts, loading, onResolveConflict, total, status, onStatusChange }: SyncConflictsTabProps) {
  const { t } = useTranslation()
  /**
   * Il filtro lo applica il SERVER (revisione totale · G-21): era client-side
   * sui 50 conflitti più recenti, quindi «risolti» mostrava solo quelli finiti
   * dentro quei 50 e un tenant con 80 conflitti aperti ne vedeva 50 senza che
   * niente lo dicesse. Ora il conteggio totale è quello vero e, se la pagina
   * non li contiene tutti, lo scrive.
   */
  const filtered = conflicts

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['open', 'resolved', 'all'] as const).map(s => (
          <Chip pressed={status === s} key={s} onClick={() => onStatusChange(s)}>
            {t(`pages.sync.filter.${s}`)}
          </Chip>
        ))}
      </div>

      {/* G-18: era «Loading...» letterale. */}
      {loading && <Loading padded />}

      {!loading && total > filtered.length && (
        <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-table)', color: colors.slate }}>
          {t('pages.sync.conflictsShown', { shown: filtered.length, total })}
        </p>
      )}

      {!loading && (
        <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: colors.slate, fontSize: 'var(--font-size-body)' }}>
              {status === 'open' ? t('pages.sync.noOpenConflicts') : t('pages.sync.noConflicts')}
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
                      {t('pages.sync.lockedFields', { fields: fields.join(', ') || '—' })} · {formatDateTime(c.createdAt)}
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
