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

interface IncidentRef {
  id:        string
  title:     string
  status:    string
  severity:  string
  createdAt: string
}

interface ChangeRef {
  id:             string
  title:          string
  type:           string
  status:         string
  scheduledStart: string | null
}

function groupByField<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = String(item[key])
    ;(acc[k] ??= []).push(item)
    return acc
  }, {})
}

function MicroBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>
      {children}
    </span>
  )
}

// ── CI Impattati ──────────────────────────────────────────────────────────────

interface ProblemCIListProps {
  problemId:    string
  affectedCIs:  CIRef[]
  ciOpen:       boolean
  showCISearch: boolean
  ciSearch:     string
  ciResults:    CIRef[]
  onToggle:     () => void
  onToggleSearch: (e: React.MouseEvent) => void
  onSearchChange: (value: string) => void
  onAddCI:      (ciId: string) => void
  onRemoveCI:   (ciId: string) => void
}

export function ProblemCIList({
  problemId: _problemId,
  affectedCIs,
  ciOpen,
  showCISearch,
  ciSearch,
  ciResults,
  onToggle,
  onToggleSearch,
  onSearchChange,
  onAddCI,
  onRemoveCI,
}: ProblemCIListProps) {
  const navigate = useNavigate()

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)', padding: 0, marginBottom: 16 }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: ciOpen ? '1px solid #e5e7eb' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>CI Impattati</span>
          <CountBadge count={affectedCIs.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onToggleSearch} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
            {showCISearch ? 'Chiudi' : '+ Aggiungi CI'}
          </button>
          {ciOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {ciOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {showCISearch && (
            <div style={{ marginBottom: 12, position: 'relative' }}>
              <input type="text" value={ciSearch} onChange={(e) => onSearchChange(e.target.value)} placeholder="Cerca CI (min. 2 caratteri)..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
              {ciResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {ciResults.filter((ci) => !affectedCIs.find((a) => a.id === ci.id)).map((ci) => (
                    <div key={ci.id} onClick={() => onAddCI(ci.id)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                      <span style={{ fontWeight: 500 }}>{ci.name}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ci.type} · {ci.environment}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {affectedCIs.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessun CI impattato registrato.</p>
          ) : (
            <div>
              {Object.entries(groupByField(affectedCIs, 'type')).map(([type, cis]) => (
                <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={cis.length}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cis.map((ci) => (
                      <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                        <button onClick={() => navigate(ciPath(ci))} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{ci.name}</button>
                        <MicroBadge>{ci.status}</MicroBadge>
                        <MicroBadge>{ci.environment}</MicroBadge>
                        <button onClick={() => onRemoveCI(ci.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: '0 2px', marginLeft: 'auto' }} title="Rimuovi CI"><X size={14} /></button>
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

// ── Incident Correlati ────────────────────────────────────────────────────────

interface ProblemIncidentListProps {
  problemId:         string
  relatedIncidents:  IncidentRef[]
  incidentsOpen:     boolean
  showIncidentSearch: boolean
  incidentSearch:    string
  incidentResults:   IncidentRef[]
  onToggle:          () => void
  onToggleSearch:    (e: React.MouseEvent) => void
  onSearchChange:    (value: string) => void
  onLink:            (incidentId: string) => void
  onUnlink:          (incidentId: string) => void
}

export function ProblemIncidentList({
  problemId: _problemId,
  relatedIncidents,
  incidentsOpen,
  showIncidentSearch,
  incidentSearch,
  incidentResults,
  onToggle,
  onToggleSearch,
  onSearchChange,
  onLink,
  onUnlink,
}: ProblemIncidentListProps) {
  const navigate = useNavigate()

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)', padding: 0, marginBottom: 16 }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: incidentsOpen ? '1px solid #e5e7eb' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Incident Correlati</span>
          <CountBadge count={relatedIncidents.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onToggleSearch} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
            {showIncidentSearch ? 'Chiudi' : '+ Collega Incident'}
          </button>
          {incidentsOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {incidentsOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {showIncidentSearch && (
            <div style={{ marginBottom: 12 }}>
              <input type="text" value={incidentSearch} onChange={(e) => onSearchChange(e.target.value)} placeholder="Filtra incident per titolo..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
              {incidentResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {incidentResults.filter((i) => !relatedIncidents.find((r) => r.id === i.id) && (incidentSearch.length < 2 || i.title.toLowerCase().includes(incidentSearch.toLowerCase()))).map((inc) => (
                    <div key={inc.id} onClick={() => onLink(inc.id)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                      <span style={{ fontWeight: 500 }}>{inc.title}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{inc.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {relatedIncidents.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessun incident correlato.</p>
          ) : (
            <div>
              {Object.entries(groupByField(relatedIncidents, 'status')).map(([status, incidents]) => (
                <CollapsibleGroup key={status} title={status.replace(/_/g, ' ')} count={incidents.length}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {incidents.map((inc) => (
                      <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                        <button onClick={() => navigate(`/incidents/${inc.id}`)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{inc.title}</button>
                        <MicroBadge>{inc.severity}</MicroBadge>
                        <button onClick={() => onUnlink(inc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 'auto' }} title="Scollega"><X size={14} /></button>
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

// ── Change Correlate ──────────────────────────────────────────────────────────

interface ProblemChangeListProps {
  problemId:       string
  relatedChanges:  ChangeRef[]
  changesOpen:     boolean
  showChangeSearch: boolean
  changeSearch:    string
  changeResults:   ChangeRef[]
  onToggle:        () => void
  onToggleSearch:  (e: React.MouseEvent) => void
  onSearchChange:  (value: string) => void
  onLink:          (changeId: string) => void
}

export function ProblemChangeList({
  problemId: _problemId,
  relatedChanges,
  changesOpen,
  showChangeSearch,
  changeSearch,
  changeResults,
  onToggle,
  onToggleSearch,
  onSearchChange,
  onLink,
}: ProblemChangeListProps) {
  const navigate = useNavigate()

  return (
    <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)', padding: 0, marginBottom: 16 }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: changesOpen ? '1px solid #e5e7eb' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Change Correlate</span>
          <CountBadge count={relatedChanges.length} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onToggleSearch} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
            {showChangeSearch ? 'Chiudi' : '+ Collega Change'}
          </button>
          {changesOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {changesOpen && (
        <div style={{ padding: '16px 20px 20px' }}>
          {showChangeSearch && (
            <div style={{ marginBottom: 12 }}>
              <input type="text" value={changeSearch} onChange={(e) => onSearchChange(e.target.value)} placeholder="Cerca change (min. 2 caratteri)..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
              {changeResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {changeResults.filter((c) => !relatedChanges.find((r) => r.id === c.id)).map((ch) => (
                    <div key={ch.id} onClick={() => onLink(ch.id)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                      <span style={{ fontWeight: 500 }}>{ch.title}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ch.type} · {ch.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {relatedChanges.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna change correlata.</p>
          ) : (
            <div>
              {Object.entries(groupByField(relatedChanges, 'type')).map(([type, changes]) => (
                <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={changes.length}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {changes.map((ch) => (
                      <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                        <button onClick={() => navigate(`/changes/${ch.id}`)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{ch.title}</button>
                        <MicroBadge>{ch.status}</MicroBadge>
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
