import { useState, useEffect } from 'react'
import { useMutation, useQuery, useLazyQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, X } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_ALL_CIS, GET_CHANGE_IMPACT } from '@/graphql/queries'
import { ImpactPanel } from '@/components/ImpactPanel'
import type { ImpactAnalysis } from '@/components/ImpactPanel'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CI { id: string; name: string; type: string; environment: string; status: string }

// ── Config ────────────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  standard:  { label: 'Standard Change',  desc: 'Pre-approvato, basso rischio',        color: '#16a34a', bg: '#f0fdf4', border: '#86efac', icon: '✅' },
  normal:    { label: 'Normal Change',     desc: 'Assessment CI e approvazione CAB',     color: '#2563eb', bg: '#eff6ff', border: '#93c5fd', icon: '🔵' },
  emergency: { label: 'Emergency Change',  desc: 'Fast-track, solo admin/operator',      color: 'var(--color-trigger-sla-breach)', bg: '#fef2f2', border: '#fca5a5', icon: '🔴' },
} as const

const PRIORITY_CONFIG = [
  { value: 'critical', label: 'Critical', color: 'var(--color-trigger-sla-breach)', bg: '#fef2f2', border: 'var(--color-danger)' },
  { value: 'high',     label: 'High',     color: 'var(--color-brand)', bg: '#fff7ed', border: 'var(--color-brand)' },
  { value: 'medium',   label: 'Medium',   color: '#b45309', bg: '#fefce8', border: 'var(--color-warning)' },
  { value: 'low',      label: 'Low',      color: '#15803d', bg: '#f0fdf4', border: 'var(--color-success)' },
]

const STEPS = ['Tipo', 'Dettagli', 'Riepilogo'] as const

// ── Shared styles ─────────────────────────────────────────────────────────────

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

function onFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)'
}
function onBlur(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb'
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
      {STEPS.map((name, i) => {
        const done   = i < current
        const active = i === current
        return (
          <div key={name} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : undefined }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backgroundColor: done || active ? 'var(--color-brand)' : '#e5e7eb',
                color: done || active ? '#fff' : 'var(--color-slate-light)',
                fontSize: 12, fontWeight: 700, flexShrink: 0,
              }}>
                {done ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 12, fontWeight: active ? 600 : 400, color: active ? 'var(--color-brand)' : done ? 'var(--color-brand)' : 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
                {name}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 1, backgroundColor: done ? 'var(--color-brand)' : '#e5e7eb', margin: '0 8px', marginBottom: 18 }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Summary row ───────────────────────────────────────────────────────────────

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: 150, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 14, color: 'var(--color-slate)' }}>{value}</span>
    </div>
  )
}

// ── Nav buttons ───────────────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-slate)', padding: 0 }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
    >
      <ArrowLeft size={13} /> Indietro
    </button>
  )
}

