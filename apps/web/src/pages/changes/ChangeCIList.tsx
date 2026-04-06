import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from '@/components/ui/CountBadge'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { GET_ALL_CIS } from '@/graphql/queries'
import type { CI } from './change-types'
import { groupByField, cardStyle, inputStyle } from './change-types'

interface CIRelationRule {
  id:           string
  ciType:       string
  relationType: string
  direction:    string
  description:  string | null
}

interface Props {
  changeId:    string
  affectedCIs: CI[]
  currentStep: string
  rules:       CIRelationRule[]
  onAddCI:     (ciId: string, relationType?: string) => void
  onRemoveCI:  (ciId: string, ciName: string) => void
}

export function ChangeCIList({ changeId: _changeId, affectedCIs, currentStep, rules, onAddCI, onRemoveCI }: Props) {
  const [open, setOpen]             = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [ciSearch, setCiSearch]     = useState('')
  const [selectedRelType, setSelectedRelType] = useState<Record<string, string>>({})

  const { data: ciSearchData } = useQuery<{ allCIs: { items: CI[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch || null, limit: 20 },
    skip: ciSearch.length < 2,
  })

  const allowedTypes = rules.map((r) => r.ciType)
  const getRelTypes  = (ciType: string) => [...new Set(rules.filter((r) => r.ciType === ciType).map((r) => r.relationType))]
  const ciResults    = (ciSearchData?.allCIs?.items ?? [])
    .filter((ci) => !affectedCIs.find((a) => a.id === ci.id))
    .filter((ci) => allowedTypes.length === 0 || allowedTypes.includes(ci.type))

  const canEdit = ['draft', 'assessment'].includes(currentStep)

  const handleAdd = (ci: CI) => {
    const relTypes = getRelTypes(ci.type)
    const relType  = relTypes.length > 0 ? (selectedRelType[ci.id] ?? relTypes[0]) : undefined
    onAddCI(ci.id, relType)
    setCiSearch('')
    setShowSearch(false)
    setSelectedRelType((p) => { const n = { ...p }; delete n[ci.id]; return n })
  }

  return (
    <div style={{ ...cardStyle, padding: 0 }}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>CI Impattati</span>
          <CountBadge count={affectedCIs.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            disabled={!canEdit}
            onClick={(e) => { e.stopPropagation(); setShowSearch((v) => !v); if (!open) setOpen(true) }}
            style={{
              fontSize: 12, fontWeight: 600, borderRadius: 6, padding: '4px 10px', border: '1px solid #e2e6f0', background: 'none',
              color:         canEdit ? 'var(--color-brand)' : 'var(--color-slate-light)',
              cursor:        canEdit ? 'pointer' : 'not-allowed',
              opacity:       canEdit ? 1 : 0.5,
              pointerEvents: canEdit ? 'auto' : 'none',
            }}
          >
            {showSearch ? 'Chiudi' : '+ Aggiungi CI'}
          </button>
          {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {open && (
        <div style={{ padding: '16px 20px 20px' }}>
          {showSearch && (
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                value={ciSearch}
                onChange={(e) => setCiSearch(e.target.value)}
                placeholder={allowedTypes.length > 0 ? `Cerca CI (${allowedTypes.join(', ')}) — min. 2 car…` : 'Cerca CI per nome (min. 2 caratteri)…'}
                autoFocus
                style={inputStyle}
              />
              {ciResults.length > 0 && (
                <div style={{ border: '1px solid #e2e6f0', borderRadius: 6, marginTop: 4, backgroundColor: '#fff', maxHeight: 240, overflowY: 'auto' }}>
                  {ciResults.map((ci) => {
                    const relTypes = getRelTypes(ci.type)
                    return (
                      <div key={ci.id} style={{ padding: '8px 12px', borderBottom: '1px solid #f1f3f8' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <span style={{ fontWeight: 500, fontSize: 14 }}>{ci.name}</span>
                            <span style={{ color: 'var(--color-slate-light)', fontSize: 12, marginLeft: 8 }}>{ci.type} · {ci.environment}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            {relTypes.length > 1 && (
                              <select style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4, border: '1px solid #e2e6f0', cursor: 'pointer' }}
                                value={selectedRelType[ci.id] ?? relTypes[0]}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setSelectedRelType((p) => ({ ...p, [ci.id]: e.target.value }))}>
                                {relTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                              </select>
                            )}
                            {relTypes.length === 1 && (
                              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#eff6ff', color: '#2563eb', fontWeight: 500 }}>{relTypes[0]}</span>
                            )}
                            <button onClick={() => handleAdd(ci)}
                              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontWeight: 500 }}>+</button>
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
            <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>Nessun CI associato</span>
          ) : (
            <div>
              {Object.entries(groupByField(affectedCIs, (ci) => ci.type)).map(([type, cis]) => (
                <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={cis.length}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0' }}>
                    {cis.map((ci) => (
                      <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#eff6ff', color: '#2563eb', padding: '4px 10px', borderRadius: 100, fontSize: 12, fontWeight: 500 }}>
                        {ci.name}
                        <button
                          type="button"
                          onClick={() => onRemoveCI(ci.id, ci.name)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', padding: 0, lineHeight: 1, fontSize: 14 }}
                        >×</button>
                      </span>
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
