import { useState, useEffect } from 'react'
import { useMutation, useQuery, useLazyQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_INCIDENTS, GET_CIS_SEARCH, GET_CHANGE_IMPACT } from '@/graphql/queries'
import { ImpactPanel } from '@/components/ImpactPanel'
import type { ImpactAnalysis } from '@/components/ImpactPanel'

interface CI { id: string; name: string; type: string; environment: string; status: string }
interface Incident { id: string; title: string; status: string; severity: string }

const TYPE_NOTES: Record<string, string> = {
  standard:  'Verrà approvato automaticamente.',
  normal:    'Richiederà approvazione CAB.',
  emergency: 'Richiederà approvazione fast-track — solo admin/operator.',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: '#8892a4',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'block',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 7,
  fontSize: 13, color: '#0f1629', outline: 'none', backgroundColor: '#f9fafb',
  boxSizing: 'border-box',
}
const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit',
}

export function CreateChangePage() {
  const navigate = useNavigate()

  const [title, setTitle]             = useState('')
  const [type, setType]               = useState('normal')
  const [priority, setPriority]       = useState('medium')
  const [description, setDescription] = useState('')
  const [rollbackPlan, setRollback]   = useState('')
  const [ciSearch, setCiSearch]       = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CI[]>([])
  const [selectedIncidents, setSelectedIncidents] = useState<Incident[]>([])

  const [getImpact, { data: impactData }] = useLazyQuery<{ changeImpactAnalysis: ImpactAnalysis }>(GET_CHANGE_IMPACT)

  useEffect(() => {
    if (selectedCIs.length >= 1) {
      getImpact({ variables: { ciIds: selectedCIs.map((c) => c.id) } })
    }
  }, [selectedCIs, getImpact])

  const { data: cisData } = useQuery<{ configurationItems: CI[] }>(GET_CIS_SEARCH, {
    variables: { search: ciSearch || null },
    skip: ciSearch.length < 2,
  })
  const { data: incData } = useQuery<{ incidents: Incident[] }>(GET_INCIDENTS)

  const [createChange, { loading }] = useMutation<{
    createChange: { id: string; title: string; type: string; status: string; workflowInstance: { id: string; currentStep: string } | null }
  }>(CREATE_CHANGE, {
    onCompleted: (data) => {
      toast.success('Change creato')
      navigate(`/changes/${data.createChange.id}`)
    },
    onError: (e) => toast.error(e.message),
  })

  const valid = title.trim().length > 0 && rollbackPlan.trim().length >= 20

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    createChange({
      variables: {
        input: {
          title:              title.trim(),
          description:        description.trim() || null,
          type,
          priority,
          rollbackPlan:       rollbackPlan.trim(),
          affectedCIIds:      selectedCIs.map((c) => c.id),
          relatedIncidentIds: selectedIncidents.map((i) => i.id),
        },
      },
    })
  }

  const availableCIs = (cisData?.configurationItems ?? []).filter((ci) => !selectedCIs.find((s) => s.id === ci.id))
  const availableIncidents = (incData?.incidents ?? []).filter((i) => !selectedIncidents.find((s) => s.id === i.id))

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => navigate('/changes')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontSize: 13, padding: 0, marginBottom: 12 }}
        >
          ← Torna ai Changes
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>Nuovo Change</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Title */}
          <div>
            <label style={labelStyle}>Titolo *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} placeholder="Es. Aggiornamento certificati SSL" required />
          </div>

          {/* Type + Priority */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Tipo *</label>
              <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
                <option value="standard">Standard</option>
                <option value="normal">Normal</option>
                <option value="emergency">Emergency</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Priorità *</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          {/* Type note */}
          <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 7, padding: '10px 14px', fontSize: 13, color: '#4a5468' }}>
            ℹ️ {TYPE_NOTES[type]}
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Descrizione</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={textareaStyle} placeholder="Descrizione opzionale…" />
          </div>

          {/* Rollback Plan */}
          <div>
            <label style={labelStyle}>Piano di Rollback * <span style={{ color: '#8892a4', fontWeight: 400, textTransform: 'none' }}>(min. 20 caratteri)</span></label>
            <textarea
              value={rollbackPlan}
              onChange={(e) => setRollback(e.target.value)}
              style={{ ...textareaStyle, minHeight: 100, borderColor: rollbackPlan.length > 0 && rollbackPlan.length < 20 ? '#ef4444' : '#e5e7eb' }}
              placeholder="Descrivi i passi per ripristinare il sistema allo stato precedente…"
            />
            {rollbackPlan.length > 0 && rollbackPlan.length < 20 && (
              <span style={{ fontSize: 12, color: '#ef4444', marginTop: 4, display: 'block' }}>Almeno 20 caratteri richiesti ({rollbackPlan.length}/20)</span>
            )}
          </div>

          {/* CI Affected */}
          <div>
            <label style={labelStyle}>CI Impattati</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {selectedCIs.map((ci) => (
                <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#eff6ff', color: '#4f46e5', padding: '4px 10px', borderRadius: 100, fontSize: 12, fontWeight: 500 }}>
                  {ci.name} <span style={{ opacity: 0.7, fontSize: 10 }}>({ci.type})</span>
                  <button type="button" onClick={() => setSelectedCIs((s) => s.filter((x) => x.id !== ci.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', padding: 0, lineHeight: 1, fontSize: 14, display: 'flex', alignItems: 'center' }}><X size={14} /></button>
                </span>
              ))}
            </div>
            <input
              value={ciSearch}
              onChange={(e) => setCiSearch(e.target.value)}
              style={inputStyle}
              placeholder="Cerca CI per nome…"
            />
            {availableCIs.length > 0 && (
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 7, marginTop: 4, backgroundColor: '#fff', maxHeight: 180, overflowY: 'auto' }}>
                {availableCIs.map((ci) => (
                  <div
                    key={ci.id}
                    onClick={() => { setSelectedCIs((s) => [...s, ci]); setCiSearch('') }}
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f3f8', fontSize: 13 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f9fafb' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '' }}
                  >
                    <span style={{ fontWeight: 500 }}>{ci.name}</span>
                    <span style={{ color: '#8892a4', fontSize: 11, marginLeft: 8 }}>{ci.type} · {ci.environment}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Impact Analysis Preview */}
          {impactData?.changeImpactAnalysis && (
            <div>
              <label style={labelStyle}>Impact Analysis</label>
              <ImpactPanel analysis={impactData.changeImpactAnalysis} compact={true} />
            </div>
          )}

          {/* Related Incidents */}
          <div>
            <label style={labelStyle}>Incident Correlati</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {selectedIncidents.map((inc) => (
                <span key={inc.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#fef2f2', color: '#dc2626', padding: '4px 10px', borderRadius: 100, fontSize: 12, fontWeight: 500 }}>
                  {inc.title.slice(0, 30)}{inc.title.length > 30 ? '…' : ''}
                  <button type="button" onClick={() => setSelectedIncidents((s) => s.filter((x) => x.id !== inc.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0, lineHeight: 1, fontSize: 14, display: 'flex', alignItems: 'center' }}><X size={14} /></button>
                </span>
              ))}
            </div>
            <select
              onChange={(e) => {
                const inc = availableIncidents.find((i) => i.id === e.target.value)
                if (inc) { setSelectedIncidents((s) => [...s, inc]); e.target.value = '' }
              }}
              style={inputStyle}
              defaultValue=""
            >
              <option value="" disabled>Seleziona incident da collegare…</option>
              {availableIncidents.map((inc) => (
                <option key={inc.id} value={inc.id}>{inc.title}</option>
              ))}
            </select>
          </div>

          {/* Submit */}
          <div style={{ display: 'flex', gap: 12, paddingTop: 4 }}>
            <button
              type="submit"
              disabled={!valid || loading}
              style={{ flex: 1, padding: '10px 0', backgroundColor: valid && !loading ? '#4f46e5' : '#e5e7eb', color: valid && !loading ? '#fff' : '#8892a4', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: valid && !loading ? 'pointer' : 'not-allowed' }}
            >
              {loading ? 'Creazione…' : 'Crea Change'}
            </button>
            <button type="button" onClick={() => navigate('/changes')} style={{ padding: '10px 20px', backgroundColor: '#fff', color: '#4a5468', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>
              Annulla
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
