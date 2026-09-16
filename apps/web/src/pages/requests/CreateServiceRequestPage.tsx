import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { colors, palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useSlaCoverageCheck } from '@/hooks/useSlaCoverageCheck'
import { useValueStyle } from '@/hooks/useValueStyle'
import { CustomFieldsForm } from '@/components/ticket/customFields/CustomFieldsForm'
import {
  CatalogFormRenderer, catalogFormAnswersToSend, visibleCatalogFormItems,
  type CatalogFormFieldView, type CatalogFormFile, type CatalogFormReference,
} from '@opengraphity/web-core'
import { isFormAttachmentType, isFormReferenceType } from '@opengraphity/types'
import { uploadFormDraftFile } from '@/lib/formDraftUpload'
import { DELETE_ATTACHMENT } from '@/graphql/mutations'
import { GET_ALL_CIS, GET_TEAMS, GET_USERS } from '@/graphql/queries'
import { useApolloClient } from '@apollo/client/react'
import { GET_CATALOG_FORM_TO_FILL } from '@/graphql/queries'
import type { CatalogFormDefinition, FormAnswerValue, FormAnswers } from '@opengraphity/types'
import { customFieldsInput, missingCustomFields, useCreationCustomFieldDefs } from '@/components/ticket/customFields/customFields'
import { showError } from '@/lib/showError'
// ── Shared styles ─────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          `1px solid ${colors.border}`,
  borderRadius:    6,
  fontSize:        14,
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: colors.white,
  boxSizing:       'border-box',
  transition:      'border-color 150ms, box-shadow 150ms',
}

const selectBase: React.CSSProperties = {
  ...inputBase,
  appearance:         'none',
  backgroundImage:    'var(--select-arrow)',
  backgroundRepeat:   'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight:       36,
  cursor:             'pointer',
}

