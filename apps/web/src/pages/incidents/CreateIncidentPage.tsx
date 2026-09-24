import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_INCIDENT } from '@/graphql/mutations'
import { derivePriority, priorityCode, impactUrgencyFromPriority } from '@/lib/priority'
import { usePriorityMatrix } from '@/hooks/usePriorityMatrix'
import { GET_ALL_CIS, GET_TEAMS } from '@/graphql/queries'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { useFormFieldRules, validateFormFields } from '@/hooks/useFormFieldRules'
import { useEnumValues } from '@/hooks/useEnumValues'
import { FieldWrapper } from '@/components/FieldWrapper'
import { TriageSuggestionCard } from '@/components/TriageSuggestionCard'
import { colors, palette, alpha } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useSlaCoverageCheck } from '@/hooks/useSlaCoverageCheck'
import { useValueStyle } from '@/hooks/useValueStyle'
import { CustomFieldsForm } from '@/components/ticket/customFields/CustomFieldsForm'
import { customFieldsInput, missingCustomFields, useCreationCustomFieldDefs } from '@/components/ticket/customFields/customFields'
import { showError } from '@/lib/showError'
import { useCILabels } from '@/hooks/useCILabels'
import { CIExclusionHint } from '@/components/ticket/CIExclusionHint'
import { TeamPicker } from '@/components/pickers/TeamPicker'
import { humanizeValue } from '@opengraphity/web-core'
import { TEAM_TYPE } from '@/lib/teamVocabularies'
import { useIncidentTeam } from './incidentTeam'

interface CIRef { id: string; name: string; type: string; environment?: string; supportGroup?: { id: string; name: string } | null }
interface Team  { id: string; name: string }

// ── Style helpers ─────────────────────────────────────────────────────────────

const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

const inputBase: React.CSSProperties = {
  width: '100%', padding: '10px 14px',
  border: `1.5px solid ${colors.border}`, borderRadius: 8,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', outline: 'none',
  backgroundColor: colors.white, boxSizing: 'border-box',
  fontFamily: 'var(--font-family)', transition: 'border-color 150ms',
}

// ── Component ─────────────────────────────────────────────────────────────────
// v2 — category field + validation feedback

