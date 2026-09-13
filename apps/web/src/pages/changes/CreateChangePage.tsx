import { useId, useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_CHANGES, GET_ALL_CIS, GET_USERS, GET_PROBLEM, GET_INCIDENT } from '@/graphql/queries'
import { colors, palette } from '@/lib/tokens'

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
  border:          '1.5px solid var(--color-border)',
  borderRadius:    8,
  fontSize:        'var(--font-size-body)',
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: colors.white,
  boxSizing:       'border-box',
  fontFamily:      "'Plus Jakarta Sans', system-ui, sans-serif",
  transition:      'border-color 150ms',
}

export function CreateChangePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ids = { title: useId(), why: useId(), what: useId(), owner: useId(), ciSearch: useId() }
  const [searchParams] = useSearchParams()
  const problemId  = searchParams.get('problemId')
  const incidentId = searchParams.get('incidentId')

  // RFC richiesta da un problem o da un incident: precarica CI e titolo.
  const { data: problemData } = useQuery<{ problem: { id: string; number: string; title: string; affectedCIs: CIRef[] } | null }>(
    GET_PROBLEM, { variables: { id: problemId }, skip: !problemId },
  )
  const { data: incidentData } = useQuery<{ incident: { id: string; number: string; title: string; affectedCIs: CIRef[] } | null }>(
    GET_INCIDENT, { variables: { id: incidentId }, skip: !incidentId },
  )
  // Sorgente unificata della richiesta (problem oppure incident).
  const requestSource = problemData?.problem
    ? { kind: 'problem' as const, ...problemData.problem }
    : incidentData?.incident
    ? { kind: 'incident' as const, ...incidentData.incident }
    : null
  const [prefilled, setPrefilled] = useState(false)

  const [title, setTitle]             = useState('')
  const [why, setWhy]                 = useState('')
  const [what, setWhat]               = useState('')
  // NB: nessun campo rollback qui — il rollback è una domanda scored
  // dell'assessment tecnico ("Is a tested rollback plan available?").
  const [changeType, setChangeType]   = useState<'standard'|'normal'|'emergency'>('normal')
  const [ownerId, setOwnerId]         = useState<string>('')
  const [ciSearch, setCiSearch]       = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])
  const [backendError, setBackendError] = useState<string | null>(null)

  // Precompila una volta con i dati dell'entità richiedente.
  useEffect(() => {
    if (requestSource && !prefilled) {
      setSelectedCIs((requestSource.affectedCIs ?? []).map((ci) => ({ id: ci.id, name: ci.name, type: ci.type, environment: ci.environment })))
      const label = requestSource.kind === 'problem' ? 'problem' : 'incident'
      setTitle(t('pages.createChange.resolutionTitle', { kind: label, number: requestSource.number, title: requestSource.title }))
      setPrefilled(true)
    }
  }, [requestSource, prefilled, t])

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
      toast.success(t('toast.change.created', { code: data.createChange.code }))
      navigate(`/changes/${data.createChange.id}`, { state: { refresh: true } })
    },
    onError: (err) => {
      console.error('[createChange] error', err)
      setBackendError(err.message)
      toast.error(err.message)
    },
  })

  const canSubmit = title.trim() !== '' && why.trim() !== '' && what.trim() !== '' && selectedCIs.length > 0 && !loading

  const handleSubmit = () => {
    if (!canSubmit) return
    setBackendError(null)
    void createChange({
      variables: {
        input: {
          title:         title.trim(),
          why:           why.trim(),
          what:          what.trim(),
          changeOwner:   ownerId || null,
          affectedCIIds: selectedCIs.map(ci => ci.id),
          changeType,
          ...(problemId ? { problemId } : {}),
          ...(incidentId ? { incidentId } : {}),
        },
      },
    })
  }

  return (
    <PageContainer style={{ minHeight: '100%', backgroundColor: 'var(--color-slate-bg)', paddingBottom: 64 }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <button
          type="button"
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
          {t('pages.createChange.title')}
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 24px' }}>
          {t('pages.createChange.subtitle')}
        </p>

        {requestSource && (
          <div style={{ background: 'var(--color-brand-light)', border: '1px solid var(--color-brand)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
            {t(requestSource.kind === 'problem' ? 'pages.createChange.rfcForProblem' : 'pages.createChange.rfcForIncident',
               { number: requestSource.number, title: requestSource.title })}
            {' '}{t(requestSource.kind === 'problem' ? 'pages.createChange.rfcProblemNote' : 'pages.createChange.rfcIncidentNote')}
            {' '}{t('pages.createChange.affectedCIsPreloaded')}
          </div>
        )}

        <div style={{
          background:    colors.white,
          border:        '1px solid var(--color-border)',
          borderRadius:  12,
          padding:       '28px 32px',
          boxShadow:     '0 1px 4px var(--color-black-a06)',
        }}>
          {/* TITOLO */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.title} style={fieldLabel}>
              {t('common.title')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              id={ids.title}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('pages.createChange.titlePlaceholder')}
              style={inputBase}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </div>

          {/* TIPO DI CHANGE */}
          <div style={{ marginBottom: 20 }}>
            <div style={fieldLabel}>{t('pages.createChange.changeType')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['standard','normal','emergency'] as const).map(tipo => {
                const sel = changeType === tipo
                const labels = { standard: t('pages.createChange.typeStandard'), normal: 'Normal', emergency: 'Emergency' }
                return (
                  <button key={tipo} type="button" onClick={() => setChangeType(tipo)}
                    style={{ padding: '7px 14px', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer',
                      border: `1.5px solid ${sel ? 'var(--color-brand)' : 'var(--color-border)'}`,
                      background: sel ? palette.info.light : 'var(--color-slate-bg)',
                      color: sel ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: sel ? 600 : 400 }}>
                    {labels[tipo]}
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 6 }}>
              {t('pages.createChange.typesNote')}
            </p>
          </div>

          {/* WHY (Perché) */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.why} style={fieldLabel}>{t('pages.createChange.why')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
            <textarea
              id={ids.why}
              value={why}
              onChange={e => setWhy(e.target.value)}
              placeholder={t('pages.createChange.whyPlaceholder')}
              rows={3}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </div>

          {/* WHAT (Cosa) */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.what} style={fieldLabel}>{t('pages.createChange.what')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></label>
            <textarea
              id={ids.what}
              value={what}
              onChange={e => setWhat(e.target.value)}
              placeholder={t('pages.createChange.whatPlaceholder')}
              rows={3}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </div>

          {/* CHANGE OWNER */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.owner} style={fieldLabel}>{t('pages.changeDetail.changeOwner')}</label>
            <select
              id={ids.owner}
              value={ownerId}
              onChange={e => setOwnerId(e.target.value)}
              style={inputBase}
            >
              <option value="">{t('pages.createChange.nobody')}</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          {/* CI AFFECTED */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.ciSearch} style={fieldLabel}>
              {t('attachments.affectedCIs')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
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
                id={ids.ciSearch}
                type="text"
                value={ciSearch}
                onChange={e => setCiSearch(e.target.value)}
                placeholder={t('pages.createChange.searchCI')}
                style={{ ...inputBase, paddingLeft: 36 }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
              />
              {ciResults.length > 0 && ciSearch.length >= 2 && (
                <div style={{
                  position:     'absolute',
                  left:         0,
                  right:        0,
                  top:          '100%',
                  marginTop:    4,
                  background:   colors.white,
                  border:       '1px solid var(--color-border)',
                  borderRadius: 8,
                  boxShadow:    '0 4px 12px var(--color-black-a10)',
                  maxHeight:    220,
                  overflowY:    'auto',
                  zIndex:       20,
                }}>
                  {ciResults.map(ci => (
                    <button
                      type="button"
                      key={ci.id}
                      onClick={() => { setSelectedCIs(p => [...p, ci]); setCiSearch('') }}
                      className="hover-bg"
                      style={{
                        width:        '100%',
                        background:   'none',
                        border:       'none',
                        borderRadius: 0,
                        font:         'inherit',
                        color:        'inherit',
                        textAlign:    'left',
                        padding:      '8px 12px',
                        cursor:       'pointer',
                        display:      'flex',
                        alignItems:   'center',
                        gap:          8,
                        borderBottom: '1px solid var(--color-border-light)',
                      }}
                    >
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>
                        {ci.name}
                      </span>
                      <span style={{
                        fontSize:        'var(--font-size-body)',
                        padding:         '1px 6px',
                        borderRadius:    4,
                        backgroundColor: 'var(--color-border-light)',
                        color:           'var(--color-slate)',
                      }}>
                        {ci.type}{ci.environment ? ` · ${ci.environment}` : ''}
                      </span>
                    </button>
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
                      border:      '1px solid var(--color-info-border)',
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
              {t('pages.createChange.ciGroupsNote')}
            </p>
          </div>

          {/* Backend error banner */}
          {backendError && (
            <div style={{
              marginBottom:    20,
              padding:         '10px 14px',
              borderRadius:    8,
              background:      'var(--color-danger-bg)',
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
            borderTop:      '1px solid var(--color-border-light)',
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
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              style={{
                background:   'var(--color-brand)',
                color:        colors.white,
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
              {loading ? t('common.creating') : t('pages.createChange.submit')}
            </button>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}
