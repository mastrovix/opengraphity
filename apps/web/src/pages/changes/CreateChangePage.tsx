import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_CHANGES, GET_ALL_CIS, GET_USERS } from '@/graphql/queries'

interface CIRef { id: string; name: string; type: string; environment?: string }
interface UserRef { id: string; name: string; email: string }

const fieldLabel: React.CSSProperties = {
  display:       'block',
  fontSize:      'var(--font-size-body)',
  fontWeight:    600,
  color:         'var(--color-slate-light)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom:  6,
}

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          '1.5px solid #e5e7eb',
  borderRadius:    8,
  fontSize:        'var(--font-size-body)',
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: '#fff',
  boxSizing:       'border-box',
  fontFamily:      "'Plus Jakarta Sans', system-ui, sans-serif",
  transition:      'border-color 150ms',
}

export function CreateChangePage() {
  const navigate = useNavigate()

  const [title, setTitle]             = useState('')
  const [description, setDescription] = useState('')
  const [ownerId, setOwnerId]         = useState<string>('')
  const [ciSearch, setCiSearch]       = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])
  const [backendError, setBackendError] = useState<string | null>(null)

  const { data: usersData } = useQuery<{ users: UserRef[] }>(GET_USERS, {
    variables: { sortField: 'name', sortDirection: 'asc' },
  })
  const users = usersData?.users ?? []

  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20 },
    skip: ciSearch.length < 2,
    fetchPolicy: 'network-only',
  })
  const ciResults = (ciData?.allCIs?.items ?? [])
    .filter(ci => !selectedCIs.find(s => s.id === ci.id))

  const [createChange, { loading }] = useMutation<{ createChange: { id: string; code: string } }>(CREATE_CHANGE, {
    refetchQueries: [{ query: GET_CHANGES, variables: { phase: null, limit: 50, offset: 0 } }],
    onCompleted: (data) => {
      toast.success(`Change ${data.createChange.code} creato`)
      navigate(`/changes/${data.createChange.id}`, { state: { refresh: true } })
    },
    onError: (err) => {
      console.error('[createChange] error', err)
      setBackendError(err.message)
      toast.error(err.message)
    },
  })

  const canSubmit = title.trim() !== '' && selectedCIs.length > 0 && !loading

  const handleSubmit = () => {
    if (!canSubmit) return
    setBackendError(null)
    void createChange({
      variables: {
        input: {
          title:         title.trim(),
          description:   description.trim() || null,
          changeOwner:   ownerId || null,
          affectedCIIds: selectedCIs.map(ci => ci.id),
        },
      },
    })
  }

  return (
    <PageContainer style={{ minHeight: '100%', backgroundColor: '#f8fafc', paddingBottom: 64 }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <button
          onClick={() => navigate('/changes')}
          style={{
            display:       'inline-flex',
            alignItems:    'center',
            gap:           5,
            background:    'none',
            border:        'none',
            cursor:        'pointer',
            fontSize:      'var(--font-size-body)',
            color:         'var(--color-slate-light)',
            marginBottom:  16,
            padding:       0,
          }}
        >
          ← Changes
        </button>

        <h1 style={{
          fontSize:      'var(--font-size-page-title)',
          fontWeight:    600,
          color:         'var(--color-slate-dark)',
          margin:        '0 0 4px',
          letterSpacing: '-0.02em',
        }}>
          Nuovo Change
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 24px' }}>
          Apri un RFC per introdurre una modifica controllata ai sistemi
        </p>

        <div style={{
          background:    '#fff',
          border:        '1px solid #e5e7eb',
          borderRadius:  12,
          padding:       '28px 32px',
          boxShadow:     '0 1px 4px rgba(0,0,0,0.06)',
        }}>
          {/* TITOLO */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              Titolo <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Es. Upgrade database produzione a PostgreSQL 16"
              style={inputBase}
              autoFocus
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
            />
          </div>

          {/* DESCRIZIONE */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>Descrizione</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Cosa stai cambiando, perché, e come lo verifichi…"
              rows={4}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
            />
          </div>

          {/* CHANGE OWNER */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>Change Owner</label>
            <select
              value={ownerId}
              onChange={e => setOwnerId(e.target.value)}
              style={inputBase}
            >
              <option value="">— Nessuno —</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          {/* CI AFFECTED */}
          <div style={{ marginBottom: 20 }}>
            <label style={fieldLabel}>
              CI Impattati <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <div style={{ position: 'relative' }}>
              <span style={{
                position:      'absolute',
                left:          12,
                top:           '50%',
                transform:     'translateY(-50%)',
                fontSize:      'var(--font-size-card-title)',
                pointerEvents: 'none',
                color:         'var(--color-slate-light)',
              }}>
                🔍
              </span>
              <input
                type="text"
                value={ciSearch}
                onChange={e => setCiSearch(e.target.value)}
                placeholder="Cerca CI per nome…"
                style={{ ...inputBase, paddingLeft: 36 }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb' }}
              />
              {ciResults.length > 0 && ciSearch.length >= 2 && (
                <div style={{
                  position:     'absolute',
                  left:         0,
                  right:        0,
                  top:          '100%',
                  marginTop:    4,
                  background:   '#fff',
                  border:       '1px solid #e5e7eb',
                  borderRadius: 8,
                  boxShadow:    '0 4px 12px rgba(0,0,0,0.1)',
                  maxHeight:    220,
                  overflowY:    'auto',
                  zIndex:       20,
                }}>
                  {ciResults.map(ci => (
                    <div
                      key={ci.id}
                      onClick={() => { setSelectedCIs(p => [...p, ci]); setCiSearch('') }}
                      style={{
                        padding:      '8px 12px',
                        cursor:       'pointer',
                        display:      'flex',
                        alignItems:   'center',
                        gap:          8,
                        borderBottom: '1px solid #f3f4f6',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
                    >
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>
                        {ci.name}
                      </span>
                      <span style={{
                        fontSize:        'var(--font-size-body)',
                        padding:         '1px 6px',
                        borderRadius:    4,
                        backgroundColor: '#f3f4f6',
                        color:           'var(--color-slate)',
                      }}>
                        {ci.type}{ci.environment ? ` · ${ci.environment}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {selectedCIs.map(ci => (
                  <span
                    key={ci.id}
                    style={{
                      display:     'inline-flex',
                      alignItems:  'center',
                      gap:         6,
                      padding:     '4px 10px',
                      borderRadius: 6,
                      background:  'var(--color-brand-light)',
                      border:      '1px solid #c7d2fe',
                      color:       'var(--color-brand-hover)',
                      fontSize:    'var(--font-size-body)',
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{ci.name}</span>
                    <span style={{ opacity: 0.7, fontSize: 'var(--font-size-label)' }}>
                      {ci.type}{ci.environment ? ` · ${ci.environment}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedCIs(p => p.filter(c => c.id !== ci.id))}
                      style={{
                        background: 'none',
                        border:     'none',
                        cursor:     'pointer',
                        color:      'var(--color-brand-hover)',
                        padding:    0,
                        lineHeight: 1,
                        display:    'flex',
                        alignItems: 'center',
                        opacity:    0.7,
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <p style={{
              fontSize:  'var(--font-size-label)',
              color:     'var(--color-slate-light)',
              margin:    '8px 0 0',
            }}>
              Ogni CI deve avere Owner Group e Support Group configurati, altrimenti la creazione fallirà.
            </p>
          </div>

          {/* Backend error banner */}
          {backendError && (
            <div style={{
              marginBottom:    20,
              padding:         '10px 14px',
              borderRadius:    8,
              background:      '#fef2f2',
              border:          '1.5px solid var(--color-danger)',
              color:           'var(--color-trigger-sla-breach)',
              fontSize:        'var(--font-size-body)',
              fontWeight:      500,
            }}>
              {backendError}
            </div>
          )}

          {/* Footer */}
          <div style={{
            borderTop:      '1px solid #f3f4f6',
            marginTop:      8,
            paddingTop:     20,
            display:        'flex',
            justifyContent: 'space-between',
            alignItems:     'center',
          }}>
            <button
              type="button"
              onClick={() => navigate('/changes')}
              style={{
                background: 'none',
                border:     'none',
                cursor:     'pointer',
                fontSize:   'var(--font-size-body)',
                color:      'var(--color-slate)',
                padding:    0,
              }}
            >
              Annulla
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              style={{
                background:   'var(--color-brand)',
                color:        '#fff',
                border:       'none',
                borderRadius: 8,
                padding:      '10px 24px',
                fontSize:     'var(--font-size-card-title)',
                fontWeight:   600,
                cursor:       canSubmit ? 'pointer' : 'not-allowed',
                opacity:      canSubmit ? 1 : 0.5,
                transition:   'opacity 150ms',
              }}
            >
              {loading ? 'Creazione…' : 'Crea Change'}
            </button>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}
