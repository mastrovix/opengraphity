import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          '1px solid #e2e6f0',
  borderRadius:    6,
  fontSize:        14,
  color:           'var(--color-slate-dark)',
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
      e.currentTarget.style.borderColor = 'var(--color-brand)'
      e.currentTarget.style.boxShadow   = '0 0 0 3px #ecfeff'
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? 'var(--color-trigger-sla-breach)' : '#e2e6f0'
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

const PRIORITY_DOT: Record<string, string> = {
  critical: 'var(--color-trigger-sla-breach)',
  high:     'var(--color-trigger-timer)',
  medium:   'var(--color-brand)',
  low:      'var(--color-slate-light)',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateServiceRequestPage() {
  const navigate = useNavigate()

  const [title, setTitle]           = useState('')
  const [priority, setPriority]     = useState('medium')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate]       = useState('')
  const { values: priorityValues, loading: priorityLoading } = useEnumValues('service_request', 'priority')
  const [submitted, setSubmitted]   = useState(false)

  const titleError = submitted && !title.trim() ? 'This field is required' : ''

  const [createRequest, { loading }] = useMutation(CREATE_SERVICE_REQUEST, {
    refetchQueries: [{ query: GET_SERVICE_REQUESTS }],
    onCompleted: () => { toast.success('Service request created'); navigate('/requests') },
    onError:     (err) => toast.error(err.message),
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!title.trim()) return
    await createRequest({
      variables: {
        input: {
          title:       title.trim(),
          priority,
          description: description || undefined,
        },
      },
    })
  }

  return (
    <PageContainer>

      {/* Back link */}
      <button
        onClick={() => navigate('/requests')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 32, padding: 0 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
      >
        <ArrowLeft size={14} />
        Back to service requests
      </button>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.02em', margin: 0 }}>
          New Service Request
        </h1>
        <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginTop: 6, marginBottom: 0 }}>
          Submit a request for IT services or support
        </p>
      </div>

      {/* Form card */}
      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e6f0', borderRadius: 12, padding: 32 }}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Title */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              Title <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
              placeholder="What do you need?"
              style={{ ...inputBase, borderColor: titleError ? 'var(--color-trigger-sla-breach)' : '#e2e6f0' }}
              {...focusHandlers(!!titleError)}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-trigger-sla-breach)' }}>{titleError}</p>
            )}
          </div>

          {/* Priority + Due date in grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>

            {/* Priority */}
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                Priority <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 8, height: 8, borderRadius: '50%', backgroundColor: PRIORITY_DOT[priority] ?? 'var(--color-slate-light)', pointerEvents: 'none', zIndex: 1 }} />
                <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={priorityLoading} style={{ ...selectBase, paddingLeft: 30 }} {...focusHandlers(false)}>
                  {priorityLoading
                    ? <option value="">Caricamento…</option>
                    : priorityValues.map(v => (
                        <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                      ))
                  }
                </select>
              </div>
            </div>

            {/* Due date */}
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={inputBase}
                {...focusHandlers(false)}
              />
            </div>

          </div>

          {/* Description */}
          <div style={{ marginBottom: 0 }}>
            <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what you need and why…"
              rows={4}
              style={{ ...inputBase, minHeight: 120, resize: 'vertical' }}
              {...focusHandlers(false)}
            />
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid #f1f3f9', marginTop: 32, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={() => navigate('/requests')}
              style={{ padding: '8px 20px', border: '1px solid #e2e6f0', backgroundColor: '#ffffff', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', color: 'var(--color-slate)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#ffffff' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ padding: '8px 20px', backgroundColor: 'var(--color-brand)', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.8 : 1 }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand-hover)' }}
              onMouseLeave={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand)' }}
            >
              {loading ? 'Creating…' : 'Create Request'}
            </button>
          </div>

        </form>
      </div>
    </PageContainer>
  )
}
