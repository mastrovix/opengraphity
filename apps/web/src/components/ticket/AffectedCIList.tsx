/**
 * "CI Impattati" di un ticket (incident, problem): ricerca con filtro per tipo
 * dalle regole ITIL, scelta del tipo di relazione, elenco raggruppato per tipo.
 * Un'unica implementazione al posto di IncidentCIList / ProblemCIList (che
 * differivano solo per una prop ignorata e per i colori dello status).
 * Lo stato di apertura/ricerca è interno: il genitore passa solo dati e azioni.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/FormControls'
import { CountBadge } from '@/components/ui/CountBadge'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { ciPath } from '@/lib/ciPath'
import { alpha, colors, palette } from '@/lib/tokens'

export interface AffectedCIRef {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
}

export interface CIRelationRule {
  id:           string
  ciType:       string
  relationType: string
  direction:    string
  description:  string | null
}

const STATUS_BG: Record<string, string> = { active: palette.success.tint, maintenance: palette.yellow.bg, decommissioned: palette.danger.tint }

function groupByType<T extends { type: string }>(items: T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => { (acc[item.type] ??= []).push(item); return acc }, {})
}

function MicroBadge({ children, bg }: { children: React.ReactNode; bg?: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, backgroundColor: bg ?? 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 'var(--font-size-caption)', fontWeight: 500 }}>
      {children}
    </span>
  )
}

interface Props {
  affectedCIs:    AffectedCIRef[]
  rules:          CIRelationRule[]
  /** Risultati della ricerca (il genitore esegue la query con `search`). */
  ciResults:      AffectedCIRef[]
  onSearchChange: (value: string) => void
  onAddCI:        (ciId: string, relationType?: string) => void
  onRemoveCI:     (ciId: string) => void
  defaultOpen?:   boolean
}

export function AffectedCIList({ affectedCIs, rules, ciResults, onSearchChange, onAddCI, onRemoveCI, defaultOpen = false }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(defaultOpen)
  const [showSearch, setShowSearch] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedRelType, setSelectedRelType] = useState<Record<string, string>>({})

  const allowedTypes = rules.map((r) => r.ciType.toLowerCase())
  const getRelTypes  = (ciType: string) => [...new Set(rules.filter((r) => r.ciType.toLowerCase() === ciType.toLowerCase()).map((r) => r.relationType))]
  const filteredResults = ciResults
    .filter((ci) => !affectedCIs.find((a) => a.id === ci.id))
    .filter((ci) => allowedTypes.length === 0 || allowedTypes.includes(ci.type.toLowerCase()))

  const handleAdd = (ci: AffectedCIRef) => {
    const relTypes = getRelTypes(ci.type)
    onAddCI(ci.id, relTypes.length > 0 ? (selectedRelType[ci.id] ?? relTypes[0]) : undefined)
    setSelectedRelType((p) => { const n = { ...p }; delete n[ci.id]; return n })
    setSearch(''); onSearchChange(''); setShowSearch(false)
  }
  const toggleSearch = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowSearch((s) => !s)
    if (!open) setOpen(true)
  }

  return (
    <div style={{ backgroundColor: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: `0 1px 2px ${alpha.black05}`, padding: 0, marginBottom: 16 }}>
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen((p) => !p)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((p) => !p) } }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? `1px solid ${colors.border}` : 'none', background: open ? colors.brand : undefined }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: open ? colors.white : 'var(--color-slate-dark)' }}>CI Impattati</span>
          <CountBadge count={affectedCIs.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={toggleSearch}
            style={{ fontSize: 'var(--font-size-body)', padding: '4px 10px', borderRadius: 6, border: `1px solid ${open ? colors.white : 'var(--border)'}`, background: 'transparent', cursor: 'pointer', color: open ? colors.white : 'var(--accent)' }}>
            {showSearch ? 'Chiudi' : '+ Aggiungi CI'}
          </button>
          {open ? <ChevronDown size={16} color={colors.white} /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {open && (
        <div style={{ padding: '16px 20px 20px' }}>
          {showSearch && (
            <div style={{ marginBottom: 12, position: 'relative' }}>
              <Input type="text" value={search} onChange={(e) => { setSearch(e.target.value); onSearchChange(e.target.value) }}
                placeholder={allowedTypes.length > 0 ? `Cerca CI (${allowedTypes.join(', ')}) — min. 2 caratteri…` : 'Cerca CI per nome (min. 2 caratteri)...'}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: campo di ricerca montato dopo il click su "Aggiungi CI"
                autoFocus style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)' }} />
              {filteredResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: 'auto', backgroundColor: colors.white, boxShadow: `0 4px 12px ${alpha.black10}` }}>
                  {filteredResults.map((ci) => {
                    const relTypes = getRelTypes(ci.type)
                    return (
                      <div key={ci.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <span style={{ fontWeight: 500, fontSize: 'var(--font-size-body)' }}>{ci.name}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-body)', marginLeft: 8 }}>{ci.type} · {ci.environment}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            {relTypes.length > 1 && (
                              <select style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer' }}
                                value={selectedRelType[ci.id] ?? relTypes[0]}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setSelectedRelType((p) => ({ ...p, [ci.id]: e.target.value }))}>
                                {relTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                              </select>
                            )}
                            {relTypes.length === 1 && (
                              <span style={{ fontSize: 'var(--font-size-table)', padding: '2px 6px', borderRadius: 4, background: 'var(--color-info-bg)', color: colors.brand, fontWeight: 500 }}>{relTypes[0]}</span>
                            )}
                            <button type="button" onClick={() => handleAdd(ci)}
                              style={{ fontSize: 'var(--font-size-body)', padding: '4px 10px', borderRadius: 4, border: 'none', background: 'var(--accent)', color: colors.white, cursor: 'pointer', fontWeight: 500 }}>+</button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {affectedCIs.length === 0 ? (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>Nessun CI impattato registrato.</p>
          ) : (
            <div>
              {Object.entries(groupByType(affectedCIs)).map(([type, cis]) => (
                <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={cis.length}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cis.map((ci) => (
                      <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                        <button type="button" onClick={() => navigate(ciPath(ci))} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{ci.name}</button>
                        <MicroBadge bg={STATUS_BG[ci.status]}>{ci.status}</MicroBadge>
                        <MicroBadge>{ci.environment}</MicroBadge>
                        <button type="button" onClick={() => onRemoveCI(ci.id)} title="Rimuovi CI" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--font-size-body)', lineHeight: 1, padding: '0 2px', marginLeft: 'auto' }}><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                </CollapsibleGroup>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
