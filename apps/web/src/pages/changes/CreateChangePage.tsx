import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_CHANGES } from '@/graphql/queries'

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          '1px solid #e2e6f0',
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
  appearance:         'none',
  backgroundImage:    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat:   'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight:       36,
  cursor:             'pointer',
}

function focusHandlers(hasError: boolean) {
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = '#4f46e5'
      e.currentTarget.style.boxShadow   = '0 0 0 3px #eef2ff'
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? '#dc2626' : '#e2e6f0'
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

const RISK_DOT: Record<string, string> = {
  high:   '#dc2626',
  medium: '#d97706',
  low:    '#059669',
}

const TYPE_DOT: Record<string, string> = {
  emergency: '#dc2626',
  normal:    '#0284c7',
  standard:  '#8892a4',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateChangePage() {
  const navigate = useNavigate()

  const [form, setForm] = useState({
    title:       '',
    description: '',
    type:        'normal',
    risk:        'medium',
    windowStart: '',
    windowEnd:   '',
  })
  const [submitted, setSubmitted] = useState(false)

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }))

  const titleError = submitted && !form.title.trim() ? 'This field is required' : ''

  const [createChange, { loading }] = useMutation(CREATE_CHANGE, {
    refetchQueries: [{ query: GET_CHANGES }],
    onCompleted: () => { toast.success('Change request submitted'); navigate('/changes') },
    onError:     (err) => toast.error(err.message),
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!form.title.trim()) return
    await createChange({
      variables: {
        input: {
          title:       form.title.trim(),
          description: form.description || undefined,
          type:        form.type,
          risk:        form.risk,
          windowStart: form.windowStart ? new Date(form.windowStart).toISOString() : undefined,
          windowEnd:   form.windowEnd   ? new Date(form.windowEnd).toISOString()   : undefined,
        },
      },
    })
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', paddingTop: 32 }}>

      {/* Back link */}
      <button
        onClick={() => navigate('/changes')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#8892a4', marginBottom: 32, padding: 0 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#4f46e5' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8892a4' }}
      >
        <ArrowLeft size={14} />
        Back to changes
      </button>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.02em', margin: 0 }}>
          New Change Request
        </h1>
        <p style={{ fontSize: 14, color: '#8892a4', marginTop: 6, marginBottom: 0 }}>
          Submit a change for review and approval
        </p>
      </div>

      {/* Form card */}
      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e6f0', borderRadius: 12, padding: 32 }}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Title */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Title <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => { set('title', e.target.value); if (submitted) setSubmitted(false) }}
              placeholder="Brief description of the change"
              style={{ ...inputBase, borderColor: titleError ? '#dc2626' : '#e2e6f0' }}
              {...focusHandlers(!!titleError)}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626' }}>{titleError}</p>
            )}
          </div>

          {/* Type + Risk in grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>

            {/* Type */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
                Type <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 8, height: 8, borderRadius: '50%', backgroundColor: TYPE_DOT[form.type] ?? '#8892a4', pointerEvents: 'none', zIndex: 1 }} />
                <select value={form.type} onChange={(e) => set('type', e.target.value)} style={{ ...selectBase, paddingLeft: 30 }} {...focusHandlers(false)}>
                  <option value="standard">Standard</option>
                  <option value="normal">Normal</option>
                  <option value="emergency">Emergency</option>
                </select>
              </div>
            </div>

            {/* Risk */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
                Risk <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 8, height: 8, borderRadius: '50%', backgroundColor: RISK_DOT[form.risk] ?? '#8892a4', pointerEvents: 'none', zIndex: 1 }} />
                <select value={form.risk} onChange={(e) => set('risk', e.target.value)} style={{ ...selectBase, paddingLeft: 30 }} {...focusHandlers(false)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>

          </div>

          {/* Intervention window */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Intervention Window
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <p style={{ fontSize: 12, color: '#8892a4', margin: '0 0 4px' }}>From</p>
                <input
                  type="datetime-local"
                  value={form.windowStart}
                  onChange={(e) => set('windowStart', e.target.value)}
                  style={inputBase}
                  {...focusHandlers(false)}
                />
              </div>
              <div>
                <p style={{ fontSize: 12, color: '#8892a4', margin: '0 0 4px' }}>To</p>
                <input
                  type="datetime-local"
                  value={form.windowEnd}
                  onChange={(e) => set('windowEnd', e.target.value)}
                  style={inputBase}
                  {...focusHandlers(false)}
                />
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: 0 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#4a5468', marginBottom: 6, letterSpacing: '0.01em' }}>
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Describe the change, its scope and expected impact…"
              rows={4}
              style={{ ...inputBase, minHeight: 120, resize: 'vertical' }}
              {...focusHandlers(false)}
            />
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid #f1f3f9', marginTop: 32, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={() => navigate('/changes')}
              style={{ padding: '8px 20px', border: '1px solid #e2e6f0', backgroundColor: '#ffffff', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#4a5468' }}
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
              {loading ? 'Submitting…' : 'Submit Change'}
            </button>
          </div>

        </form>
      </div>
    </div>
  )
}
