/**
 * Sezione unica "Ticket collegati" (incident, problem, change): un solo box
 * collassabile con conteggio totale, righe RAGGRUPPATE per tipologia e un
 * pannello "Collega" con selettore di tipo.
 *
 * La ricerca vive QUI: le query per tipo partono solo quando il pannello è
 * aperto e il tab è attivo (niente fetch eager a ogni apertura del dettaglio),
 * e il filtro per numero/titolo è applicato lato client per tutti i tipi —
 * `changes(...)` non ha un argomento `search` e prima il tab Change non
 * filtrava affatto. `excludeId` toglie il ticket corrente dai risultati
 * (un problem non può collegarsi a sé stesso).
 *
 * I link non rimovibili (removable === false, es. change auto-collegate)
 * mostrano un lucchetto invece della ✕.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { Plus, X, Lock } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Input } from '@/components/ui/FormControls'
import { GET_INCIDENTS, GET_PROBLEMS, GET_CHANGES } from '@/graphql/queries'
import { colors, palette } from '@/lib/tokens'

export interface LinkedTicketItem { id: string; number: string; title: string; status: string; removable?: boolean | null }

export type LinkedKind = 'INCIDENT' | 'PROBLEM' | 'CHANGE'

export interface LinkedTypeConfig {
  kind:      LinkedKind
  label:     string            // etichetta nel selettore, es. "Incident"
  routeBase: string            // es. '/incidents'
  items:     LinkedTicketItem[]
  onLink:    (id: string) => void
  onUnlink:  (id: string) => void
}

const BADGE: Record<LinkedKind, string> = {
  INCIDENT: 'var(--color-trigger-sla-breach)',
  PROBLEM:  'var(--color-slate)',
  CHANGE:   'var(--color-brand)',
}

/** Risultati di ricerca per il tipo attivo: query lazy (skip quando il tab non è attivo). */
function useLinkSearch(kind: LinkedKind | null, term: string): LinkedTicketItem[] {
  const { data: inc } = useQuery<{ incidents: { items: LinkedTicketItem[] } }>(GET_INCIDENTS, {
    variables: { limit: 50 }, skip: kind !== 'INCIDENT',
  })
  const { data: prb } = useQuery<{ problems: { items: LinkedTicketItem[] } }>(GET_PROBLEMS, {
    variables: { search: term.trim() || undefined, limit: 20 }, skip: kind !== 'PROBLEM',
  })
  const { data: chg } = useQuery<{ changes: { items: { id: string; code: string; title: string; approvalStatus?: string | null; workflowInstance?: { currentStep?: string | null } | null }[] } }>(GET_CHANGES, {
    variables: { limit: 50 }, skip: kind !== 'CHANGE',
  })
  if (kind === 'INCIDENT') return inc?.incidents?.items ?? []
  if (kind === 'PROBLEM')  return prb?.problems?.items ?? []
  if (kind === 'CHANGE')   return (chg?.changes?.items ?? []).map((c) => ({ id: c.id, number: c.code, title: c.title, status: c.workflowInstance?.currentStep ?? c.approvalStatus ?? '' }))
  return []
}

export function UnifiedLinkedTickets({ title, types, excludeId }: { title: string; types: LinkedTypeConfig[]; excludeId?: string }) {
  const [showSearch, setShowSearch] = useState(false)
  const [activeKind, setActiveKind] = useState<LinkedKind>(types[0]?.kind ?? 'INCIDENT')
  const [term, setTerm] = useState('')

  const groups = types.map((t) => ({ ...t, rows: t.items })).filter((g) => g.rows.length > 0)
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const active = types.find((t) => t.kind === activeKind) ?? types[0]
  const linkedIds = new Set(types.flatMap((t) => t.items.map((it) => it.id)))

  const raw = useLinkSearch(showSearch && active ? active.kind : null, term)
  const q = term.trim().toLowerCase()
  const results = raw
    .filter((r) => r.id !== excludeId && !linkedIds.has(r.id))
    .filter((r) => q === '' || `${r.number} ${r.title}`.toLowerCase().includes(q))
    .slice(0, 10)

  return (
    <SectionCard title={title} count={total} collapsible>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" onClick={() => { setShowSearch((s) => !s); setTerm('') }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)', color: 'var(--color-brand)', background: 'transparent', fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer' }}>
          <Plus size={12} /> {showSearch ? 'Chiudi' : 'Collega ticket'}
        </button>
      </div>

      {showSearch && active && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {types.map((t) => (
              <button key={t.kind} type="button" onClick={() => { setActiveKind(t.kind); setTerm('') }}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 'var(--font-size-label)', fontWeight: 600, background: activeKind === t.kind ? 'var(--color-brand)' : 'transparent', color: activeKind === t.kind ? colors.white : 'var(--color-slate)' }}>
                {t.label}
              </button>
            ))}
          </div>
          <Input type="text" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={`Cerca ${active.label.toLowerCase()} per numero o titolo...`}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: campo di ricerca montato dopo il click su "Collega ticket"
            autoFocus
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', width: '100%', boxSizing: 'border-box' }} />
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {results.length === 0 ? (
              <p style={{ margin: '4px 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>Nessun risultato.</p>
            ) : results.map((r) => (
              <button key={r.id} type="button" onClick={() => active.onLink(r.id)} className="hover-bg"
                style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'inherit', ['--hover-bg' as string]: 'var(--surface-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{r.number}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Plus size={14} color="var(--color-brand)" />
              </button>
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
              <span style={{ fontSize: 'var(--font-size-caption)', fontWeight: 700, color: colors.white, background: BADGE[g.kind], borderRadius: 4, padding: '2px 6px' }}>{g.kind}</span>
              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{g.label}</span>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>({g.rows.length})</span>
            </div>
            {g.rows.map((r) => (
              <div key={`${g.kind}-${r.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${palette.neutral.borderLight}`, fontSize: 'var(--font-size-body)' }}>
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
