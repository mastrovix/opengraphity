import { useId, useMemo, useState, useEffect } from 'react'
import { CustomFieldsForm } from '@/components/ticket/customFields/CustomFieldsForm'
import { customFieldsInput, missingCustomFields, useCreationCustomFieldDefs } from '@/components/ticket/customFields/customFields'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { ChangeTypeModal } from './components/ChangeTypeModal'
import { CREATE_CHANGE } from '@/graphql/mutations'
import { GET_ALL_CIS, GET_USERS, GET_PROBLEM, GET_INCIDENT, GET_PRE_APPROVED_CHANGE_TYPES, GET_CI_GROUPS_BY_ID } from '@/graphql/queries'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { colors, palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'
import { useCILabels } from '@/hooks/useCILabels'
import { CIExclusionHint } from '@/components/ticket/CIExclusionHint'

interface CIRef {
  id: string; name: string; type: string; environment?: string
  /** `null` = il CI non ha il gruppo; assente = non letto. Senza entrambi la change è rifiutata. */
  ownerGroup?: { id: string } | null; supportGroup?: { id: string } | null
}

/** Giro nel browser del 14 set 2026 (#29): il CI senza gruppi si scopriva solo al salvataggio. */
function missingGroups(ci: CIRef): boolean {
  return ci.ownerGroup === null || ci.supportGroup === null
}
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
  const ciLabels = useCILabels()
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
  const requestSource = useMemo(() => problemData?.problem
    ? { kind: 'problem' as const, ...problemData.problem }
    : incidentData?.incident
    ? { kind: 'incident' as const, ...incidentData.incident }
    : null, [problemData, incidentData])
  const [prefilled, setPrefilled] = useState(false)

  const [title, setTitle]             = useState('')
  const [why, setWhy]                 = useState('')
  const [what, setWhat]               = useState('')
  // NB: nessun campo rollback qui — il rollback è una domanda scored
  // dell'assessment tecnico ("Is a tested rollback plan available?").
  // Il tipo è un valore del vocabolario `change_type` DEL CLIENTE, e non ha un
  // default: si sceglie (verifica «Cosa resta cablato», ondata 1). Prima tre
  // bottoni fissi standard/normal/emergency con `normal` preselezionato.
  const [changeType, setChangeType]   = useState('')
  /*
   * IL TIPO SI SCEGLIE PRIMA (20 set 2026, richiesta del proprietario).
   * Il modale si apre arrivando qui e non si chiude finché non si sceglie o
   * non si esce: il tipo decide se la change salta la catena di
   * approvazioni, e non è una domanda da mettere in mezzo alle altre.
   */
  const [modaleTipoAperto, setModaleTipoAperto] = useState(true)
  const { entriesOf } = useDomainVocabularies()
  const changeTypes = entriesOf('change_type')
  const { data: preApprovedData } = useQuery<{ preApprovedChangeTypes: { types: string[] } }>(
    GET_PRE_APPROVED_CHANGE_TYPES, { fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const preApproved = preApprovedData?.preApprovedChangeTypes.types ?? null
  const [ownerId, setOwnerId]         = useState<string>('')
  const [ciSearch, setCiSearch]       = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])
  const [backendError, setBackendError] = useState<string | null>(null)
  // Campi personalizzati del cliente (verifica «Cosa resta cablato», ondata 4).
  const { defs: customDefs } = useCreationCustomFieldDefs('change')
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({})

  // Precompila una volta con i dati dell'entità richiedente.
  useEffect(() => {
    if (requestSource && !prefilled) {
      setSelectedCIs((requestSource.affectedCIs ?? []).map((ci) => ({ id: ci.id, name: ci.name, type: ci.type, environment: ci.environment, ownerGroup: ci.ownerGroup, supportGroup: ci.supportGroup })))
      // F-27: il tipo si traduce («Risolvi problem PRB…» in un'interfaccia
      // italiana era il valore grezzo interpolato nel titolo).
      const label = t(requestSource.kind === 'problem' ? 'entities.problem' : 'entities.incident')
      setTitle(t('pages.createChange.resolutionTitle', { kind: label, number: requestSource.number, title: requestSource.title }))
      setPrefilled(true)
    }
  }, [requestSource, prefilled, t])

  const { data: usersData } = useQuery<{ users: UserRef[] }>(GET_USERS, {
    variables: { sortField: 'name', sortDirection: 'asc' },
  })
  const users = usersData?.users ?? []

  // CM-8: i tipi di CI esclusi per le change non si propongono (l'API li rifiuta comunque).
  const { excluded: excludedCITypes } = useTicketCIExclusions('change')
  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, excludeCiTypes: excludedCITypes },
    skip: ciSearch.length < 2 || excludedCITypes === undefined,
    fetchPolicy: 'network-only',
  })
  const ciResults = (ciData?.allCIs?.items ?? [])
    .filter(ci => !selectedCIs.find(s => s.id === ci.id))

  const [createChange, { loading }] = useMutation<{ createChange: { id: string; code: string } }>(CREATE_CHANGE, {
    /**
     * Il refetch per NOME dell'operazione (revisione totale · F-14):
     * `[{ query: GET_X }]` senza variabili rinfresca solo la voce di cache
     * SENZA variabili, che nessuna lista usa (tutte passano limite, pagina e
     * filtri) — quindi dopo una creazione l'elenco restava quello di prima.
     * Col nome, Apollo rinfresca ogni query attiva con quel nome, qualunque
     * siano le sue variabili.
     */
    refetchQueries: ['GetChanges'],
    onCompleted: (data) => {
      toast.success(t('toast.change.created', { code: data.createChange.code }))
      navigate(`/changes/${data.createChange.id}`, { state: { refresh: true } })
    },
    onError: (err) => {
      console.error('[createChange] error', err)
      setBackendError(err.message)
      showError(err)
    },
  })

  const ciWithoutGroups = selectedCIs.filter(missingGroups)

  /**
   * Secondo giro UI del 15 set 2026 · V-1: i gruppi di un CI si leggevano solo
   * quando lo si aggiungeva. Chi andava a impostarli sulla pagina del CI e
   * tornava trovava il chip ancora rosso e «Crea» spento, finché non toglieva e
   * riaggiungeva il CI. Si rileggono quando la finestra torna in primo piano e
   * con «Ricontrolla».
   */
  const apollo = useApolloClient()
  const [rechecking, setRechecking] = useState(false)
  const recheckGroups = async () => {
    const stale = selectedCIs.filter(missingGroups)
    if (stale.length === 0) return
    setRechecking(true)
    try {
      const fresh = await Promise.all(stale.map((ci) => apollo.query<{ ciById: { id: string; ownerGroup: { id: string } | null; supportGroup: { id: string } | null } | null }>({
        query: GET_CI_GROUPS_BY_ID, variables: { id: ci.id }, fetchPolicy: 'network-only',
      })))
      const byId = new Map(fresh.map((r) => r.data?.ciById).filter((c): c is NonNullable<typeof c> => c != null).map((c) => [c.id, c]))
      setSelectedCIs((prev) => prev.map((ci) => {
        const f = byId.get(ci.id)
        return f ? { ...ci, ownerGroup: f.ownerGroup, supportGroup: f.supportGroup } : ci
      }))
    } catch (e) {
      showError(e)
    } finally {
      setRechecking(false)
    }
  }
  useEffect(() => {
    if (ciWithoutGroups.length === 0) return
    // `focus` quando torna la finestra, `visibilitychange` quando torna la scheda:
    // dal vivo il cambio di scheda non emetteva `focus`.
    const onFocus = () => { void recheckGroups() }
    const onVisible = () => { if (document.visibilityState === 'visible') void recheckGroups() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // F-26: l'array di dipendenze mancava, quindi l'effetto si ri-registrava a
    // OGNI render — due ascoltatori aggiunti e togliati a ogni digitazione nel
    // form. Dipende solo da quanti CI sono senza gruppo.
  }, [ciWithoutGroups.length])
  const canSubmit = title.trim() !== '' && why.trim() !== '' && what.trim() !== '' && changeType !== '' && selectedCIs.length > 0 && ciWithoutGroups.length === 0 && !loading

  const handleSubmit = () => {
    if (!canSubmit) return
    setBackendError(null)
    const missing = missingCustomFields(customDefs, customValues)
    if (missing.length > 0) {
      setCustomErrors(Object.fromEntries(missing.map((m) => [m, t('forms.fieldRequired')])))
      return
    }
    void createChange({
      variables: {
        input: {
          title:         title.trim(),
          why:           why.trim(),
          what:          what.trim(),
          changeOwner:   ownerId || null,
          affectedCIIds: selectedCIs.map(ci => ci.id),
          changeType,
          customFields:  customFieldsInput(customDefs, customValues),
          ...(problemId ? { problemId } : {}),
          ...(incidentId ? { incidentId } : {}),
        },
      },
    })
  }

  return (
    <PageContainer style={{ minHeight: '100%', backgroundColor: 'var(--color-slate-bg)', paddingBottom: 64 }}>
      {/*
        Il tipo PRIMA della form. Uscire senza scegliere riporta alla lista:
        una change senza tipo non esiste, e lasciare la form aperta e vuota
        sarebbe peggio che tornare indietro.
      */}
      <ChangeTypeModal
        open={modaleTipoAperto}
        types={changeTypes}
        preApproved={preApproved}
        onPick={(v) => { setChangeType(v); setModaleTipoAperto(false) }}
        onCancel={() => { if (changeType === '') navigate('/changes'); else setModaleTipoAperto(false) }}
      />
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

          {/* TIPO DI CHANGE — scelto nel modale, qui si legge e si cambia */}
          <div style={{ marginBottom: 20 }}>
            <div style={fieldLabel}>{t('pages.createChange.changeType')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ padding: '7px 14px', borderRadius: 6, fontSize: 'var(--font-size-body)', fontWeight: 600,
                border: '1.5px solid var(--color-brand)', background: palette.info.light, color: 'var(--color-brand)' }}>
                {changeTypes?.find((e) => e.value === changeType)?.label ?? changeType}
              </span>
              <button type="button" onClick={() => setModaleTipoAperto(true)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', textDecoration: 'underline' }}>
                {t('pages.createChange.changeTypeChange')}
              </button>
            </div>
            <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 6 }}>
              {preApproved !== null && changeTypes !== null && preApproved.length > 0
                ? t('pages.createChange.typesNotePreApproved', {
                    types: preApproved.map((v) => changeTypes.find((e) => e.value === v)?.label ?? v).join(', '),
                  })
                : t('pages.createChange.typesNoteAllApproved')}
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
            <CIExclusionHint excluded={excludedCITypes} />
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
                        {ciLabels.subtitle(ci)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {ciWithoutGroups.length > 0 && (
              <p role="alert" style={{ margin: '8px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
                {t('pages.createChange.ciWithoutGroupsList', { names: ciWithoutGroups.map((c) => c.name).join(', ') })}{' '}
                <button type="button" onClick={() => void recheckGroups()} disabled={rechecking}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-brand)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
                  {t('pages.createChange.recheckGroups')}
                </button>
              </p>
            )}
            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {selectedCIs.map(ci => (
                  <span
                    key={ci.id}
                    title={missingGroups(ci) ? t('pages.createChange.ciWithoutGroups') : undefined}
                    style={{
                      display:     'inline-flex',
                      alignItems:  'center',
                      gap:         6,
                      padding:     '4px 10px',
                      borderRadius: 6,
                      background:  missingGroups(ci) ? 'var(--color-danger-bg)' : 'var(--color-brand-light)',
                      border:      missingGroups(ci) ? '1px solid var(--color-danger)' : '1px solid var(--color-info-border)',
                      color:       missingGroups(ci) ? 'var(--color-danger)' : 'var(--color-brand-hover)',
                      fontSize:    'var(--font-size-body)',
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{ci.name}</span>
                    <span style={{ opacity: 0.7, fontSize: 'var(--font-size-label)' }}>
                      {ciLabels.subtitle(ci)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedCIs(p => p.filter(c => c.id !== ci.id))}
                      aria-label={t('pages.createChange.removeCI', { name: ci.name })}
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

          {/* CAMPI DEL CLIENTE */}
          {customDefs.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <CustomFieldsForm
                defs={customDefs}
                values={customValues}
                errors={customErrors}
                onChange={(name, value) => { setCustomValues((v) => ({ ...v, [name]: value })); setCustomErrors((p) => { const n = { ...p }; delete n[name]; return n }) }}
                inputStyle={inputBase}
                labelStyle={fieldLabel}
              />
            </div>
          )}

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
