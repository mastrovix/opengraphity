/**
 * Filterable timeline view of the change audit trail.
 * Local state: category filter, expanded long entries, "show all" toggle.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import type { ChangeAuditEntryData } from '@/types/change'
import { formatDateShort } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'

type AuditCategory = 'status' | 'assessment' | 'assignments' | 'comments' | 'system'
const AUDIT_CAT_COLOR: Record<AuditCategory, string> = {
  status: 'var(--color-success)', assessment: colors.brand,
  assignments: palette.purple.base, comments: 'var(--color-slate)',
  system: 'var(--color-slate-light)',
}
/** Le categorie come CHIAVI: la frase la risolve chi la mostra. */
const AUDIT_CAT_KEY: Record<AuditCategory, string> = {
  status: 'pages.auditTimeline.cat.status', assessment: 'pages.auditTimeline.cat.assessment',
  assignments: 'pages.auditTimeline.cat.assignments',
  comments: 'pages.auditTimeline.cat.comments', system: 'pages.auditTimeline.cat.system',
}

/**
 * Il dettaglio di una voce: la frase della chiave nella lingua di chi guarda
 * (CH-5), o il testo salvato per le voci scritte prima delle chiavi.
 */
function detailText(t: (key: string, opts?: Record<string, unknown>) => string, e: ChangeAuditEntryData): string {
  if (!e.detailKey) return e.detail ?? ''
  let params: Record<string, unknown> = {}
  try { params = e.detailParams ? JSON.parse(e.detailParams) as Record<string, unknown> : {} } catch { params = {} }
  return t(`changeAudit.${e.detailKey}`, { ...params, defaultValue: e.detail ?? '' })
}

function categorizeAction(action: string): AuditCategory {
  const a = action.toLowerCase()
  if (a.includes('phase') || a.includes('approv') || a.includes('reject') || a.includes('auto_approv') || a.includes('closed') || a.includes('advanced_to')) return 'status'
  if (a.includes('assessment') || a.includes('response') || a.includes('risk') || a.includes('deploy_plan')) return 'assessment'
  if (a.includes('assign') || a.includes('team')) return 'assignments'
  if (a.includes('comment')) return 'comments'
  return 'system'
}

export function AuditTimeline({ audit }: { audit: ChangeAuditEntryData[] }) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<AuditCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set())
  const filtered = filter === 'all' ? audit : audit.filter(e => categorizeAction(e.action) === filter)
  const visible = showAll ? filtered : filtered.slice(0, 20)
  const fmtTS = formatDateShort

  return (
    <SectionCard title={t('pages.auditTimeline.title')} collapsible defaultOpen={false} count={audit.length}>
      <div style={{ marginBottom: 12 }}>
        <select value={filter} onChange={(e) => { setFilter(e.target.value as AuditCategory | 'all'); setShowAll(false) }} style={{ padding: '5px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 'var(--font-size-body)' }}>
          <option value="all">{t('common.all')} ({audit.length})</option>
          {(Object.keys(AUDIT_CAT_KEY) as AuditCategory[]).map(cat => {
            const n = audit.filter(e => categorizeAction(e.action) === cat).length
            return n > 0 ? <option key={cat} value={cat}>{t(AUDIT_CAT_KEY[cat])} ({n})</option> : null
          })}
        </select>
      </div>
      {filtered.length === 0 && <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>{t('pages.auditTimeline.empty')}</p>}
      <div>
        {visible.map((e, i) => {
          const cat = categorizeAction(e.action); const color = AUDIT_CAT_COLOR[cat]
          const isLong = (e.detail ?? '').length > 120; const isExp = expandedIdx.has(i)
          const isLast = i === visible.length - 1
          return (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              <div style={{ width: 20, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: color, border: '2px solid var(--color-white)', boxShadow: '0 0 0 1px var(--color-border)', flexShrink: 0, zIndex: 1 }} />
                {!isLast && <div style={{ width: 2, flex: 1, backgroundColor: colors.border }} />}
              </div>
              <div style={{ flex: 1, paddingBottom: 10 }}>
                <div style={{ padding: '6px 10px', background: 'var(--color-slate-bg)', borderRadius: 6, border: '1px solid var(--color-border-light)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{fmtTS(e.timestamp)}</span>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 5px', borderRadius: 4, backgroundColor: `${color}15`, color }}>{e.action.replace(/_/g, ' ')}</span>
                    {e.actor && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{e.actor.name}</span>}
                  </div>
                  {e.detail && <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', ...(isLong && !isExp ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{detailText(t, e)}</div>}
                  {isLong && <button type="button" onClick={() => setExpandedIdx(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', marginTop: 2 }}>{t(isExp ? 'common.showLess' : 'common.showAll')}</button>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {filtered.length > 20 && !showAll && <button type="button" onClick={() => setShowAll(true)} style={{ marginTop: 6, background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-brand)' }}>{t('common.showAllCount', { count: filtered.length })}</button>}
    </SectionCard>
  )
}
