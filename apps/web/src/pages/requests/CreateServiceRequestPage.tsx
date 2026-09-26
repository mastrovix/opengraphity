import { BackLink, DetailTitle } from '@/components/ui/BackLink'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useId, useMemo, useState } from 'react'
import { UserPicker } from '@/components/pickers/UserPicker'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { colors, palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useSlaCoverageCheck } from '@/hooks/useSlaCoverageCheck'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { useValueStyle } from '@/hooks/useValueStyle'
import { CustomFieldsForm } from '@/components/ticket/customFields/CustomFieldsForm'
import {
  CatalogFormRenderer, catalogFormAnswersToSend, catalogFormTableAnswers, visibleCatalogFormItems,
  type CatalogFormFieldView, type CatalogFormFile, type CatalogFormReference, type CatalogFormTableRow,
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
import { useCreationFieldRules } from '@/hooks/useCreationFieldRules'
import { errorFieldName, errorHasKey, humanizeValue } from '@opengraphity/web-core'
import { errorMessage } from '@/hooks/useMutationWithToast'
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
  const ids = { catalog: useId(), title: useId(), priority: useId(), dueDate: useId(), description: useId(), requestedFor: useId() }

  const [title, setTitle]           = useState('')
  // Nessuna priorità di ripiego: la porta la voce del catalogo, o la sceglie l'operatore (verifica «Cosa resta cablato», ondata 1).
  const [priority, setPriority]     = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate]       = useState('')
  const [catalogItemId, setCatalogItemId] = useState('')
  /** Who it is for, when the service desk opens it for a colleague (G28); null = the person opening it. */
  const [requestedFor, setRequestedFor] = useState<{ id: string; name: string } | null>(null)
  const { values: priorityValues, loading: priorityLoading } = useEnumValues('service_request', 'priority')
  const [submitted, setSubmitted]   = useState(false)

  interface CatalogItem { id: string; name: string; description: string | null; category: string | null; requiresApproval: boolean; priority: string | null; active: boolean; fulfillmentTeam: { id: string; name: string } | null }
  const { data: catalogData } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const catalogItems = (catalogData?.serviceCatalogItems ?? []).filter((i) => i.active)
  const selectedItem = catalogItems.find((i) => i.id === catalogItemId) ?? null

  const onSelectCatalogItem = (id: string) => {
    setCatalogItemId(id)
    /*
     * CAMBIARE VOCE COMINCIA UNA BOZZA NUOVA (revisione del 17 set 2026).
     *
     * I file già caricati rispondevano alle domande dell'altra voce: restando
     * sulla stessa bozza finivano sul ticket comunque, e soddisfacevano anche
     * l'obbligatorietà di un campo allegato che questa voce chiede. Quelli di
     * prima li porta via la passata notturna.
     */
    setBozzaId(crypto.randomUUID())
    setFileDelModulo({})
    /*
     * E LE RISPOSTE DELL'ALTRA VOCE NON RESTANO.
     *
     * I campi della libreria sono condivisi fra i moduli: senza questo
     * azzeramento la voce nuova nasceva precompilata con quello che si era
     * scritto per la precedente, e le sue condizioni si valutavano su risposte
     * che non le appartenevano — un campo che appare o sparisce a torto.
     */
    setRisposte({})
    setRigheTabelle({})
    setRiferimenti({})
    setErroriModulo({})
    const item = catalogItems.find((i) => i.id === id)
    if (item) {
      /*
       * IL TITOLO SCRITTO A MANO NON SI PERDE: si riempie solo se è vuoto o se
       * è quello messo automaticamente dalla voce di prima. La descrizione era
       * già protetta così — era il titolo a non esserlo, e chi aveva scritto
       * «Portatile per Rossi – urgente» se lo vedeva sostituire da «Nuovo
       * portatile» scegliendo la voce.
       */
      const automatico = title.trim() === '' || catalogItems.some((i) => i.name === title)
      if (automatico) setTitle(item.name)
      /*
       * LA DESCRIZIONE SEGUE LA STESSA REGOLA DEL TITOLO (20 set 2026, dal
       * giro nel browser).
       *
       * Era protetta solo dal «vuoto»: quella messa automaticamente dalla
       * voce di PRIMA sopravviveva al cambio di voce, e una richiesta di
       * accesso a un'applicazione nasceva con scritto «Richiesta di un
       * portatile aziendale». Chi guarda due voci prima di decidere manda una
       * descrizione che parla di un altro servizio, e nessuno se ne accorge.
       *
       * Il commento qui sopra diceva «la descrizione era già protetta così»:
       * era protetta di PIÙ, ed è esattamente da lì che veniva il difetto.
       */
      const descrizioneAutomatica = description.trim() === ''
        || catalogItems.some((i) => (i.description ?? '') === description)
      if (descrizioneAutomatica) setDescription(item.description ?? '')
      if (item.priority) setPriority(item.priority)
    }
  }

  const titleError = submitted && !title.trim() ? t('forms.fieldRequired') : ''
  /*
   * La priorità aveva l'asterisco e nessun errore: con il segnaposto ancora
   * scelto, «Crea la richiesta» usciva in silenzio e non succedeva
   * ASSOLUTAMENTE NIENTE — nessun messaggio, nessun fuoco, niente (revisione
   * del 17 set 2026). Un pulsante che non fa niente è peggio di un rifiuto.
   */
  const priorityError = submitted && !priority ? t('forms.fieldRequired') : ''

  const [createRequest, { loading }] = useMutation<{ createServiceRequest?: { id?: string } | null }>(CREATE_SERVICE_REQUEST, {
    /**
     * Il refetch per NOME dell'operazione (revisione totale · F-14):
     * `[{ query: GET_X }]` senza variabili rinfresca solo la voce di cache
     * SENZA variabili, che nessuna lista usa (tutte passano limite, pagina e
     * filtri) — quindi dopo una creazione l'elenco restava quello di prima.
     * Col nome, Apollo rinfresca ogni query attiva con quel nome, qualunque
     * siano le sue variabili.
     */
    refetchQueries: ['GetServiceRequests'],
    // The new request opens, as a new incident or change does (tour of 24 Sep 2026, G29).
    onCompleted: (d) => {
      toast.success(t('toast.request.created'))
      const id = d.createServiceRequest?.id
      navigate(id ? `/requests/${id}` : '/requests')
    },
    onError: (err) => {
      showError(err)
      /*
       * IL RIFIUTO SI ACCENDE ACCANTO AL CAMPO che accusa (revisione del 17
       * set 2026). Prima `erroriModulo` veniva solo SVUOTATO, mai riempito:
       * la prop esisteva, il renderer sapeva già disegnare il bordo rosso e
       * l'`aria-invalid`, e non si accendevano mai. Il server ora manda anche
       * il nome interno del campo accanto all'etichetta, che è quello che
       * serve per trovare la casella.
       */
      const campo = errorFieldName(err)
      if (campo) setErroriModulo({ [campo]: errorMessage(err) })
      /**
       * IL MODULO È CAMBIATO MENTRE SI COMPILAVA (ondata 8): l'avviso l'ha già
       * mostrato il link degli errori, qui si fa il resto — si buttano le
       * risposte, che sono di un altro modulo, e si ricarica quello nuovo. Si
       * guarda la CHIAVE e non il messaggio, che cambia con la lingua.
       */
      if (errorHasKey(err, 'errors.catalogForm.revisionChanged')) {
        setErroriModulo({})
        setRisposte({})
        setRiferimenti({})
        setRigheTabelle({})
        setFileDelModulo({})
        void rileggiModulo()
      }
    },
  })

  const checkSlaCoverage = useSlaCoverageCheck()
  const [checkingSla, setCheckingSla] = useState(false)
  // Campi personalizzati del cliente (verifica «Cosa resta cablato», ondata 4).
  const { defs: customDefs } = useCreationCustomFieldDefs('service_request')
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({})
  // The tenant's field rules for requests (review of 23 Sep 2026): the server enforces them on create.
  const fieldRuleSet = useCreationFieldRules('service_request', { title, priority, description, dueDate, ...customValues }, customErrors)
  const { rules: fieldRules, error: fieldRulesError, shown, requiredMark, errorOf: ruleError } = fieldRuleSet
  const clearError = (field: string) => setCustomErrors((p) => { const n = { ...p }; delete n[field]; return n })

  /**
   * IL MODULO DELLA VOCE DI CATALOGO (moduli del catalogo, ondata 1).
   *
   * Si carica quando la voce è scelta e non prima: prima non c'è un modulo di
   * cui parlare. `catalogFormToFill` torna null se la voce non ha un modulo
   * pubblicato, e allora la pagina resta quella di sempre — non una pagina
   * vuota che sembra rotta.
   */
  const { data: formData, refetch: rileggiModulo } = useQuery<{ catalogFormToFill: { itemId: string; revision: number; definition: string; fields: CatalogFormFieldView[] } | null }>(
    GET_CATALOG_FORM_TO_FILL,
    { variables: { itemId: catalogItemId, endUser: false, language: i18n.language }, skip: !catalogItemId, fetchPolicy: 'cache-and-network' },
  )
  const modulo = formData?.catalogFormToFill ?? null
  const definizione: CatalogFormDefinition | null = useMemo(() => {
    if (!modulo) return null
    try { return JSON.parse(modulo.definition) as CatalogFormDefinition } catch { return null }
  }, [modulo])
  const [risposte, setRisposte] = useState<Record<string, FormAnswerValue>>({})
  /** I campi CALCOLATI del modulo: il loro valore non è una risposta da cancellare. */
  const calcolati = useMemo(
    () => new Set((modulo?.fields ?? []).filter((f) => f.formula && f.formula.trim() !== '').map((f) => f.name)),
    [modulo],
  )
  const [erroriModulo, setErroriModulo] = useState<Record<string, string>>({})

  /**
   * ALLEGATI E RIFERIMENTI (ondata 2).
   *
   * `bozzaId` è di UNA voce di catalogo, non della pagina: i file di un campo
   * allegato si caricano subito, su quella bozza, perché la richiesta non
   * esiste ancora. Alla creazione i file passano dalla bozza al ticket; se
   * questa pagina viene abbandonata, la manutenzione notturna li cancella.
   *
   * Cambiando voce la bozza ricomincia (`onSelectCatalogItem`): i file
   * caricati per le domande dell'altra voce non c'entrano più niente, e il
   * server li reclamava tutti — difetto riprodotto dal vivo il 17 set 2026.
   */
  const [bozzaId, setBozzaId] = useState(() => crypto.randomUUID())
  const [fileDelModulo, setFileDelModulo] = useState<Record<string, CatalogFormFile[]>>({})
  const [inCaricamento, setInCaricamento] = useState<string | null>(null)
  const [riferimenti, setRiferimenti] = useState<Record<string, CatalogFormReference[]>>({})
  /**
   * Le righe delle tabelle (ondata 7): stato del chiamante, come i file e i
   * riferimenti — una riga non è una risposta, quindi non sta in `risposte`.
   */
  const [righeTabelle, setRigheTabelle] = useState<Record<string, readonly CatalogFormTableRow[]>>({})
  const [cancellaAllegato] = useMutation(DELETE_ATTACHMENT, { onError: (e) => showError(e) })
  const apollo = useApolloClient()
  // I tipi di CI che una service request non può coinvolgere: servono alla
  // ricerca dei campi «riferimento alla CMDB» (ondata 9).
  const { excluded: ciEsclusi } = useTicketCIExclusions('service_request')

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
    // Refused: `onError` has already said why, and Apollo 4 rejects as well — uncaught, that was an «Uncaught (in promise)».
    const r = await cancellaAllegato({ variables: { id } }).catch(() => null)
    // Not removed on the server, not removed here: the file is still on the draft.
    if (!r?.data) return
    setFileDelModulo((p) => ({ ...p, [campo]: (p[campo] ?? []).filter((f) => f.id !== id) }))
  }

  /**
   * La ricerca dei candidati di un campo di riferimento. Query diverse per
   * genere, ognuna quella che la pagina corrispondente usa già: qui non si
   * inventa un endpoint nuovo.
   */
  const cercaRiferimento = async (campo: CatalogFormFieldView, query: string): Promise<CatalogFormReference[]> => {
    const fieldType = campo.fieldType
    if (fieldType === 'ref_ci') {
      /* I TIPI AMMESSI, se il campo li dichiara: `allCIs` li filtra già lato
         server (`ciTypes`). Vuoto = tutta la CMDB, com'era prima. */
      const tipi = campo.refTypes && campo.refTypes.length > 0 ? [...campo.refTypes] : undefined
      /* Il FILTRO del campo (19 set 2026): lo interpreta `allCIs`, che usa il
         costruttore condiviso della CMDB — qui si passa e basta. */
      const filtro = campo.refFilter != null && campo.refFilter !== '' ? campo.refFilter : undefined
      /*
       * LE ESCLUSIONI VALGONO ANCHE QUI (ondata 9). Un tipo di CI escluso per
       * le service request non si offre: il server rifiuta comunque la
       * creazione, ma offrire un CI che verrà rifiutato è una trappola —
       * l'utente compila tutto e scopre il no all'invio. Se la lettura non è
       * ancora arrivata (`undefined`) non si esclude niente, che è il
       * comportamento di prima: il rifiuto del server resta la difesa vera.
       */
      const esclusi = ciEsclusi && ciEsclusi.length > 0 ? [...ciEsclusi] : undefined
      const r = await apollo.query<{ allCIs: { items: Array<{ id: string; name: string }> } }>({
        query: GET_ALL_CIS,
        variables: {
          limit: 20, offset: 0, search: query,
          ...(tipi ? { ciTypes: tipi } : {}),
          ...(esclusi ? { excludeCiTypes: esclusi } : {}),
          ...(filtro ? { filters: filtro } : {}),
        },
        fetchPolicy: 'network-only',
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
  /*
   * UN VALORE CALCOLATO NON SI CANCELLA, anche se il suo campo è nascosto.
   *
   * La pulizia serve alle risposte DATE: una condizione che si spegne fa
   * dimenticare quello che era stato scritto, perché il server rifiuta un
   * campo nascosto che arriva comunque. Ma un campo CALCOLATO non è una
   * risposta: è un valore che il renderer produce e che le condizioni
   * guardano, esattamente come fa il server dal 17 set 2026 (le formule
   * girano per tutti i campi calcolati del modulo, la visibilità decide solo
   * cosa finisce sul ticket). E nell'invio i calcolati sono già esclusi da
   * `catalogFormAnswersToSend`.
   *
   * Cancellarlo faceva un CICLO INFINITO, misurato nel portale: il renderer lo
   * riscriveva, la pagina lo cancellava, l'oggetto cambiava identità, l'effetto
   * ripartiva — un giro di QuickJS ogni ~330 ms con il modulo fermo, per tutto
   * il tempo che la pagina resta aperta.
   */
  const cambiaRisposta = (name: string, value: FormAnswerValue) => {
    setErroriModulo((p) => { const n = { ...p }; delete n[name]; return n })
    setRisposte((precedenti) => {
      const aggiornate: Record<string, FormAnswerValue> = { ...precedenti, [name]: value }
      if (!definizione) return aggiornate
      const visibili = new Set(visibleCatalogFormItems(definizione, aggiornate as FormAnswers).map((i) => i.field))
      for (const chiave of Object.keys(aggiornate)) {
        if (!visibili.has(chiave) && !calcolati.has(chiave)) delete aggiornate[chiave]
      }
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
    const risposteBase = base
      .filter((a) => !isFormAttachmentType(tipoDi.get(a.name) ?? ''))
      .map((a) => {
        if (!isFormReferenceType(tipoDi.get(a.name) ?? '')) return a
        const scelto = riferimenti[a.name]?.[0]
        return { name: a.name, refIds: scelto ? [scelto.id] : [] }
      })
    /**
     * Le RIGHE delle tabelle (ondata 7) viaggiano in `rows`, con le celle per
     * nome di colonna: `catalogFormTableAnswers` tiene solo le tabelle visibili
     * e le righe con qualcosa dentro, la stessa regola del portale.
     */
    const tabelle = catalogFormTableAnswers(definizione, modulo.fields, risposte as FormAnswers, righeTabelle)
      .map((t) => ({ name: t.name, rows: t.rows.map((r) => ({ cells: Object.entries(r).map(([column, value]) => ({ column, value })) })) }))
    return [...risposteBase, ...tabelle]
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!title.trim() || !priority || loading || checkingSla) return
    if (fieldRulesError) {
      showError(fieldRulesError, t('toast.incident.fieldRulesUnavailable', { error: fieldRulesError.message }))
      return
    }
    const missing = [...new Set([...fieldRuleSet.missing(), ...missingCustomFields(customDefs, customValues, fieldRules)])]
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
        // The request takes the item's category and fulfilment team (the
        // server gives it both), and the SLA engine picks the policy with them:
        // asked with nulls, a category-scoped policy looked absent (review of 23 Sep 2026).
        category: selectedItem?.category ?? null,
        categoryLabel: selectedItem?.category ? (labelOf('category', selectedItem.category) ?? selectedItem.category) : null,
        teamId: selectedItem?.fulfillmentTeam?.id ?? null,
        teamName: selectedItem?.fulfillmentTeam?.name ?? null,
      })
    } catch (err) {
      showError(err, t('toast.request.slaCoverageUnavailable', { error: err instanceof Error ? err.message : String(err) }))
      return
    } finally {
      setCheckingSla(false)
    }
    if (decisione === 'cancelled') return
    // Not awaited: nothing follows, and a refusal is said by `onError` (Apollo 4 also rejects the promise).
    void createRequest({
      variables: {
        input: {
          title:       title.trim(),
          priority,
          description: description || undefined,
          // La scadenza del modulo va all'API (giro nel browser del 14 set 2026:
          // si raccoglieva e non si inviava).
          dueDate:     dueDate || undefined,
          catalogItemId: catalogItemId || undefined,
          ...(requestedFor ? { requestedForId: requestedFor.id } : {}),
          customFields: customFieldsInput(customDefs, customValues),
          // Le risposte al modulo della voce (moduli del catalogo, ondata 1).
          formAnswers: risposteDaInviare(),
          // La bozza su cui sono stati caricati i file dei campi allegato (ondata 2).
          formDraftId: Object.values(fileDelModulo).some((l) => l.length > 0) ? bozzaId : undefined,
          /**
           * La revisione che stiamo compilando (ondata 8): se l'amministratore
           * ripubblica il modulo mentre questa pagina è aperta, il server se ne
           * accorge e lo DICE, invece di rifiutare un campo che non abbiamo
           * mai visto.
           */
          formRevision: modulo?.revision,
          ...(decisione === 'accepted' ? { acknowledgeNoSla: true } : {}),
        },
      },
    })
  }

  return (
    <PageContainer>

      {/* Back link */}
      <BackLink onClick={() => navigate('/requests')}>{t('pages.createRequest.back')}</BackLink>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <DetailTitle>
          {t('pages.createRequest.title')}
        </DetailTitle>
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
            <Select
              id={ids.catalog}
              value={catalogItemId}
              onChange={(e) => onSelectCatalogItem(e.target.value)}
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
            </Select>
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
            <Input
              id={ids.title}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
              placeholder={t('pages.createRequest.titlePlaceholder')}
              {...focusHandlers(!!titleError)}
              style={{ borderColor: titleError ? 'var(--color-trigger-sla-breach)' : colors.border }}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{titleError}</p>
            )}
          </div>

          {/* Requested for (G28): the service desk opens a request for a colleague. */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor={ids.requestedFor} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('pages.createRequest.requestedFor')}
            </label>
            <UserPicker
              inputId={ids.requestedFor}
              label={t('pages.createRequest.requestedFor')}
              hint={t('pages.createRequest.requestedForHint')}
              value={requestedFor}
              onChange={setRequestedFor}
              clearLabel={t('pages.createRequest.requestedForMe')}
            />
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
                <Select
                  id={ids.priority}
                  value={priority}
                  onChange={(e) => { setPriority(e.target.value); if (submitted) setSubmitted(false) }}
                  disabled={priorityLoading}
                  aria-invalid={priorityError ? true : undefined}
                  {...focusHandlers(!!priorityError)}
                  style={{ paddingLeft: 30, borderColor: priorityError ? 'var(--color-trigger-sla-breach)' : colors.border }}
                >
                  {priorityLoading
                    ? <option value="">{t('common.loading')}</option>
                    : <>
                        <option value="" disabled>{t('pages.createRequest.priorityPlaceholder')}</option>
                        {priorityValues.map(v => (
                          <option key={v} value={v}>{labelOf('priority', v) ?? humanizeValue(v)}</option>
                        ))}
                      </>
                  }
                </Select>
              </div>
              {priorityError && (
                <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{priorityError}</p>
              )}
            </div>

            {/* Due date */}
            {shown('dueDate') && <div>
              <label htmlFor={ids.dueDate} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                {t('detail.dueDate')}{requiredMark('dueDate')}
              </label>
              <Input
                id={ids.dueDate}
                type="date"
                value={dueDate}
                aria-invalid={customErrors['dueDate'] ? true : undefined}
                onChange={(e) => { setDueDate(e.target.value); clearError('dueDate') }}
                {...focusHandlers(false)}
              />
              {ruleError('dueDate')}
            </div>}

          </div>

          {/* Description */}
          {shown('description') && <div style={{ marginBottom: 0 }}>
            <label htmlFor={ids.description} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('common.description')}{requiredMark('description')}
            </label>
            <Textarea
              id={ids.description}
              value={description}
              aria-invalid={customErrors['description'] ? true : undefined}
              onChange={(e) => { setDescription(e.target.value); clearError('description') }}
              placeholder={t('pages.createRequest.descriptionPlaceholder')}
              rows={4}
              {...focusHandlers(false)}
              style={{ minHeight: 120, resize: 'vertical' }}
            />
            {ruleError('description')}
          </div>}

          {/* Campi del cliente */}
          {customDefs.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <CustomFieldsForm
                defs={customDefs}
                values={customValues}
                rules={fieldRules}
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
                computedLabel={t('pages.catalogForms.fill.computed')}
                tables={righeTabelle}
                onTablesChange={(campo, rows) => { setRigheTabelle((p) => ({ ...p, [campo]: rows })) }}
                tableAddRowLabel={t('pages.catalogForms.fill.addRow')}
                tableRemoveRowLabel={t('pages.catalogForms.fill.removeRow')}
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
                referenceSearchFailedLabel={t('pages.catalogForms.fill.searchFailed')}
              />
            </div>
          )}

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, marginTop: 32, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <Button variant="secondary"
              onClick={() => navigate('/requests')}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="primary"
              type="submit"
              disabled={loading || checkingSla}
            >
              {loading ? t('common.creating') : t('pages.createRequest.submit')}
            </Button>
          </div>

        </form>
      </div>
    </PageContainer>
  )
}