function NextBtn({ onClick, label = 'Avanti →', disabled = false }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ padding: '10px 24px', backgroundColor: 'var(--color-brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.7 : 1 }}
    >
      {label}
    </button>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CreateChangePage() {
  const navigate = useNavigate()

  const [step,           setStep]          = useState(0)
  const [changeType,     setChangeType]    = useState<keyof typeof TYPE_CONFIG>('normal')
  const [title,          setTitle]         = useState('')
  const [description,    setDescription]   = useState('')
  const [priority,       setPriority]      = useState('medium')
  const [ciSearch,       setCiSearch]      = useState('')
  const [selectedCIs,    setSelectedCIs]   = useState<CI[]>([])
  const [emergencyReason, setEmergencyReason] = useState('')
  const [submitted,      setSubmitted]     = useState(false)

  const { data: cisData } = useQuery<{ allCIs: { items: CI[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch || null, limit: 20 },
    skip: ciSearch.length < 2,
  })

  const [getImpact, { data: impactData }] = useLazyQuery<{ changeImpactAnalysis: ImpactAnalysis }>(GET_CHANGE_IMPACT)

  useEffect(() => {
    if (selectedCIs.length >= 1) {
      void getImpact({ variables: { ciIds: selectedCIs.map(c => c.id) } })
    }
  }, [selectedCIs, getImpact])

  const [createChange, { loading }] = useMutation<{ createChange: { id: string } }>(CREATE_CHANGE, {
    onCompleted: (data) => {
      toast.success('Change creato')
      navigate(`/changes/${data.createChange.id}`)
    },
    onError: (e) => toast.error(e.message),
  })

  const availableCIs     = (cisData?.allCIs?.items ?? []).filter(ci => !selectedCIs.find(s => s.id === ci.id))
  const titleMissing     = !title.trim()
  const emergencyMissing = changeType === 'emergency' && !emergencyReason.trim()
  const step2Valid       = !titleMissing && !emergencyMissing

  function handleNext() {
    if (step === 1) {
      setSubmitted(true)
      if (!step2Valid) return
    }
    setStep(s => s + 1)
  }

  function handleSubmit() {
    void createChange({
      variables: {
        input: {
          title:         title.trim(),
          description:   description.trim() || null,
          type:          changeType,
          priority,
          affectedCIIds: selectedCIs.map(c => c.id),
        },
      },
    })
  }

  const typeConf = TYPE_CONFIG[changeType]
  const prioConf = PRIORITY_CONFIG.find(p => p.value === priority)!

  return (
    <div style={{ minHeight: '100%', backgroundColor: '#f8fafc', padding: '32px 16px 64px' }}>
      <div style={{ maxWidth: 580, margin: '0 auto' }}>

        {/* Header */}
        <button
          onClick={() => navigate('/changes')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
        >
          ← Changes
        </button>

        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          Nuovo Change
        </h1>
        <p style={{ fontSize: 14, color: 'var(--color-slate)', margin: '0 0 24px' }}>
          Compila i dettagli del change da aprire
        </p>

        <ProgressBar current={step} />

        {/* ── STEP 1: Tipo ───────────────────────────────────────────────────── */}
        {step === 0 && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '28px 32px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <label style={{ ...fieldLabel, marginBottom: 12 }}>
              Tipo di Change <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>

            {(Object.keys(TYPE_CONFIG) as Array<keyof typeof TYPE_CONFIG>).map(t => {
              const c   = TYPE_CONFIG[t]
              const sel = changeType === t
              return (
                <div
                  key={t}
                  onClick={() => setChangeType(t)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 16px', borderRadius: 8, marginBottom: 8,
                    border: `1.5px solid ${sel ? c.border : '#e5e7eb'}`,
                    background: sel ? c.bg : '#fff',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: sel ? c.color : '#d1d5db' }} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: sel ? c.color : 'var(--color-slate)' }}>{c.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 2 }}>{c.desc}</div>
                  </div>
                </div>
              )
            })}

            <div style={{ borderTop: '1px solid #f3f4f6', marginTop: 16, paddingTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
              <NextBtn onClick={handleNext} />
            </div>
          </div>
        )}

        {/* ── STEP 2: Dettagli ───────────────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '28px 32px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

            {/* TITOLO */}
            <div style={{ marginBottom: 20 }}>
              <label style={fieldLabel}>Titolo <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
              <input
                type="text"
                value={title}
                onChange={e => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
                placeholder="Es. Aggiornamento certificati SSL"
                style={{ ...inputBase, borderColor: submitted && titleMissing ? 'var(--color-trigger-sla-breach)' : '#e5e7eb' }}
                autoFocus
                onFocus={onFocus}
                onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = submitted && titleMissing ? 'var(--color-trigger-sla-breach)' : '#e5e7eb' }}
              />
              {submitted && titleMissing && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-trigger-sla-breach)' }}>Campo obbligatorio</p>}
            </div>

            {/* DESCRIZIONE */}
            <div style={{ marginBottom: 20 }}>
              <label style={fieldLabel}>
                Descrizione{' '}
                <span style={{ fontSize: 10, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#b0b8c5' }}>(opzionale)</span>
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Descrizione opzionale…"
                rows={3}
                style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>

            {/* PRIORITÀ */}
            <div style={{ marginBottom: 20 }}>
              <label style={fieldLabel}>Priorità <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {PRIORITY_CONFIG.map(p => {
                  const sel = priority === p.value
                  return (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPriority(p.value)}
                      style={{
                        padding: '7px 16px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                        border: `1.5px solid ${sel ? p.border : '#e5e7eb'}`,
                        background: sel ? p.bg : '#f8fafc',
                        color: sel ? p.color : 'var(--color-slate)',
                        fontWeight: sel ? 600 : 400,
                        transition: 'all 0.15s',
                      }}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* CI IMPATTATI */}
            <div style={{ marginBottom: 20 }}>
              <label style={fieldLabel}>
                CI Impattati{' '}
                <span style={{ fontSize: 10, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#b0b8c5' }}>(opzionale)</span>
              </label>

              {selectedCIs.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {selectedCIs.map(ci => (
                    <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-brand-light)', border: '1px solid #c7d2fe', color: 'var(--color-brand-hover)', fontSize: 12 }}>
                      {ci.name}
                      <button type="button" onClick={() => setSelectedCIs(s => s.filter(x => x.id !== ci.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand-hover)', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none', color: 'var(--color-slate-light)' }}>🔍</span>
                <input
                  value={ciSearch}
                  onChange={e => setCiSearch(e.target.value)}
                  style={{ ...inputBase, paddingLeft: 36 }}
                  placeholder="Cerca per nome..."
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
                {availableCIs.length > 0 && (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 4, backgroundColor: '#fff', maxHeight: 180, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 10 }}>
                    {availableCIs.map(ci => (
                      <div
                        key={ci.id}
                        onClick={() => { setSelectedCIs(s => [...s, ci]); setCiSearch('') }}
                        style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #f3f4f6', fontSize: 14 }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                      >
                        <span style={{ fontWeight: 500, flex: 1 }}>{ci.name}</span>
                        <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 4, backgroundColor: '#f3f4f6', color: 'var(--color-slate)' }}>{ci.type}{ci.environment ? ` · ${ci.environment}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {impactData?.changeImpactAnalysis && (
                <div style={{ marginTop: 12 }}>
                  <ImpactPanel analysis={impactData.changeImpactAnalysis} compact={true} />
                </div>
              )}
            </div>

            {/* MOTIVO EMERGENZA */}
            {changeType === 'emergency' && (
              <div style={{ marginBottom: 20 }}>
                <label style={fieldLabel}>Motivo Emergenza <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
                <textarea
                  value={emergencyReason}
                  onChange={e => setEmergencyReason(e.target.value)}
                  placeholder="Descrivi il motivo per cui è necessario un cambiamento d'emergenza…"
                  rows={3}
                  style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6, borderColor: submitted && emergencyMissing ? 'var(--color-trigger-sla-breach)' : '#e5e7eb', backgroundColor: '#fffbeb' }}
                  onFocus={onFocus}
                  onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = submitted && emergencyMissing ? 'var(--color-trigger-sla-breach)' : '#e5e7eb' }}
                />
                {submitted && emergencyMissing && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-trigger-sla-breach)' }}>Campo obbligatorio per Emergency Change</p>}
              </div>
            )}

            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <BackBtn onClick={() => setStep(0)} />
              <NextBtn onClick={handleNext} />
            </div>
          </div>
        )}

        {/* ── STEP 3: Riepilogo ──────────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '28px 32px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <h2 style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 16px' }}>
                Riepilogo
              </h2>

              <SummaryRow label="Tipo" value={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 100, backgroundColor: typeConf.bg, color: typeConf.color, fontSize: 12, fontWeight: 600 }}>
                  {typeConf.icon} {typeConf.label}
                </span>
              } />
              <SummaryRow label="Titolo" value={title} />
              <SummaryRow label="Descrizione" value={description || '—'} />
              <SummaryRow label="Priorità" value={
                <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 100, backgroundColor: prioConf.bg, color: prioConf.color, fontSize: 12, fontWeight: 600 }}>
                  {prioConf.label}
                </span>
              } />
              <SummaryRow label="CI Impattati" value={
                selectedCIs.length === 0 ? '—' : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selectedCIs.map(ci => (
                      <span key={ci.id} style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 100, backgroundColor: 'var(--color-brand-light)', color: 'var(--color-brand-hover)', fontSize: 12, fontWeight: 500 }}>
                        {ci.name}
                      </span>
                    ))}
                  </div>
                )
              } />
              {changeType === 'emergency' && (
                <SummaryRow label="Motivo Emergenza" value={<span style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{emergencyReason}</span>} />
              )}

              <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20, marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <BackBtn onClick={() => setStep(1)} />
                <NextBtn onClick={handleSubmit} label={loading ? 'Creazione…' : '✓ Crea Change'} disabled={loading} />
              </div>
            </div>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button type="button" onClick={() => navigate('/changes')} style={{ background: 'none', border: 'none', fontSize: 14, color: 'var(--color-slate)', cursor: 'pointer' }}>
                Annulla
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
