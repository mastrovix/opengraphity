/**
 * Sezione "ticket collegati" riusabile (stile pagina Change): sempre visibile,
 * tabellare, collassabile con conteggio, con ricerca per collegare e ✕ per
 * scollegare. Una istanza per tipo di ticket collegato.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, X, Lock } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Input } from '@/components/ui/FormControls'

export interface LinkedTicketItem { id: string; number: string; title: string; status: string; removable?: boolean | null }

const BADGE: Record<string, string> = {
  INCIDENT: 'var(--color-trigger-sla-breach)',
  PROBLEM:  'var(--color-slate)',
  CHANGE:   'var(--color-brand)',
}

export function LinkedTicketSection({
  title, kind, routeBase, items,
  searchResults, searchTerm, onSearchTerm, onLink, onUnlink,
}: {
  title: string
  kind: 'INCIDENT' | 'PROBLEM' | 'CHANGE'
  routeBase: string                 // es. '/incidents', '/problems', '/changes'
  items: LinkedTicketItem[]
  searchResults: LinkedTicketItem[]
  searchTerm: string
  onSearchTerm: (s: string) => void
  onLink: (id: string) => void
  onUnlink: (id: string) => void
}) {
  const [showSearch, setShowSearch] = useState(false)
  const linkedIds = new Set(items.map((i) => i.id))
  const results = searchResults.filter((r) => !linkedIds.has(r.id)).slice(0, 10)

  return (
    <SectionCard title={title} count={items.length} collapsible>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" onClick={() => { setShowSearch((s) => !s); onSearchTerm('') }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)', color: 'var(--color-brand)', background: 'transparent', fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer' }}>
          <Plus size={12} /> {showSearch ? 'Chiudi' : 'Collega'}
        </button>
      </div>

      {showSearch && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <Input type="text" value={searchTerm} onChange={(e) => onSearchTerm(e.target.value)} placeholder={`Cerca ${title.toLowerCase()} per numero o titolo...`} autoFocus
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', width: '100%', boxSizing: 'border-box' }} />
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {results.length === 0 ? (
              <p style={{ margin: '4px 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>Nessun risultato.</p>
            ) : results.map((r) => (
              <div key={r.id} onClick={() => onLink(r.id)} className="hover-bg"
                style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-body)', ['--hover-bg' as string]: 'var(--surface-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{r.number}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Plus size={14} color="var(--color-brand)" />
              </div>
            ))}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>Nessun ticket collegato.</p>
      ) : (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
          <span style={{ width: 130 }}>Numero</span>
          <span style={{ flex: 1 }}>Titolo</span>
          <span style={{ width: 120 }}>Stato</span>
          <span style={{ width: 30 }} />
        </div>
        {items.map((r) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)' }}>
            <span style={{ width: 130, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'var(--font-size-caption)', fontWeight: 700, color: '#fff', background: BADGE[kind], borderRadius: 4, padding: '1px 5px' }}>{kind[0]}</span>
              <Link to={`${routeBase}/${r.id}`} style={{ fontWeight: 600, color: 'var(--color-brand)', textDecoration: 'none' }}>{r.number}</Link>
            </span>
            <span style={{ flex: 1, color: 'var(--color-slate-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
            <span style={{ width: 120, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>{(r.status || '—').replace(/_/g, ' ')}</span>
            <span style={{ width: 30, display: 'flex', justifyContent: 'flex-end' }}>
              {r.removable === false ? (
                <span title="Collegamento automatico: si rimuove solo eliminando la change" style={{ padding: 2, color: 'var(--color-slate-light)', display: 'inline-flex' }}>
                  <Lock size={12} />
                </span>
              ) : (
                <button type="button" title="Scollega" onClick={() => onUnlink(r.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-slate-light)' }}>
                  <X size={14} />
                </button>
              )}
            </span>
          </div>
        ))}
      </>)}
    </SectionCard>
  )
}
