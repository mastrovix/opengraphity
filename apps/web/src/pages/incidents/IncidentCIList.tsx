import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { ciPath } from '@/lib/ciPath'

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
}

interface CIRelationRule {
  id:           string
  ciType:       string
  relationType: string
  direction:    string
  description:  string | null
}

function groupByType<T extends { type: string }>(items: T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    ;(acc[item.type] ??= []).push(item)
    return acc
  }, {})
}

function MicroBadge({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display:         'inline-block',
      padding:         '1px 7px',
      borderRadius:    4,
      backgroundColor: color ?? 'var(--surface-2)',
      color:           'var(--text-muted)',
      fontSize:        11,
      fontWeight:      500,
    }}>
      {children}
    </span>
  )
}

interface IncidentCIListProps {
  incidentId:   string
  affectedCIs:  CIRef[]
  ciOpen:       boolean
  showCISearch: boolean
  ciSearch:     string
  ciResults:    CIRef[]
  rules:        CIRelationRule[]
  onToggle:     () => void
  onToggleSearch: (e: React.MouseEvent) => void
  onSearchChange: (value: string) => void
  onAddCI:      (ciId: string, relationType?: string) => void
  onRemoveCI:   (ciId: string) => void
}

export function IncidentCIList({
  incidentId: _incidentId,
  affectedCIs,
  ciOpen,
  showCISearch,
  ciSearch,
  ciResults,
  rules,
  onToggle,
  onToggleSearch,
  onSearchChange,
  onAddCI,
  onRemoveCI,
}: IncidentCIListProps) {
  const navigate = useNavigate()
  const [selectedRelType, setSelectedRelType] = useState<Record<string, string>>({})

  // Filter CI results by allowed types from rules (if any rules configured)
  const allowedTypes = rules.map((r) => r.ciType.toLowerCase())
  const filteredResults = ciResults
    .filter((ci) => !affectedCIs.find((a) => a.id === ci.id))
    .filter((ci) => allowedTypes.length === 0 || allowedTypes.includes(ci.type.toLowerCase()))

  // Get available relation types for a given CI
  const getRelTypes = (ciType: string): string[] => {
    const matching = rules.filter((r) => r.ciType.toLowerCase() === ciType.toLowerCase()).map((r) => r.relationType)
    return [...new Set(matching)]
  }

  const handleAddCI = (ci: CIRef) => {
    const relTypes = getRelTypes(ci.type)
    const relType  = relTypes.length > 0 ? (selectedRelType[ci.id] ?? relTypes[0]) : undefined
    onAddCI(ci.id, relType)
    setSelectedRelType((p) => { const n = { ...p }; delete n[ci.id]; return n })
  }

  return (
    <div style={{
      backgroundColor: '#fff',
      border:          '1px solid #e5e7eb',
      borderRadius:    10,
      boxShadow:       '0 1px 2px rgba(0,0,0,0.05)',
      padding:         0,
      marginBottom:    16,
    }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: ciOpen ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>CI Impattati</span>
          <CountBadge count={affectedCIs.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onToggleSearch}
            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}
          >
            {showCISearch ? 'Chiudi' : '+ Aggiungi CI'}
          </button>
          {ciOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {ciOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {/* Search input */}
          {showCISearch && (
            <div style={{ marginBottom: 12, position: 'relative' }}>
              <input
                type="text"
                value={ciSearch}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={
                  allowedTypes.length > 0
                    ? `Cerca CI (${allowedTypes.join(', ')}) — min. 2 caratteri…`
                    : 'Cerca CI per nome (min. 2 caratteri)...'
                }
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }}
              />
              {filteredResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {filteredResults.map((ci) => {
                    const relTypes = getRelTypes(ci.type)
                    return (
                      <div key={ci.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <span style={{ fontWeight: 500, fontSize: 14 }}>{ci.name}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>{ci.type} · {ci.environment}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            {relTypes.length > 1 && (
                              <select
                                style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer' }}
                                value={selectedRelType[ci.id] ?? relTypes[0]}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setSelectedRelType((p) => ({ ...p, [ci.id]: e.target.value }))}
                              >
                                {relTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                              </select>
                            )}
                            {relTypes.length === 1 && (
                              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#eff6ff', color: '#2563eb', fontWeight: 500 }}>{relTypes[0]}</span>
                            )}
                            <button
                              onClick={() => handleAddCI(ci)}
                              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 500 }}
                            >+</button>
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
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessun CI impattato registrato.</p>
          ) : (
            <div>
              {Object.entries(groupByType(affectedCIs)).map(([type, cis]) => (
                <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={cis.length}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cis.map((ci) => (
                      <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                        <button
                          onClick={() => navigate(ciPath(ci))}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}
                        >
                          {ci.name}
                        </button>
                        <MicroBadge color={
                          ci.status === 'active'         ? '#dcfce7' :
                          ci.status === 'maintenance'    ? '#fef9c3' :
                          ci.status === 'decommissioned' ? '#fee2e2' : undefined
                        }>{ci.status}</MicroBadge>
                        <MicroBadge>{ci.environment}</MicroBadge>
                        <button
                          onClick={() => onRemoveCI(ci.id)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: '0 2px', marginLeft: 'auto' }}
                          title="Rimuovi CI"
                        ><X size={14} /></button>
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