export function CreateIncidentPage() {
  const { t } = useTranslation()
  const ciLabels = useCILabels()
  const { labelOf } = useDomainVocabularies()
  // F9: il colore della priorità derivata è quello del Dizionario.
  const styleOf = useValueStyle()
  const navigate = useNavigate()
  const ids = { category: useId(), ciSearch: useId(), teamSearch: useId(), levels: useId() }

  const [title,       setTitle]       = useState('')
  const [category,    setCategory]    = useState('')
  // Impatto, urgenza e priorità vengono dalla matrice DEL CLIENTE (revisione ·
  // C·N-3): qui c'era una copia della matrice di fabbrica, e chi rinominava i
  // vocabolari vedeva i tre bottoni vecchi e ogni invio rifiutato dal server.
  // Il valore iniziale è quello mediano della scala del cliente, non «medium».
  const { matrix, loading: matrixLoading, error: matrixError } = usePriorityMatrix()
  const [impact,      setImpact]      = useState('')
  const [urgency,     setUrgency]     = useState('')
  useEffect(() => {
    if (!matrix) return
    setImpact((v) => (v === '' ? (matrix.impacts[Math.floor((matrix.impacts.length - 1) / 2)] ?? '') : v))
    setUrgency((v) => (v === '' ? (matrix.urgencies[Math.floor((matrix.urgencies.length - 1) / 2)] ?? '') : v))
  }, [matrix])
  const priority = derivePriority(matrix, impact, urgency) ?? ''
  const [description, setDescription] = useState('')
  const [ciSearch,    setCiSearch]    = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])
  // The team: the CI's support group, unless chosen by hand (incidentTeam.ts).
  const { team, fromCI, prefilled, overriddenSuggestion, choose: chooseTeam, suggest: suggestTeam } = useIncidentTeam(selectedCIs)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Campi personalizzati del cliente (verifica «Cosa resta cablato», ondata 4).
  const { defs: customDefs } = useCreationCustomFieldDefs('incident', category)
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const formValues = { title, severity: priority, category, description, ...customValues }
  const { rules: fieldRules, error: fieldRulesError } = useFormFieldRules('incident', null, formValues)
  const { values: categoryValues, loading: categoryLoading } = useEnumValues('incident', 'category')

  // CM-8: i tipi di CI esclusi per questo tipo di ticket non si propongono (l'API li rifiuta comunque).
  const { excluded: excludedCITypes } = useTicketCIExclusions('incident')

  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, excludeCiTypes: excludedCITypes },
    skip: ciSearch.length < 2 || excludedCITypes === undefined,
    fetchPolicy: 'network-only',
  })
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const ciResults     = (ciData?.allCIs?.items ?? [])
    .filter(ci => !selectedCIs.find(s => s.id === ci.id))

  const checkSlaCoverage = useSlaCoverageCheck()
  const [checkingSla, setCheckingSla] = useState(false)

  const canSubmit = title.trim() !== '' && description.trim() !== '' && category !== '' && selectedCIs.length > 0

  const [createIncident, { loading }] = useMutation<{ createIncident: { id: string } }>(CREATE_INCIDENT, {
    /**
     * Il refetch per NOME dell'operazione (revisione totale · F-14):
     * `[{ query: GET_X }]` senza variabili rinfresca solo la voce di cache
     * SENZA variabili, che nessuna lista usa (tutte passano limite, pagina e
     * filtri) — quindi dopo una creazione l'elenco restava quello di prima.
     * Col nome, Apollo rinfresca ogni query attiva con quel nome, qualunque
     * siano le sue variabili.
     */
    refetchQueries: ['GetIncidents'],
    // The team travels with the creation (input.teamId): one assignment, one note.
    onCompleted: (data) => {
      toast.success(t('toast.incident.created'))
      // Straight to the new incident, as a new change does: it is where the work starts.
      navigate(`/incidents/${data.createIncident.id}`)
    },
    onError: (err) => showError(err),
  })


  return (
    <PageContainer style={{ minHeight: '100%', backgroundColor: 'var(--color-slate-bg)', paddingBottom: '64px' }}>
      <div style={{ maxWidth: 580, margin: '0 auto' }}>

        {/* Header */}
        <button
          type="button"
          onClick={() => navigate('/incidents')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
        >
          ← Incidents
        </button>

        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          {t('pages.createIncident.title')}
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 24px' }}>
          {t('pages.createIncident.subtitle')}
        </p>

        {/* Card */}
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '28px 32px', boxShadow: `0 1px 4px ${alpha.black06}` }}>

          {/* TITOLO */}
          <FieldWrapper
            visible={fieldRules['title']?.visible ?? true}
            /*
              Il titolo È obbligatorio — `canSubmit` lo esige e lo schema lo
              dichiara `String!` — e il suo era l'unico campo obbligatorio del
              form senza l'asterisco: `?? false`. Primo campo della pagina, e
              l'unico che non diceva di esserlo.
            */
            required
            label={t('forms.title')}
            error={fieldErrors['title']}
            style={{ marginBottom: 20 }}
          >
            <input aria-label={t('pages.createIncident.titlePlaceholder')}
              type="text"
              value={title}
              onChange={e => { setTitle(e.target.value); setFieldErrors((p) => { const n = { ...p }; delete n['title']; return n }) }}
              placeholder={t('pages.createIncident.titlePlaceholder')}
              style={{ ...inputBase, borderColor: fieldErrors['title'] ? 'var(--color-trigger-sla-breach)' : colors.border }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = fieldErrors['title'] ? 'var(--color-trigger-sla-breach)' : colors.border }}
            />
          </FieldWrapper>

          {/* CATEGORIA */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.category} style={fieldLabel}>
              {t('pages.kb.category')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            {categoryLoading ? (
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('common.loading')}</span>
            ) : (
              <select
                id={ids.category}
                value={category}
                onChange={e => { setCategory(e.target.value); setFieldErrors(p => { const n = { ...p }; delete n['category']; return n }) }}
                style={{ ...inputBase, borderColor: fieldErrors['category'] ? 'var(--color-trigger-sla-breach)' : colors.border }}
              >
                <option value="">{t('pages.createIncident.selectCategory')}</option>
                {categoryValues.map(c => (
                  <option key={c} value={c}>{labelOf('category', c) ?? humanizeValue(c)}</option>
                ))}
              </select>
            )}
            {fieldErrors['category'] && <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{fieldErrors['category']}</p>}
          </div>

          {/* IMPATTO × URGENZA → PRIORITÀ (ITIL) */}
          <div style={{ marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {([['pages.domainMatrices.impact', 'impact', impact, setImpact, matrix?.impacts ?? []], ['pages.domainMatrices.urgency', 'urgency', urgency, setUrgency, matrix?.urgencies ?? []]] as const).map(([labelKey, vocabolario, val, setVal, options]) => (
              <div key={labelKey}>
                <div id={`${ids.levels}-${vocabolario}`} style={fieldLabel}>{t(labelKey)} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></div>
                {/* Un gruppo col nome del campo e bottoni che dicono quale è scelto (aria-pressed). */}
                <div role="group" aria-labelledby={`${ids.levels}-${vocabolario}`} style={{ display: 'flex', gap: 6 }}>
                  {options.map(o => {
                    const sel = val === o
                    return (
                      <button key={o} type="button" aria-pressed={sel} onClick={() => setVal(o)}
                        style={{ padding: '7px 14px', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer',
                          border: `1.5px solid ${sel ? 'var(--color-brand)' : colors.border}`,
                          background: sel ? palette.info.light : 'var(--color-slate-bg)',
                          color: sel ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: sel ? 600 : 400 }}
                        title={o}>
                        {/* L'etichetta del cliente: «Alto» per l'impatto, «Alta» per l'urgenza. */}
                        {labelOf(vocabolario, o) ?? o}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div>
              <div style={fieldLabel}>{t('pages.createTicket.derivedPriority')}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 6,
                border: `1.5px solid ${priority === '' ? colors.border : styleOf('priority', priority).accent}`,
                background: priority === '' ? 'var(--color-slate-bg)' : styleOf('priority', priority).bg,
                color: priority === '' ? 'var(--color-slate)' : styleOf('priority', priority).color, fontWeight: 600 }}>
                <span>{priority === '' ? '—' : priorityCode(matrix?.priorities ?? [], priority)}</span>
                <span style={{ textTransform: 'capitalize' }}>
                  {/* L'etichetta della priorità, non il valore: qui si leggeva «Medium». */}
                  {priority !== '' ? (labelOf('priority', priority) ?? priority)
                    : matrixLoading ? t('common.loading')
                    : t('pages.domainMatrices.notFilledIn')}
                </span>
              </div>
            </div>
          </div>

          {/* DESCRIZIONE */}
          <FieldWrapper
            visible={fieldRules['description']?.visible ?? true}
            required={true}
            label={t('forms.description')}
            error={fieldErrors['description']}
            style={{ marginBottom: 20 }}
          >
            <textarea aria-label={t('pages.createIncident.descriptionPlaceholder')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('pages.createIncident.descriptionPlaceholder')}
              rows={3}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </FieldWrapper>

          {/* SUGGERIMENTO TRIAGE AI — esplicito, mai auto-applicato */}
          <TriageSuggestionCard
            title={title}
            description={description}
            ciIds={selectedCIs.map(ci => ci.id)}
            onApply={({ severity: sev, category: cat, teamName }) => {
              // AI suggests a severity → map back to impact/urgency
              // La coppia si ricava dalla matrice del cliente; se quella
              // priorità nessuna cella la produce, impatto e urgenza restano
              // quelli scelti dall'utente invece di essere sovrascritti con un
              // valore inventato.
              const iu = impactUrgencyFromPriority(matrix, sev)
              if (iu) { setImpact(iu.impact); setUrgency(iu.urgency) }
              setCategory(cat)
              if (teamName) {
                // Only a suggestion: it never replaces the CI's support group or a team chosen by hand.
                const suggested = teamsData?.teams.find(t => t.name === teamName)
                if (suggested) suggestTeam({ id: suggested.id, name: suggested.name })
              }
              setFieldErrors(p => { const n = { ...p }; delete n['category']; return n })
            }}
          />

          {/* CI IMPATTATI */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.ciSearch} style={fieldLabel}>
              {t('attachments.affectedCIs')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>

            <CIExclusionHint excluded={excludedCITypes} />

            {/* Search input with icon */}
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--font-size-card-title)', pointerEvents: 'none', color: 'var(--color-slate-light)' }}>
                🔍
              </span>
              <input
                id={ids.ciSearch}
                type="text"
                value={ciSearch}
                onChange={e => setCiSearch(e.target.value)}
                placeholder={t('pages.createTicket.searchByName')}
                style={{ ...inputBase, paddingLeft: 36 }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
              />

              {/* Dropdown */}
              {ciResults.length > 0 && ciSearch.length >= 2 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: `0 4px 12px ${alpha.black10}`, maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                  {ciResults.map(ci => (
                    <button
                      type="button"
                      key={ci.id}
                      onClick={() => { setSelectedCIs(p => [...p, ci]); setCiSearch('') }}
                      className="hover-bg"
                      style={{ width: '100%', background: 'none', border: 'none', borderRadius: 0, font: 'inherit', color: 'inherit', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${palette.neutral.borderLight}` }}
                    >
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{ci.name}</span>
                      <span style={{ fontSize: 'var(--font-size-body)', padding: '1px 6px', borderRadius: 4, backgroundColor: 'var(--color-border-light)', color: 'var(--color-slate)' }}>
                        {ciLabels.subtitle(ci)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Selected tags */}
            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {selectedCIs.map(ci => (
                  <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-brand-light)', border: `1px solid ${palette.info.border}`, color: 'var(--color-brand-hover)', fontSize: 'var(--font-size-body)' }}>
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

          {/* TEAM — D10: the support teams, searchable, full names (it listed every team of the tenant). */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.teamSearch} style={fieldLabel}>
              {t('detail.team')}{' '}
              <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>{t('common.optional')}</span>
            </label>
            <TeamPicker
              role={TEAM_TYPE.SUPPORT}
              inputId={ids.teamSearch}
              label={t('detail.team')}
              value={team}
              onChange={chooseTeam}
              // With a CI that has a support group «no team» is not a choice: the incident goes to a team.
              {...(fromCI ? {} : { clearLabel: t('pickers.teams.none') })}
              style={inputBase}
            />
            {prefilled && fromCI && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
                {t('pages.createIncident.teamFromCI', { ci: fromCI.name })}
              </p>
            )}
            {overriddenSuggestion && fromCI && (
              <p role="note" style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: palette.warning.text }}>
                {t('pages.createIncident.suggestionOverridden', { suggested: overriddenSuggestion.name, ci: fromCI.name })}
              </p>
            )}
            {selectedCIs.length > 0 && !fromCI && team === null && (
              <p role="note" style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: palette.warning.text }}>
                {t('pages.createIncident.noSupportGroup', { count: selectedCIs.length })}
              </p>
            )}
          </div>

          {/* CAMPI DEL CLIENTE */}
          {customDefs.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <CustomFieldsForm
                defs={customDefs}
                values={customValues}
                rules={fieldRules}
                errors={fieldErrors}
                onChange={(name, value) => { setCustomValues((v) => ({ ...v, [name]: value })); setFieldErrors((p) => { const n = { ...p }; delete n[name]; return n }) }}
                inputStyle={inputBase}
                labelStyle={fieldLabel}
              />
            </div>
          )}

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, marginTop: 8, paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => navigate('/incidents')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', padding: 0 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!canSubmit || loading || checkingSla}
              onClick={() => {
                if (!canSubmit || loading || checkingSla) return
                if (fieldRulesError) {
                  showError(fieldRulesError, t('toast.incident.fieldRulesUnavailable', { error: fieldRulesError.message }))
                  return
                }
                // La matrice è la sorgente di impatto, urgenza e priorità: se non
                // si legge, o se non copre la coppia scelta, non si inventa un
                // valore — il server lo rifiuterebbe comunque, e il messaggio
                // qui dice cosa fare.
                if (matrixError) {
                  showError(matrixError, t('toast.incident.matrixUnavailable', { error: matrixError.message }))
                  return
                }
                if (priority === '') {
                  toast.error(t('toast.incident.matrixIncomplete'))
                  return
                }
                const errs: Record<string, string> = {}
                if (!title.trim()) errs['title'] = t('forms.fieldRequired')
                if (!category) errs['category'] = t('forms.selectCategory')
                if (!description.trim()) errs['description'] = t('forms.fieldRequired')
                const missing = [...validateFormFields(fieldRules, formValues), ...missingCustomFields(customDefs, customValues, fieldRules)]
                missing.forEach((f) => { if (!errs[f]) errs[f] = t('forms.fieldRequired') })
                if (Object.keys(errs).length > 0) {
                  setFieldErrors(errs)
                  return
                }
                setFieldErrors({})
                // Prima di creare: una policy SLA copre questo incident? Se no,
                // chi lo crea lo sa adesso e decide (useSlaCoverageCheck).
                setCheckingSla(true)
                void checkSlaCoverage({
                  entityType: 'incident',
                  priority, priorityLabel: labelOf('priority', priority) ?? priority,
                  category: category || null, categoryLabel: category ? (labelOf('category', category) ?? category) : null,
                  teamId: team?.id ?? null, teamName: team?.name ?? null,
                }).then((decisione) => {
                  if (decisione === 'cancelled') return
                  void createIncident({
                    variables: {
                      input: {
                        title: title.trim(),
                        impact,
                        urgency,
                        category: category || undefined,
                        description: description.trim() || undefined,
                        affectedCIIds: selectedCIs.map(ci => ci.id),
                        customFields: customFieldsInput(customDefs, customValues),
                        // The team that takes the incident: the CI's support group or the one chosen.
                        ...(team ? { teamId: team.id } : {}),
                        ...(decisione === 'accepted' ? { acknowledgeNoSla: true } : {}),
                      },
                    },
                  })
                }).catch((err: unknown) => {
                  showError(err, t('toast.incident.slaCoverageUnavailable', { error: err instanceof Error ? err.message : String(err) }))
                }).finally(() => setCheckingSla(false))
              }}
              style={{
                background: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 8,
                padding: '10px 24px', fontSize: 'var(--font-size-card-title)', fontWeight: 600,
                cursor: canSubmit && !loading && !checkingSla ? 'pointer' : 'not-allowed',
                opacity: canSubmit && !loading && !checkingSla ? 1 : 0.5,
                transition: 'opacity 150ms',
              }}
            >
              {loading ? t('common.creating') : t('pages.createIncident.submit')}
            </button>
          </div>

        </div>
      </div>
    </PageContainer>
  )
}
