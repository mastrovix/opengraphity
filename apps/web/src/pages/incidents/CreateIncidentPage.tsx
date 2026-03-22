import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { X, Users } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_INCIDENT, ASSIGN_INCIDENT_TO_TEAM } from '@/graphql/mutations'
import { GET_INCIDENTS, GET_ALL_CIS, GET_TEAMS } from '@/graphql/queries'

interface CIRef { id: string; name: string; type: string; environment?: string }
interface Team  { id: string; name: string }

// ── Style helpers ─────────────────────────────────────────────────────────────

const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

const inputBase: React.CSSProperties = {
  width: '100%', padding: '10px 14px',
  border: '1.5px solid #e5e7eb', borderRadius: 8,
  fontSize: 14, color: 'var(--color-slate-dark)', outline: 'none',
  backgroundColor: '#fff', boxSizing: 'border-box',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", transition: 'border-color 150ms',
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  critical: { bg: '#fef2f2', border: 'var(--color-danger)', color: 'var(--color-trigger-sla-breach)' },
  high:     { bg: '#fff7ed', border: 'var(--color-brand)', color: 'var(--color-brand)' },
  medium:   { bg: '#fefce8', border: 'var(--color-warning)', color: '#b45309' },
  low:      { bg: '#f0fdf4', border: 'var(--color-success)', color: '#15803d' },
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateIncidentPage() {
  const navigate = useNavigate()

  const [title,       setTitle]       = useState('')
  const [severity,    setSeverity]    = useState('medium')
  const [description, setDescription] = useState('')
  const [selectedTeam,      setSelectedTeam]      = useState<{ id: string; name: string } | null>(null)
  const [teamSearch,        setTeamSearch]        = useState('')
  const [teamDropdownOpen,  setTeamDropdownOpen]  = useState(false)
  const [ciSearch,    setCiSearch]    = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])

  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20 },
    skip: ciSearch.length < 2,
  })
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const ciResults     = (ciData?.allCIs?.items ?? []).filter(ci => !selectedCIs.find(s => s.id === ci.id))
  const teams         = teamsData?.teams ?? []
  const filteredTeams = teams.filter(t => t.name.toLowerCase().includes(teamSearch.toLowerCase()))
  const canSubmit     = title.trim().length > 0

  const [assignToTeam] = useMutation(ASSIGN_INCIDENT_TO_TEAM, {
    onError: (err) => toast.error(`Team assignment: ${err.message}`),
  })

  const [createIncident, { loading }] = useMutation<{ createIncident: { id: string } }>(CREATE_INCIDENT, {
    refetchQueries: [{ query: GET_INCIDENTS }],
    onCompleted: async (data) => {
      if (selectedTeam) {
        await assignToTeam({ variables: { id: data.createIncident.id, teamId: selectedTeam.id } })
      }
      toast.success('Incident creato')
      navigate('/incidents', { state: { refresh: true } })
    },
    onError: (err) => toast.error(err.message),
  })

  const handleSubmit = () => {
    if (!canSubmit || loading) return
    void createIncident({
      variables: {
        input: {
          title:         title.trim(),
          severity,
          description:   description.trim() || undefined,
          affectedCIIds: selectedCIs.map(ci => ci.id),
        },
      },
    })
  }

  return (
    <div style={{ minHeight: '100%', backgroundColor: '#f8fafc', padding: '32px 16px 64px' }}>
      <div style={{ maxWidth: 580, margin: '0 auto' }}>

        {/* Header */}
        <button
          onClick={() => navigate('/incidents')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
        >
          ← Incidents
        </button>

        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          Nuovo Incident
        </h1>
        <p style={{ fontSize: 14, color: 'var(--color-slate)', margin: '0 0 24px' }}>
          Compila i dettagli dell'incident da aprire
        </p>

        {/* Card */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '28px 32px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

          {/* TITOLO */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              Titolo <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Es. Database produzione non raggiungibile"
              style={inputBase}
              autoFocus
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
            />
          </div>

          {/* SEVERITY */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              Severity <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['critical', 'high', 'medium', 'low'] as const).map(s => {
                const sel = severity === s
                const c   = SEVERITY_STYLES[s]!
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    style={{
                      padding: '7px 16px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                      border: `1.5px solid ${sel ? c.border : '#e5e7eb'}`,
                      background: sel ? c.bg : '#f8fafc',
                      color: sel ? c.color : 'var(--color-slate)',
                      fontWeight: sel ? 600 : 400,
                      transition: 'all 0.15s',
                    }}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* DESCRIZIONE */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              Descrizione{' '}
              <span style={{ fontSize: 12, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>(opzionale)</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Descrivi cosa sta succedendo..."
              rows={3}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
            />
          </div>

          {/* CI IMPATTATI */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              CI Impattati{' '}
              <span style={{ fontSize: 12, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>(opzionale)</span>
            </label>

            {/* Search input with icon */}
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none', color: 'var(--color-slate-light)' }}>
                🔍
              </span>
              <input
                type="text"
                value={ciSearch}
                onChange={e => setCiSearch(e.target.value)}
                placeholder="Cerca per nome..."
                style={{ ...inputBase, paddingLeft: 36 }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
              />

              {/* Dropdown */}
              {ciResults.length > 0 && ciSearch.length >= 2 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                  {ciResults.map(ci => (
                    <div
                      key={ci.id}
                      onClick={() => { setSelectedCIs(p => [...p, ci]); setCiSearch('') }}
                      style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #f3f4f6' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{ci.name}</span>
                      <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 4, backgroundColor: '#f3f4f6', color: 'var(--color-slate)' }}>
                        {ci.type}{ci.environment ? ` · ${ci.environment}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Selected tags */}
            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {selectedCIs.map(ci => (
                  <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-brand-light)', border: '1px solid #c7d2fe', color: 'var(--color-brand-hover)', fontSize: 12 }}>
                    {ci.name}
                    <button
                      type="button"
                      onClick={() => setSelectedCIs(p => p.filter(c => c.id !== ci.id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand-hover)', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* TEAM */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              Team{' '}
              <span style={{ fontSize: 12, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>(opzionale)</span>
            </label>

            {/* Tag team selezionato */}
            {selectedTeam && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: '#f0fdf4', border: '1px solid #86efac', color: '#15803d', fontSize: 12 }}>
                  {selectedTeam.name}
                  <button
                    type="button"
                    onClick={() => { setSelectedTeam(null); setTeamSearch('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}

            {/* Search input */}
            {!selectedTeam && (
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none', color: 'var(--color-slate-light)' }}>
                  🔍
                </span>
                <input
                  type="text"
                  value={teamSearch}
                  onChange={e => { setTeamSearch(e.target.value); setTeamDropdownOpen(true) }}
                  onFocus={() => setTeamDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setTeamDropdownOpen(false), 150)}
                  placeholder="Cerca team per nome..."
                  style={{ ...inputBase, paddingLeft: 36 }}
                  onFocusCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                  onBlurCapture={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
                />

                {/* Dropdown */}
                {teamDropdownOpen && filteredTeams.length > 0 && (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                    {filteredTeams.map(t => (
                      <div
                        key={t.id}
                        onMouseDown={() => { setSelectedTeam(t); setTeamSearch(''); setTeamDropdownOpen(false) }}
                        style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #f3f4f6' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                      >
                        <Users size={14} color="var(--color-slate-light)" />
                        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{t.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid #f3f4f6', marginTop: 8, paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => navigate('/incidents')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-slate)', padding: 0 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
            >
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || loading}
              style={{
                background: 'var(--color-brand)', color: '#fff', border: 'none', borderRadius: 8,
                padding: '10px 24px', fontSize: 14, fontWeight: 600,
                cursor: canSubmit && !loading ? 'pointer' : 'not-allowed',
                opacity: canSubmit && !loading ? 1 : 0.5,
                transition: 'opacity 150ms',
              }}
            >
              {loading ? 'Creazione…' : 'Crea Incident'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
