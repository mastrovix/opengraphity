/**
 * Sezione unica "Ticket collegati" (stile pagina Change) che raccoglie più tipi
 * di ticket collegati (Incident / Problem / Change) in un solo box collassabile:
 * tabella con colonna Tipo, conteggio totale, e un pannello "Collega" con
 * selettore di tipo. Ogni tipo porta i propri risultati di ricerca e le proprie
 * mutation di collegamento/scollegamento.
 *
 * I link non rimovibili (removable === false, es. change auto-collegate) mostrano
 * un lucchetto invece della ✕.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, X, Lock } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Input } from '@/components/ui/FormControls'
import type { LinkedTicketItem } from '@/components/LinkedTicketSection'

export type LinkedKind = 'INCIDENT' | 'PROBLEM' | 'CHANGE'

export interface LinkedTypeConfig {
  kind:         LinkedKind
  label:        string            // etichetta nel selettore, es. "Incident"
  routeBase:    string            // es. '/incidents'
  items:        LinkedTicketItem[]
  searchResults: LinkedTicketItem[]
  searchTerm:   string
  onSearchTerm: (s: string) => void
  onLink:       (id: string) => void
  onUnlink:     (id: string) => void
}

const BADGE: Record<LinkedKind, string> = {
  INCIDENT: 'var(--color-trigger-sla-breach)',
  PROBLEM:  'var(--color-slate)',
  CHANGE:   'var(--color-brand)',
}

export function UnifiedLinkedTickets({ title, types }: { title: string; types: LinkedTypeConfig[] }) {
  const [showSearch, setShowSearch] = useState(false)
  const [activeKind, setActiveKind] = useState<LinkedKind>(types[0]?.kind ?? 'INCIDENT')

  const groups = types
    .map((t) => ({ ...t, rows: t.items }))
    .filter((g) => g.rows.length > 0)
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const active = types.find((t) => t.kind === activeKind) ?? types[0]
  const linkedIds = new Set(types.flatMap((t) => t.items.map((it) => it.id)))
  const results = (active?.searchResults ?? []).filter((r) => !linkedIds.has(r.id)).slice(0, 10)

  return (
    <SectionCard title={title} count={total} collapsible>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" onClick={() => { setShowSearch((s) => !s); active?.onSearchTerm('') }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)', color: 'var(--color-brand)', background: 'transparent', fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer' }}>
          <Plus size={12} /> {showSearch ? 'Chiudi' : 'Collega ticket'}
        </button>
      </div>

      {showSearch && active && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {types.map((t) => (
              <button key={t.kind} type="button" onClick={() => { setActiveKind(t.kind); t.onSearchTerm('') }}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 'var(--font-size-label)', fontWeight: 600, background: activeKind === t.kind ? 'var(--color-brand)' : 'transparent', color: activeKind === t.kind ? '#fff' : 'var(--color-slate)' }}>
                {t.label}
              </button>
            ))}
          </div>
          <Input type="text" value={active.searchTerm} onChange={(e) => active.onSearchTerm(e.target.value)} placeholder={`Cerca ${active.label.toLowerCase()} per numero o titolo...`} autoFocus
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', width: '100%', boxSizing: 'border-box' }} />
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {results.length === 0 ? (
              <p style={{ margin: '4px 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>Nessun risultato.</p>
            ) : results.map((r) => (
              <div key={r.id} onClick={() => active.onLink(r.id)} className="hover-bg"
                style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)', fontSize: 'var(--font-size-body)', ['--hover-bg' as string]: 'var(--surface-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{r.number}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Plus size={14} color="var(--color-brand)" />
              </div>
            ))}
          </div>
        </div>
      )}

      {total === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>Nessun ticket collegato.</p>
      ) : (
        groups.map((g) => (
          <div key={g.kind} style={{ marginBottom: 12 }}>
            {/* Intestazione del gruppo per tipologia */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 6px', borderBottom: '2px solid var(--border)' }}>
              <span style={{ fontSize: 'var(--font-size-caption)', fontWeight: 700, color: '#fff', background: BADGE[g.kind], borderRadius: 4, padding: '2px 6px' }}>{g.kind}</span>
              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{g.label}</span>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>({g.rows.length})</span>
            </div>
            {g.rows.map((r) => (
              <div key={`${g.kind}-${r.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)' }}>
                <span style={{ width: 130 }}><Link to={`${g.routeBase}/${r.id}`} style={{ fontWeight: 600, color: 'var(--color-brand)', textDecoration: 'none' }}>{r.number}</Link></span>
                <span style={{ flex: 1, color: 'var(--color-slate-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <span style={{ width: 120, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>{(r.status || '—').replace(/_/g, ' ')}</span>
                <span style={{ width: 30, display: 'flex', justifyContent: 'flex-end' }}>
                  {r.removable === false ? (
                    <span title="Collegamento automatico: si rimuove solo eliminando la change" style={{ padding: 2, color: 'var(--color-slate-light)', display: 'inline-flex' }}>
                      <Lock size={12} />
                    </span>
                  ) : (
                    <button type="button" title="Scollega" onClick={() => g.onUnlink(r.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-slate-light)' }}>
                      <X size={14} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </SectionCard>
  )
}
