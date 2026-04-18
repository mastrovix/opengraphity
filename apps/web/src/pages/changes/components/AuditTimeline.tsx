/**
 * Filterable timeline view of the change audit trail.
 * Local state: category filter, expanded long entries, "show all" toggle.
 */
import { useState } from 'react'
import { SectionCard } from '@/components/ui/SectionCard'
import type { ChangeAuditEntryData } from '@/types/change'

type AuditCategory = 'stato' | 'assessment' | 'assegnazioni' | 'commenti' | 'sistema'
const AUDIT_CAT_COLOR: Record<AuditCategory, string> = {
  stato: 'var(--color-success)', assessment: '#2563eb',
  assegnazioni: '#7c3aed', commenti: 'var(--color-slate)',
  sistema: 'var(--color-slate-light)',
}
const AUDIT_CAT_LABEL: Record<AuditCategory, string> = {
  stato: 'Stato', assessment: 'Assessment', assegnazioni: 'Assegnazioni',
  commenti: 'Commenti', sistema: 'Sistema',
}

function categorizeAction(action: string): AuditCategory {
  const a = action.toLowerCase()
  if (a.includes('phase') || a.includes('approv') || a.includes('reject') || a.includes('auto_approv') || a.includes('closed') || a.includes('advanced_to')) return 'stato'
  if (a.includes('assessment') || a.includes('response') || a.includes('risk') || a.includes('deploy_plan')) return 'assessment'
  if (a.includes('assign') || a.includes('team')) return 'assegnazioni'
  if (a.includes('comment')) return 'commenti'
  return 'sistema'
}

export function AuditTimeline({ audit }: { audit: ChangeAuditEntryData[] }) {
  const [filter, setFilter] = useState<AuditCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set())
  const filtered = filter === 'all' ? audit : audit.filter(e => categorizeAction(e.action) === filter)
  const visible = showAll ? filtered : filtered.slice(0, 20)
  const fmtTS = (iso: string) => {
    try {
      const d = new Date(iso)
      const p = (n: number) => String(n).padStart(2, '0')
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch { return iso }
  }

  return (
    <SectionCard title="Audit Trail" collapsible defaultOpen={false} count={audit.length}>
      <div style={{ marginBottom: 12 }}>
        <select value={filter} onChange={(e) => { setFilter(e.target.value as AuditCategory | 'all'); setShowAll(false) }} style={{ padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)' }}>
          <option value="all">Tutti ({audit.length})</option>
          {(Object.keys(AUDIT_CAT_LABEL) as AuditCategory[]).map(cat => {
            const n = audit.filter(e => categorizeAction(e.action) === cat).length
            return n > 0 ? <option key={cat} value={cat}>{AUDIT_CAT_LABEL[cat]} ({n})</option> : null
          })}
        </select>
      </div>
      {filtered.length === 0 && <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>Nessun evento</p>}
      <div>
        {visible.map((e, i) => {
          const cat = categorizeAction(e.action); const color = AUDIT_CAT_COLOR[cat]
          const isLong = (e.detail ?? '').length > 120; const isExp = expandedIdx.has(i)
          const isLast = i === visible.length - 1
          return (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              <div style={{ width: 20, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: color, border: '2px solid #fff', boxShadow: '0 0 0 1px #e5e7eb', flexShrink: 0, zIndex: 1 }} />
                {!isLast && <div style={{ width: 2, flex: 1, backgroundColor: '#e5e7eb' }} />}
              </div>
              <div style={{ flex: 1, paddingBottom: 10 }}>
                <div style={{ padding: '6px 10px', background: 'var(--color-slate-bg)', borderRadius: 6, border: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{fmtTS(e.timestamp)}</span>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 5px', borderRadius: 4, backgroundColor: `${color}15`, color }}>{e.action.replace(/_/g, ' ')}</span>
                    {e.actor && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{e.actor.name}</span>}
                  </div>
                  {e.detail && <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', ...(isLong && !isExp ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{e.detail}</div>}
                  {isLong && <button type="button" onClick={() => setExpandedIdx(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', marginTop: 2 }}>{isExp ? 'Mostra meno' : 'Mostra tutto'}</button>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {filtered.length > 20 && !showAll && <button type="button" onClick={() => setShowAll(true)} style={{ marginTop: 6, background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-brand)' }}>Mostra tutti ({filtered.length})</button>}
    </SectionCard>
  )
}
