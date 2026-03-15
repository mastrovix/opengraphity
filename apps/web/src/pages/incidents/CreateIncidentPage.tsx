import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { ArrowLeft, X } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_INCIDENT } from '@/graphql/mutations'
import { GET_INCIDENTS, GET_ALL_CIS } from '@/graphql/queries'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CIRef { id: string; name: string; type: string; environment?: string }

// ── Shared style constants ────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          '1px solid #e5e7eb',
  borderRadius:    6,
  fontSize:        14,
  color:           '#0f1629',
  outline:         'none',
  backgroundColor: '#ffffff',
  boxSizing:       'border-box',
  transition:      'border-color 150ms, box-shadow 150ms',
}

const selectBase: React.CSSProperties = {
  ...inputBase,
  appearance:          'none',
  backgroundImage:     `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat:    'no-repeat',
  backgroundPosition:  'right 12px center',
  paddingRight:        36,
  cursor:              'pointer',
}

function focusHandlers(hasError: boolean) {
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = '#4f46e5'
      e.currentTarget.style.boxShadow   = '0 0 0 3px #eef2ff'
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? '#dc2626' : '#e5e7eb'
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

// Dot colors for severity
const SEV_DOT: Record<string, string> = {
  critical: '#dc2626',
  high:     '#d97706',
  medium:   '#0284c7',
  low:      '#8892a4',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateIncidentPage() {
  const navigate = useNavigate()

  const [title, setTitle]             = useState('')
  const [severity, setSeverity]       = useState('medium')
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted]     = useState(false)
  const [ciSearch, setCiSearch]       = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])

  const titleError = submitted && !title.trim() ? 'This field is required' : ''

  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20 },
    skip: ciSearch.length < 2,
  })
  const ciResults = ciData?.allCIs?.items ?? []

  const [createIncident, { loading }] = useMutation(CREATE_INCIDENT, {
    refetchQueries: [{ query: GET_INCIDENTS }],
    onCompleted: () => { toast.success('Incident created'); navigate('/incidents') },
    onError:     (err) => toast.error(err.message),
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!title.trim()) return
    await createIncident({
      variables: {
        input: {
          title:         title.trim(),
          severity,
          description:   description || undefined,
          affectedCIIds: selectedCIs.map(ci => ci.id),
        },
      },
    })
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', paddingTop: 32 }}>

      {/* Back link */}
      <button
        onClick={() => navigate('/incidents')}
        style={{
          display:         'flex',
          alignItems:      'center',
          gap:             6,
          background:      'none',
          border:          'none',
          cursor:          'pointer',
          fontSize:        13,
          color:           '#8892a4',
          marginBottom:    32,
          padding:         0,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#4f46e5' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8892a4' }}
      >
        <ArrowLeft size={14} />
        Back to incidents
      </button>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.02em', margin: 0 }}>
          New Incident
        </h1>
        <p style={{ fontSize: 14, color: '#8892a4', marginTop: 6, marginBottom: 0 }}>
          Fill in the fields to open a new incident
        </p>
      </div>

      {/* Form card */}
      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 32 }}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Title */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Title <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
              placeholder="Brief description of the incident"
              style={{ ...inputBase, borderColor: titleError ? '#dc2626' : '#e5e7eb' }}
              {...focusHandlers(!!titleError)}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626' }}>{titleError}</p>
            )}
          </div>

          {/* Severity */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Severity <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <div style={{ position: 'relative' }}>
              <span style={{
                position:        'absolute',
                left:            13,
                top:             '50%',
                transform:       'translateY(-50%)',
                width:           8,
                height:          8,
                borderRadius:    '50%',
                backgroundColor: SEV_DOT[severity] ?? '#8892a4',
                pointerEvents:   'none',
                zIndex:          1,
              }} />
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                style={{ ...selectBase, paddingLeft: 30 }}
                {...focusHandlers(false)}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detailed description of the incident…"
              rows={5}
              style={{ ...inputBase, minHeight: 120, resize: 'vertical' }}
              {...focusHandlers(false)}
            />
          </div>

          {/* CI Impattati */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              CI Impattati
            </label>

            {/* Badge CI selezionati */}
            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {selectedCIs.map(ci => (
                  <span key={ci.id} style={{
                    display:         'inline-flex',
                    alignItems:      'center',
                    gap:             4,
                    padding:         '3px 10px',
                    borderRadius:    999,
                    backgroundColor: '#eef2ff',
                    color:           '#4f46e5',
                    fontSize:        12,
                    fontWeight:      500,
                  }}>
                    {ci.name}
                    <button
                      type="button"
                      onClick={() => setSelectedCIs(prev => prev.filter(c => c.id !== ci.id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontSize: 14, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center' }}
                    ><X size={14} /></button>
                  </span>
                ))}
              </div>
            )}

            {/* Input ricerca */}
            <input
              type="text"
              value={ciSearch}
              onChange={e => setCiSearch(e.target.value)}
              placeholder="Cerca CI per nome (min. 2 caratteri)..."
              style={{ ...inputBase }}
              {...focusHandlers(false)}
            />

            {/* Dropdown risultati */}
            {ciResults.length > 0 && ciSearch.length >= 2 && (
              <div style={{
                border:          '1px solid #e5e7eb',
                borderRadius:    8,
                marginTop:       4,
                maxHeight:       200,
                overflowY:       'auto',
                backgroundColor: '#fff',
                boxShadow:       '0 4px 12px rgba(0,0,0,0.1)',
              }}>
                {ciResults
                  .filter(ci => !selectedCIs.find(s => s.id === ci.id))
                  .map(ci => (
                    <div
                      key={ci.id}
                      onClick={() => {
                        setSelectedCIs(prev => [...prev, { id: ci.id, name: ci.name, type: ci.type }])
                        setCiSearch('')
                      }}
                      style={{
                        padding:       '8px 12px',
                        cursor:        'pointer',
                        fontSize:      13,
                        display:       'flex',
                        justifyContent:'space-between',
                        borderBottom:  '1px solid #f1f3f9',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f7f8fb' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                    >
                      <span style={{ fontWeight: 500 }}>{ci.name}</span>
                      <span style={{ color: '#8892a4', fontSize: 11 }}>
                        {ci.type} · {ci.environment}
                      </span>
                    </div>
                  ))
                }
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid #f1f3f9', marginTop: 8, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={() => navigate('/incidents')}
              style={{ padding: '8px 20px', border: '1px solid #e5e7eb', backgroundColor: '#ffffff', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#4a5468' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#ffffff' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ padding: '8px 20px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.8 : 1 }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = '#4338ca' }}
              onMouseLeave={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = '#4f46e5' }}
            >
              {loading ? 'Creating…' : 'Create Incident'}
            </button>
          </div>

        </form>
      </div>
    </div>
  )
}