function focusHandlers(hasError: boolean) {
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = 'var(--color-brand)'
      e.currentTarget.style.boxShadow   = `0 0 0 3px ${colors.brandLight}`
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? 'var(--color-trigger-sla-breach)' : colors.border
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateServiceRequestPage() {
  const { t, i18n } = useTranslation()
  // F9: il pallino della priorità col colore del Dizionario.
  const styleOf = useValueStyle()
  const { labelOf } = useDomainVocabularies()
  const navigate = useNavigate()
  const ids = { catalog: useId(), title: useId(), priority: useId(), dueDate: useId(), description: useId() }

  const [title, setTitle]           = useState('')
  // Nessuna priorità di ripiego: la porta la voce del catalogo, o la sceglie l'operatore (verifica «Cosa resta cablato», ondata 1).
  const [priority, setPriority]     = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate]       = useState('')
  const [catalogItemId, setCatalogItemId] = useState('')
  const { values: priorityValues, loading: priorityLoading } = useEnumValues('service_request', 'priority')
  const [submitted, setSubmitted]   = useState(false)

  interface CatalogItem { id: string; name: string; description: string | null; category: string | null; requiresApproval: boolean; priority: string | null; active: boolean }
  const { data: catalogData } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const catalogItems = (catalogData?.serviceCatalogItems ?? []).filter((i) => i.active)
  const selectedItem = catalogItems.find((i) => i.id === catalogItemId) ?? null

  const onSelectCatalogItem = (id: string) => {
    setCatalogItemId(id)
    const item = catalogItems.find((i) => i.id === id)
    if (item) {
      setTitle(item.name)
      if (item.description && !description.trim()) setDescription(item.description)
      if (item.priority) setPriority(item.priority)
    }
  }

  const titleError = submitted && !title.trim() ? t('forms.fieldRequired') : ''

  const [createRequest, { loading }] = useMutation(CREATE_SERVICE_REQUEST, {
    /**
     * Il refetch per NOME dell'operazione (revisione totale · F-14):
     * `[{ query: GET_X }]` senza variabili rinfresca solo la voce di cache
     * SENZA variabili, che nessuna lista usa (tutte passano limite, pagina e
     * filtri) — quindi dopo una creazione l'elenco restava quello di prima.
     * Col nome, Apollo rinfresca ogni query attiva con quel nome, qualunque
     * siano le sue variabili.
     */
    refetchQueries: ['GetServiceRequests'],
    onCompleted: () => { toast.success(t('toast.request.created')); navigate('/requests') },
    onError:     (err) => showError(err),
  })

  const checkSlaCoverage = useSlaCoverageCheck()
  const [checkingSla, setCheckingSla] = useState(false)
  // Campi personalizzati del cliente (verifica «Cosa resta cablato», ondata 4).
  const { defs: customDefs } = useCreationCustomFieldDefs('service_request')
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({})

  /**
   * IL MODULO DELLA VOCE DI CATALOGO (moduli del catalogo, ondata 1).
   *
   * Si carica quando la voce è scelta e non prima: prima non c'è un modulo di
   * cui parlare. `catalogFormToFill` torna null se la voce non ha un modulo
   * pubblicato, e allora la pagina resta quella di sempre — non una pagina
   * vuota che sembra rotta.
   */
  const { data: formData } = useQuery<{ catalogFormToFill: { itemId: string; revision: number; definition: string; fields: CatalogFormFieldView[] } | null }>(
    GET_CATALOG_FORM_TO_FILL,
    { variables: { itemId: catalogItemId, endUser: false, language: i18n.language }, skip: !catalogItemId, fetchPolicy: 'cache-and-network' },
  )
  const modulo = formData?.catalogFormToFill ?? null
  const definizione: CatalogFormDefinition | null = useMemo(() => {
    if (!modulo) return null
    try { return JSON.parse(modulo.definition) as CatalogFormDefinition } catch { return null }
  }, [modulo])
  const [risposte, setRisposte] = useState<Record<string, FormAnswerValue>>({})
  const [erroriModulo, setErroriModulo] = useState<Record<string, string>>({})

  /**
   * ALLEGATI E RIFERIMENTI (ondata 2).
   *
   * `bozzaId` nasce UNA volta con la pagina: i file di un campo allegato si
   * caricano subito, su quella bozza, perché la richiesta non esiste ancora.
   * Alla creazione i file passano dalla bozza al ticket; se questa pagina
   * viene abbandonata, la manutenzione notturna li cancella.
   */
  const [bozzaId] = useState(() => crypto.randomUUID())
  const [fileDelModulo, setFileDelModulo] = useState<Record<string, CatalogFormFile[]>>({})
  const [inCaricamento, setInCaricamento] = useState<string | null>(null)
  const [riferimenti, setRiferimenti] = useState<Record<string, CatalogFormReference[]>>({})
  const [cancellaAllegato] = useMutation(DELETE_ATTACHMENT, { onError: (e) => showError(e) })
  const apollo = useApolloClient()

  const caricaFile = async (campo: string, file: File) => {
    setInCaricamento(campo)
    try {
      const caricato = await uploadFormDraftFile(bozzaId, campo, file)
      setFileDelModulo((p) => ({ ...p, [campo]: [...(p[campo] ?? []), caricato] }))
      setErroriModulo((p) => { const n = { ...p }; delete n[campo]; return n })
    } catch (err) {
      showError(err, err instanceof Error ? err.message : undefined)
    } finally {
      setInCaricamento(null)
    }
  }

  const togliFile = async (campo: string, id: string) => {
    const r = await cancellaAllegato({ variables: { id } })
    if (!r.data) return
    setFileDelModulo((p) => ({ ...p, [campo]: (p[campo] ?? []).filter((f) => f.id !== id) }))
  }

  /**
   * La ricerca dei candidati di un campo di riferimento. Query diverse per
   * genere, ognuna quella che la pagina corrispondente usa già: qui non si
   * inventa un endpoint nuovo.
   */
  const cercaRiferimento = async (_campo: string, fieldType: string, query: string): Promise<CatalogFormReference[]> => {
    if (fieldType === 'ref_ci') {
      const r = await apollo.query<{ allCIs: { items: Array<{ id: string; name: string }> } }>({
        query: GET_ALL_CIS, variables: { limit: 20, offset: 0, search: query }, fetchPolicy: 'network-only',
      })
      return (r.data?.allCIs?.items ?? []).map((c) => ({ id: c.id, label: c.name }))
    }
    if (fieldType === 'ref_user') {
      const r = await apollo.query<{ users: Array<{ id: string; name: string; email: string }> }>({
        query: GET_USERS, fetchPolicy: 'cache-first',
      })
      const q = query.toLowerCase()
      return (r.data?.users ?? [])
        .filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
        .slice(0, 20)
        .map((u) => ({ id: u.id, label: u.name || u.email }))
    }
    const r = await apollo.query<{ teams: Array<{ id: string; name: string }> }>({
      query: GET_TEAMS, fetchPolicy: 'cache-first',
    })
    const q = query.toLowerCase()
    return (r.data?.teams ?? []).filter((x) => x.name.toLowerCase().includes(q)).slice(0, 20).map((x) => ({ id: x.id, label: x.name }))
  }

  /**
   * Quando una condizione si spegne, la risposta del campo che non si vede più
   * va DIMENTICATA: il server la rifiuterebbe (un campo nascosto che arriva
   * comunque è un varco), e tenerla nello stato farebbe fallire l'invio per un
   * campo che chi compila non vede nemmeno.
   */
  const cambiaRisposta = (name: string, value: FormAnswerValue) => {
    setErroriModulo((p) => { const n = { ...p }; delete n[name]; return n })
    setRisposte((precedenti) => {
      const aggiornate: Record<string, FormAnswerValue> = { ...precedenti, [name]: value }
      if (!definizione) return aggiornate
      const visibili = new Set(visibleCatalogFormItems(definizione, aggiornate as FormAnswers).map((i) => i.field))
      for (const chiave of Object.keys(aggiornate)) if (!visibili.has(chiave)) delete aggiornate[chiave]
      return aggiornate
    })
  }

  /**
   * Le risposte da inviare. La regola sta in `catalogFormAnswersToSend`
   * (web-core), condivisa col portale: solo i campi visibili adesso, e mai le
   * note — che non portano una risposta e che il server rifiuta.
   */
  const risposteDaInviare = () => {
    if (!definizione || !modulo) return undefined
    const base = catalogFormAnswersToSend(definizione, modulo.fields, risposte as FormAnswers)
    const tipoDi = new Map(modulo.fields.map((f) => [f.name, f.fieldType]))
    /**
     * I riferimenti viaggiano in `refIds`, non in `value`: il server verifica
     * che il nodo esista nel tenant e poi scrive una relazione. Gli allegati
     * non viaggiano affatto — sono già sulla bozza, e il server li reclama.
     */
    return base
      .filter((a) => !isFormAttachmentType(tipoDi.get(a.name) ?? ''))
      .map((a) => {
        if (!isFormReferenceType(tipoDi.get(a.name) ?? '')) return a
        const scelto = riferimenti[a.name]?.[0]
        return { name: a.name, refIds: scelto ? [scelto.id] : [] }
      })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!title.trim() || !priority || loading || checkingSla) return
    const missing = missingCustomFields(customDefs, customValues)
    if (missing.length > 0) {
      setCustomErrors(Object.fromEntries(missing.map((m) => [m, t('forms.fieldRequired')])))
      return
    }
    // Prima di creare: una policy SLA copre questa richiesta? Se no, chi la
    // crea lo sa adesso e decide (useSlaCoverageCheck).
    setCheckingSla(true)
    let decisione: Awaited<ReturnType<typeof checkSlaCoverage>>
    try {
      decisione = await checkSlaCoverage({
        entityType: 'service_request',
        priority, priorityLabel: labelOf('priority', priority) ?? priority,
        category: null, categoryLabel: null, teamId: null, teamName: null,
      })
    } catch (err) {
      showError(err, t('toast.request.slaCoverageUnavailable', { error: err instanceof Error ? err.message : String(err) }))
      return
    } finally {
      setCheckingSla(false)
    }
    if (decisione === 'cancelled') return
    await createRequest({
      variables: {
        input: {
          title:       title.trim(),
          priority,
          description: description || undefined,
          // La scadenza del modulo va all'API (giro nel browser del 14 set 2026:
          // si raccoglieva e non si inviava).
          dueDate:     dueDate || undefined,
          catalogItemId: catalogItemId || undefined,
          customFields: customFieldsInput(customDefs, customValues),
          // Le risposte al modulo della voce (moduli del catalogo, ondata 1).
          formAnswers: risposteDaInviare(),
          // La bozza su cui sono stati caricati i file dei campi allegato (ondata 2).
          formDraftId: Object.values(fileDelModulo).some((l) => l.length > 0) ? bozzaId : undefined,
          ...(decisione === 'accepted' ? { acknowledgeNoSla: true } : {}),
        },
      },
    })
  }

  return (
    <PageContainer>

      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate('/requests')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 32, padding: 0 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
      >
        <ArrowLeft size={14} />
        {t('pages.createRequest.back')}
      </button>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.02em', margin: 0 }}>
          {t('pages.createRequest.title')}
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 6, marginBottom: 0 }}>
          {t('pages.createRequest.subtitle')}
        </p>
      </div>

      {/* Form card */}
      <div style={{ backgroundColor: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 32 }}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Catalog item (consigliato, ma la richiesta generica resta possibile) */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor={ids.catalog} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('pages.createRequest.catalogItem')} <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>{t('pages.createRequest.recommended')}</span>
            </label>
            <select
              id={ids.catalog}
              value={catalogItemId}
              onChange={(e) => onSelectCatalogItem(e.target.value)}
              style={selectBase}
              {...focusHandlers(false)}
            >
              <option value="">{t('pages.createRequest.genericItem')}</option>
              {/**
                * F-38: ServiceCatalogItem.category E un valore del vocabolario
                * `category` — lo dichiara lo schema, e la categoria scritta a
                * mano prima del Dizionario vive a parte in `legacyCategory`.
                * Quindi questo e il vocabolario giusto; il ripiego sul valore
                * grezzo copre la sola voce vecchia mai sistemata.
                */}
              {catalogItems.map((it) => (
                <option key={it.id} value={it.id}>{it.category ? `${labelOf('category', it.category) ?? it.category} · ` : ''}{it.name}</option>
              ))}
            </select>
            {selectedItem?.requiresApproval && (
              <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-body)', color: palette.warning.text }}>
                {t('pages.createRequest.needsApproval')}
              </p>
            )}
          </div>

          {/* Title */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor={ids.title} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('pages.createRequest.titleLabel')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              id={ids.title}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
              placeholder={t('pages.createRequest.titlePlaceholder')}
              style={{ ...inputBase, borderColor: titleError ? 'var(--color-trigger-sla-breach)' : colors.border }}
              {...focusHandlers(!!titleError)}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{titleError}</p>
            )}
          </div>

          {/* Priority + Due date in grid */}
          <div className="og-pair" style={{ marginBottom: 24 }}>

            {/* Priority */}
            <div>
              <label htmlFor={ids.priority} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                {t('pages.createRequest.priorityLabel')} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                {/**
                  * «Non ancora scelta» NON è un valore rotto (giro nel browser
                  * di fine revisione): il pallino chiamava il Dizionario con la
                  * priorità vuota, quindi ad ogni apertura del modulo la
                  * console scriveva «"" is not in the vocabulary of this
                  * tenant» e il pallino prendeva il colore dell'errore accanto
                  * a un campo che nessuno aveva ancora toccato. Un guardiano
                  * che grida al lupo sul caso normale è un guardiano che si
                  * impara a ignorare. Le altre due pagine di creazione
                  * (incident, problem) già distinguevano il vuoto: qui no.
                  */}
                <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 8, height: 8, borderRadius: '50%', backgroundColor: priority === '' ? 'var(--color-border)' : styleOf('priority', priority).accent, pointerEvents: 'none', zIndex: 1 }} />
                <select id={ids.priority} value={priority} onChange={(e) => setPriority(e.target.value)} disabled={priorityLoading} style={{ ...selectBase, paddingLeft: 30 }} {...focusHandlers(false)}>
                  {priorityLoading
                    ? <option value="">{t('common.loading')}</option>
                    : <>
                        <option value="" disabled>{t('pages.createRequest.priorityPlaceholder')}</option>
                        {priorityValues.map(v => (
                          <option key={v} value={v}>{labelOf('priority', v) ?? v.charAt(0).toUpperCase() + v.slice(1)}</option>
                        ))}
                      </>
                  }
                </select>
              </div>
            </div>

            {/* Due date */}
            <div>
              <label htmlFor={ids.dueDate} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                {t('detail.dueDate')}
              </label>
              <input
                id={ids.dueDate}
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
            <label htmlFor={ids.description} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('common.description')}
            </label>
            <textarea
              id={ids.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('pages.createRequest.descriptionPlaceholder')}
              rows={4}
              style={{ ...inputBase, minHeight: 120, resize: 'vertical' }}
              {...focusHandlers(false)}
            />
          </div>

          {/* Campi del cliente */}
          {customDefs.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <CustomFieldsForm
                defs={customDefs}
                values={customValues}
                errors={customErrors}
                gap={24}
                onChange={(name, value) => { setCustomValues((v) => ({ ...v, [name]: value })); setCustomErrors((p) => { const n = { ...p }; delete n[name]; return n }) }}
                inputStyle={inputBase}
                labelStyle={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}
              />
            </div>
          )}

          {/* Il modulo della voce di catalogo (moduli del catalogo, ondata 1) */}
          {definizione && modulo && (
            <div style={{ marginBottom: 24 }}>
              <CatalogFormRenderer
                definition={definizione}
                fields={modulo.fields}
                answers={risposte as FormAnswers}
                onChange={cambiaRisposta}
                language={i18n.language}
                errors={erroriModulo}
                requiredLabel={t('forms.fieldRequired')}
                emptyChoiceLabel={t('common.select')}
                yesLabel={t('common.yes')}
                noLabel={t('common.no')}
                files={fileDelModulo}
                uploadingField={inCaricamento}
                onUploadFile={caricaFile}
                onRemoveFile={togliFile}
                references={riferimenti}
                onSearchReference={cercaRiferimento}
                onPickReference={(campo, scelto) => setRiferimenti((p) => ({ ...p, [campo]: scelto ? [scelto] : [] }))}
                fileAddLabel={t('pages.catalogForms.fill.addFile')}
                fileRemoveLabel={t('pages.catalogForms.fill.removeFile')}
                referenceSearchLabel={t('pages.catalogForms.fill.searchReference')}
                referenceNoResultsLabel={t('pages.catalogForms.fill.noResults')}
                referenceClearLabel={t('pages.catalogForms.fill.clearReference')}
              />
            </div>
          )}

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, marginTop: 32, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={() => navigate('/requests')}
              style={{ padding: '8px 20px', border: `1px solid ${colors.border}`, backgroundColor: colors.white, borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', color: 'var(--color-slate)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = palette.neutral.surface2 }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = colors.white }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={loading || checkingSla}
              style={{ padding: '8px 20px', backgroundColor: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: loading || checkingSla ? 'not-allowed' : 'pointer', opacity: loading || checkingSla ? 0.8 : 1 }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand-hover)' }}
              onMouseLeave={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand)' }}
            >
              {loading ? t('common.creating') : t('pages.createRequest.submit')}
            </button>
          </div>

        </form>
      </div>
    </PageContainer>
  )
}
