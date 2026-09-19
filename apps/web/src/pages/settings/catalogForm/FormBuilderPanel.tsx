/**
 * IL COSTRUTTORE del modulo di una voce di catalogo (ondata 1).
 *
 * Si scelgono la voce e poi le sezioni; dentro ogni sezione si pescano i campi
 * dalla LIBRERIA (non si creano qui: un campo è una proprietà dei ticket, e
 * nasce in libreria). Per ogni campo il modulo può sovrascrivere
 * obbligatorietà, larghezza, aiuto e la condizione che lo mostra.
 *
 * L'ANTEPRIMA usa lo STESSO componente che compilano l'area di lavoro e il
 * portale (`CatalogFormRenderer`), non una finta: quello che si vede qui è
 * quello che vedrà chi compila, condizioni comprese — si può rispondere
 * nell'anteprima e guardare i campi comparire. Il disegnatore dei tipi ITIL ha
 * un'anteprima che azzera gli script e rende un modulo piatto; questa no.
 *
 * SALVARE PUBBLICA. Non ci sono bozze nell'ondata 1: si salva e la revisione
 * sale. I ticket già compilati non cambiano, perché portano la loro revisione.
 *
 * ## Quello che il 18 set 2026 ha cambiato, e perché
 * Il proprietario ha costruito un modulo dal vivo e ha trovato quattro cose.
 *
 *  - **Il campo è finito sulla voce sbagliata.** La tendina si apriva già
 *    posizionata sulla prima voce attiva, e pubblicare scriveva lì. Ora non
 *    c'è nessuna voce preselezionata e la pubblicazione chiede conferma
 *    NOMINANDO la voce: l'errore non si previene con un avviso, si previene
 *    togliendo il default che lo causava.
 *  - **Una sezione senza titolo si pubblicava in silenzio.** Ora il titolo si
 *    scrive in tutte e due le lingue e il server rifiuta: una sezione anonima
 *    la scopre chi apre il modulo, che è la persona sbagliata.
 *  - **Le sezioni non si potevano riordinare**, e per due colonne bisognava
 *    spuntare «Mezza larghezza» campo per campo.
 *  - **I campi si pescavano da una tendina.** Ora si TRASCINANO dalla scheda
 *    «Campi» sulla destra. Il trascinamento non esiste da tastiera: ogni
 *    maniglia è un bottone che si sposta con ↑ e ↓, e ogni campo della palette
 *    si aggiunge anche con Invio — senza questo, il costruttore sarebbe
 *    diventato inutilizzabile per chi non usa il mouse.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  CATALOG_FORM_VERSION, FORM_CONDITION_OPS, FORM_CONDITION_OPS_WITHOUT_VALUE, FORM_FIELD_TYPES,
  canBeConditionSubject, emptyCatalogForm, isFormReferenceType, localizedText, nomeDaEtichetta,
  type CatalogFormDefinition, type CatalogFormItem, type CatalogFormSection,
  type FormAnswerValue, type FormAnswers, type FormCondition, type FormConditionOp,
} from '@opengraphity/types'
import { CatalogFormRenderer } from '@opengraphity/web-core'
import { GET_CATALOG_FORM, GET_ENUM_TYPES, GET_FORM_FIELDS, GET_SERVICE_CATALOG_ADMIN, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { CREATE_FORM_FIELD, CREATE_SERVICE_CATALOG_ITEM, SAVE_CATALOG_FORM, UPDATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { useConfirm } from '@/hooks/useConfirm'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { alpha, colors, fontWeight, palette } from '@/lib/tokens'
import { Input, LabelledField, Select } from '@/components/ui/FormControls'
import type { FormFieldRow } from './FieldLibraryPanel'
import { FieldEditor, inputDaBozza, BOZZA_VUOTA, type Bozza } from './FieldEditor'
import { FormCanvas, IconaTipo, type Selezione } from './FormCanvas'
import { EditorDelCampoDiLibreria, ProprietaSezione, ProprietaVoce } from './ItemProperties'
import { ModaleCentrato } from './ModaleCentrato'

interface CatalogItem { id: string; name: string; active: boolean; category: string | null }

const bottone: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer',
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}
const iconaAzione: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 3 }

/*
 * IL TRASCINAMENTO SI FA COI POINTER EVENT, NON CON HTML5 (18 set 2026).
 *
 * La prima versione usava `draggable` + `dragstart`/`drop`, che è il modo
 * standard sul desktop e NON ESISTE sul touch: su iPad e iPhone il dito non
 * genera mai un `dragstart`, quindi il costruttore dei moduli si poteva usare
 * solo da una tastiera e un mouse. Il proprietario l'ha trovato esattamente
 * così — «non riesco a trascinare il campo nelle sezioni», da iPad — e non
 * c'era nessun modo di accorgersene da qui: il difetto non è nel codice che si
 * legge, è nella piattaforma che non chiama mai quel codice.
 *
 * I pointer event sono UNO SOLO per mouse, dito e penna. In cambio va scritto
 * a mano quello che il browser regalava:
 *
 *  - il BERSAGLIO sotto il puntatore, che si trova con `elementFromPoint` e
 *    l'attributo `data-drop` (il DOM, non gli handler di React);
 *  - l'OMBRA che segue il dito, perché senza niente che si muove il gesto
 *    sembra non essere partito;
 *  - lo SCORRIMENTO ai bordi, altrimenti si può lasciar cadere solo su quello
 *    che è già a schermo — su un modulo di sei sezioni è mezzo modulo.
 *
 * `touch-action: none` sulle maniglie è obbligatorio: senza, il dito che
 * scende scorre la pagina invece di trascinare.
 */

/** Cosa si sta portando in giro. */
type Trascinato =
  | { tipo: 'palette'; campo: string }
  /** Un TIPO di campo preso dalla palette: il campo non esiste ancora. */
  | { tipo: 'newField'; fieldType: string }
  | { tipo: 'item'; sezione: number; voce: number }
  | { tipo: 'section'; sezione: number }

/**
 * Le zone in cui si può lasciar cadere, dichiarate nel DOM con `data-drop`:
 * `sec-2` è la sezione 2, `ord-2` la sua intestazione (riordino), `item-2-3`
 * la voce 3 di quella sezione.
 */
type Zona =
  | { dove: 'section' | 'order'; iSez: number }
  | { dove: 'item'; iSez: number; iVoce: number }

function leggiZona(z: string): Zona | null {
  const p = z.split('-')
  if (p[0] === 'sec'  && p.length === 2) return { dove: 'section', iSez: Number(p[1]) }
  if (p[0] === 'ord'  && p.length === 2) return { dove: 'order',   iSez: Number(p[1]) }
  if (p[0] === 'item' && p.length === 3) return { dove: 'item', iSez: Number(p[1]), iVoce: Number(p[2]) }
  return null
}

/** Una zona accetta quello che si sta trascinando? */
function zonaBuona(cosa: Trascinato, z: Zona): boolean {
  // Una sezione si lascia cadere su un'altra sezione, dovunque dentro: col
  // dito, prendere la mira sulla sola intestazione è una richiesta assurda.
  if (cosa.tipo === 'section') return z.dove !== 'item'
  // Un campo NON si lascia cadere sull'intestazione: lì si riordinano sezioni.
  return z.dove !== 'order'
}

/** Il contenitore che scorre davvero attorno a un elemento (per lo scorrimento ai bordi). */
function contenitoreScorrevole(el: Element | null): Element | null {
  let n = el
  while (n && n !== document.body) {
    const s = getComputedStyle(n)
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n
    n = n.parentElement
  }
  return document.scrollingElement
}

interface Trascinamento {
  trascinato: Trascinato | null
  /** La zona evidenziata, come stringa `data-drop`: la vista la confronta e basta. */
  bersaglio: string | null
  etichetta: string
  posizione: { x: number; y: number } | null
  afferra: (e: React.PointerEvent | React.TouchEvent, cosa: Trascinato, etichetta: string) => void
}

/**
 * IL MOTORE DEL TRASCINAMENTO. Tiene cosa si trascina, dove si è sopra e dove
 * sta il dito; chi chiama riceve il rilascio già risolto in (cosa, zona).
 */
function useTrascinamento(onRilascio: (cosa: Trascinato, zona: Zona) => void): Trascinamento {
  const [trascinato, setTrascinato] = useState<Trascinato | null>(null)
  const [bersaglio,  setBersaglio]  = useState<string | null>(null)
  const [etichetta,  setEtichetta]  = useState('')
  const [posizione,  setPosizione]  = useState<{ x: number; y: number } | null>(null)

  // Lo stato VIVO del gesto: gli ascoltatori globali leggerebbero dalla
  // chiusura uno stato vecchio di un render.
  const corso = useRef<{ cosa: Trascinato | null; zona: Zona | null }>({ cosa: null, zona: null })
  const dove  = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const scorrevole = useRef<Element | null>(null)
  const smonta = useRef<(() => void) | null>(null)
  const rilascio = useRef(onRilascio)
  useEffect(() => { rilascio.current = onRilascio })
  // Un gesto in corso quando il pannello sparisce lascerebbe gli ascoltatori
  // attaccati a `window`.
  useEffect(() => () => { smonta.current?.() }, [])

  /**
   * GLI ASCOLTATORI SI ATTACCANO QUI, NON IN UN `useEffect`.
   *
   * Nella prima stesura stavano in un effetto su `trascinato`, cioè partivano
   * DOPO il render: un gesto veloce — un trascinamento col dito, o due eventi
   * sintetici di fila — finiva prima che gli ascoltatori esistessero, e non
   * succedeva niente. Visto dal vivo nel browser il 18 set 2026: `pointerdown`,
   * due `pointermove` e `pointerup` tutti arrivati, e nessun campo aggiunto.
   * Un gesto va ascoltato dall'istante in cui comincia.
   */
  const afferra = (e: React.PointerEvent | React.TouchEvent, cosa: Trascinato, testo: string) => {
    /*
     * SU iOS IL GESTO LO GUIDANO I TOUCH EVENT, NON I POINTER EVENT.
     *
     * Safari manda `pointercancel` appena decide che il gesto è suo — uno
     * scorrimento, una selezione di testo, il menù della pressione lunga — e
     * il trascinamento muore a metà: `touch-action: none` non basta a
     * togliergli quella decisione. I touch event invece restano, e un
     * `touchmove` non passivo con `preventDefault` ferma lo scorrimento per
     * davvero.
     *
     * Il dito genera ENTRAMBE le famiglie di eventi: il ramo pointer ignora
     * `pointerType: 'touch'`, se no lo stesso gesto verrebbe guidato due volte.
     * Trovato dal proprietario su iPad il 18 set 2026, col codice a pointer
     * event già in linea e funzionante col mouse.
     */
    const conDito = 'touches' in e
    if (!conDito) {
      const pe = e as React.PointerEvent
      if (pe.pointerType === 'touch') return
      if (!pe.isPrimary || (pe.pointerType === 'mouse' && pe.button !== 0)) return
      // Senza questo il mouse seleziona il testo mentre si trascina.
      pe.preventDefault()
    }
    const partenza = conDito ? (e as React.TouchEvent).touches[0] : (e as React.PointerEvent)
    if (!partenza) return
    const x0 = partenza.clientX
    const y0 = partenza.clientY
    smonta.current?.()
    corso.current = { cosa, zona: null }
    dove.current = { x: x0, y: y0 }
    // Il contenitore da scorrere è quello DEI BERSAGLI, non quello della
    // presa: da quando la palette ha uno scorrimento suo, partire da lì
    // avrebbe scorso la palette invece della pagina.
    scorrevole.current = contenitoreScorrevole(document.querySelector('[data-drop]') ?? e.currentTarget)
    setTrascinato(cosa); setEtichetta(testo); setBersaglio(null)
    setPosizione({ x: x0, y: y0 })

    /** La zona sotto il puntatore: la più interna che accetta quello che porto. */
    const zonaSotto = (x: number, y: number): { chiave: string; zona: Zona } | null => {
      let n: Element | null | undefined = document.elementFromPoint(x, y)
      while (n) {
        const el: Element | null = n.closest('[data-drop]')
        if (!el) return null
        const chiave = el.getAttribute('data-drop') ?? ''
        const zona = leggiZona(chiave)
        if (zona && zonaBuona(cosa, zona)) return { chiave, zona }
        n = el.parentElement
      }
      return null
    }

    const aggiorna = (x: number, y: number) => {
      const trovata = zonaSotto(x, y)
      corso.current.zona = trovata?.zona ?? null
      setBersaglio(trovata?.chiave ?? null)
    }

    const spostaA = (x: number, y: number) => {
      dove.current = { x, y }
      setPosizione({ x, y })
      aggiorna(x, y)
    }

    const muovi = (ev: PointerEvent) => {
      ev.preventDefault()
      spostaA(ev.clientX, ev.clientY)
    }
    const muoviDito = (ev: TouchEvent) => {
      const p = ev.touches[0]
      if (!p) return
      // Non passivo di proposito: è QUESTO che impedisce alla pagina di
      // scorrere sotto il dito mentre si trascina.
      ev.preventDefault()
      spostaA(p.clientX, p.clientY)
    }

    /*
     * LO SCORRIMENTO AI BORDI. Con HTML5 lo faceva il browser; qui no, e senza
     * si può lasciar cadere solo su quello che è già a schermo — su un modulo
     * lungo, o su uno schermo stretto dove la palette sta sotto le sezioni, è
     * quasi tutto. Si ricalcola anche il bersaglio a ogni fotogramma: il dito
     * sta fermo ma il contenuto scorre, e l'evidenza resterebbe dov'era.
     */
    const MARGINE = 70
    let animazione = requestAnimationFrame(function passo() {
      const { x, y } = dove.current
      const velocita = y < MARGINE ? -12 : y > window.innerHeight - MARGINE ? 12 : 0
      const c = scorrevole.current
      if (velocita !== 0 && c) { c.scrollTop += velocita; aggiorna(x, y) }
      animazione = requestAnimationFrame(passo)
    })

    const chiudi = () => {
      cancelAnimationFrame(animazione)
      window.removeEventListener('pointermove', muovi)
      window.removeEventListener('pointerup', molla)
      window.removeEventListener('pointercancel', annulla)
      window.removeEventListener('touchmove', muoviDito)
      window.removeEventListener('touchend', mollaDito)
      window.removeEventListener('touchcancel', annulla)
      window.removeEventListener('keydown', tasto)
      smonta.current = null
      corso.current = { cosa: null, zona: null }
      setTrascinato(null); setBersaglio(null); setPosizione(null)
    }
    /**
     * Il bersaglio si rilegge dal punto in cui si è lasciato: con un gesto
     * veloce l'ultimo movimento può mancare, e il rilascio cadrebbe nel vuoto
     * pur essendo il dito nel posto giusto.
     */
    const lascia = (x: number, y: number) => {
      const { cosa: c, zona } = corso.current
      const finale = zonaSotto(x, y)?.zona ?? zona
      if (c && finale) rilascio.current(c, finale)
      chiudi()
    }
    function molla(ev: PointerEvent) { lascia(ev.clientX, ev.clientY) }
    function mollaDito(ev: TouchEvent) {
      const p = ev.changedTouches[0]
      // `changedTouches` e non `touches`: al `touchend` il dito non è più
      // nell'elenco di quelli appoggiati, e `touches` è vuoto.
      if (p) lascia(p.clientX, p.clientY)
      else chiudi()
    }
    function annulla() { chiudi() }
    // `Escape` annulla: un gesto partito per sbaglio deve avere un'uscita che
    // non sposta niente.
    function tasto(ev: KeyboardEvent) { if (ev.key === 'Escape') chiudi() }

    if (conDito) {
      window.addEventListener('touchmove', muoviDito, { passive: false })
      window.addEventListener('touchend', mollaDito)
      window.addEventListener('touchcancel', annulla)
    } else {
      window.addEventListener('pointermove', muovi, { passive: false })
      window.addEventListener('pointerup', molla)
      window.addEventListener('pointercancel', annulla)
    }
    window.addEventListener('keydown', tasto)
    smonta.current = chiudi
  }

  return { trascinato, bersaglio, etichetta, posizione, afferra }
}

/**
 * L'OMBRA CHE SEGUE IL DITO. Con HTML5 la disegnava il browser; togliendolo
 * sparirebbe, e un trascinamento in cui non si muove niente si legge come un
 * gesto che non è partito — che è esattamente il difetto che stiamo correggendo.
 */
function OmbraTrascinata({ etichetta, posizione }: { etichetta: string; posizione: { x: number; y: number } }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed', left: posizione.x + 12, top: posizione.y + 12, zIndex: 1000,
        pointerEvents: 'none', padding: '5px 10px', borderRadius: 7,
        background: 'var(--color-brand)', color: colors.white,
        fontSize: 'var(--font-size-table)', boxShadow: `0 4px 14px ${alpha.black20}`,
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      {etichetta}
    </div>
  )
}

/**
 * LA MANIGLIA: si trascina col dito e si sposta con la tastiera.
 *
 * È un BOTTONE, non un `div` da trascinare: così entra nel giro dei tab, la
 * legge un lettore di schermo, e `↑`/`↓` spostano l'elemento senza trascinare
 * niente. Il trascinamento è il gesto comodo; la tastiera è quello che rende
 * la pagina usabile — e questa è l'unica pagina da cui si compone un modulo,
 * quindi non poteva restare solo col mouse (18 set 2026).
 */
function Maniglia({ etichetta, onAfferra, onSu, onGiu, evidenziata }: {
  etichetta: string
  onAfferra: (e: React.PointerEvent | React.TouchEvent) => void
  onSu: () => void
  onGiu: () => void
  evidenziata?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={etichetta}
      title={etichetta}
      onPointerDown={(e) => { e.currentTarget.focus(); onAfferra(e) }}
      onTouchStart={onAfferra}
      className="og-grip"
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp')   { e.preventDefault(); onSu() }
        if (e.key === 'ArrowDown') { e.preventDefault(); onGiu() }
      }}
      style={{
        background: evidenziata ? 'var(--color-brand-light)' : 'none',
        border: evidenziata ? '1px solid var(--color-brand)' : '1px solid transparent',
        borderRadius: 5, cursor: 'grab', color: 'var(--color-slate-light)', padding: '3px 1px',
        // `alignItems` lo decide `.og-grip`: al centro col mouse, in alto col
        // dito (dove il bottone è alto 44px e un'icona centrata finirebbe
        // sotto la riga dell'etichetta).
        display: 'flex', flex: '0 0 auto',
        // Il resto della presa (niente scorrimento, niente selezione, 44px
        // col dito) sta in `.og-grip`: è una regola di tutta l'app, non di
        // questa maniglia.
      }}
    >
      <GripVertical size={14} />
    </button>
  )
}

/** Un identificativo di sezione stabile e valido (minuscole, cifre, trattino basso). */
function idSezione(esistenti: readonly string[]): string {
  for (let i = 1; i < 999; i++) {
    const candidato = `section_${i}`
    if (!esistenti.includes(candidato)) return candidato
  }
  return `section_${Date.now()}`
}

export function FormBuilderPanel() {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const lingua = i18n.language

  const { data: catalogData, refetch: rileggiVoci } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const voci = (catalogData?.serviceCatalogItems ?? []).filter((v) => v.active)
  /*
   * NESSUNA VOCE PRESELEZIONATA (18 set 2026).
   *
   * Qui c'era un `useEffect` che sceglieva `voci[0]`. Dal vivo è costato un
   * campo pubblicato sulla voce sbagliata: il costruttore si apriva su
   * «Accesso a un'applicazione» — la prima attiva — e chi voleva disegnare il
   * modulo di un'altra voce non se n'è accorto. Un default comodo che sceglie
   * al posto tuo su un'operazione che scrive è un difetto, non una comodità.
   */
  const [voceId, setVoceId] = useState('')
  const voceScelta = voci.find((v) => v.id === voceId) ?? null

  /** Le lingue del prodotto, dal server: sono le stesse che la pubblicazione pretende sul titolo. */
  const { data: lingueData } = useQuery<{ tenantLanguageSettings: { available: string[] } }>(GET_TENANT_LANGUAGE_SETTINGS)
  const lingue = lingueData?.tenantLanguageSettings.available ?? ['en', 'it']

  const { data: libreriaData, refetch: rileggiLibreria } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language: lingua }, fetchPolicy: 'cache-and-network',
  })
  // `?? []` crea un array nuovo a ogni render: dentro le dipendenze di un
  // useMemo lo farebbe ricalcolare sempre (avviso react-hooks).
  const libreria = useMemo(() => libreriaData?.formFields ?? [], [libreriaData])
  const perNome = useMemo(() => {
    const m = new Map<string, FormFieldRow>()
    for (const f of libreria) m.set(f.name, f)
    return m
  }, [libreria])

  const { data: formData, refetch } = useQuery<{ catalogForm: { itemId: string; itemName: string; revision: number; definition: string } }>(
    GET_CATALOG_FORM, { variables: { itemId: voceId }, skip: !voceId, fetchPolicy: 'network-only' },
  )

  const [bozza, setBozza] = useState<CatalogFormDefinition>(emptyCatalogForm())
  const [toccato, setToccato] = useState(false)
  useEffect(() => {
    if (!formData?.catalogForm) return
    try { setBozza(JSON.parse(formData.catalogForm.definition) as CatalogFormDefinition) }
    catch { setBozza(emptyCatalogForm()) }
    setToccato(false)
  }, [formData])

  /**
   * CAMBIARE VOCE NON BUTTA IL DISEGNO SENZA CHIEDERE.
   *
   * `toccato` disabilitava solo il pulsante «Pubblica»: sfiorare la tendina
   * delle voci — o passare alla «Libreria dei campi» per aggiungere un campo
   * che serve, cioè il caso descritto nel commento in testa a questa pagina —
   * ricaricava la definizione salvata e il lavoro svaniva in silenzio
   * (revisione del 17 set 2026).
   */
  const chiediPrimaDiPerdere = async (): Promise<boolean> => {
    if (!toccato) return true
    return await confirm({
      title: t('pages.catalogForms.builder.discardTitle'),
      body:  t('pages.catalogForms.builder.discardBody'),
      danger: true,
    })
  }
  const cambiaVoce = async (id: string) => {
    if (!(await chiediPrimaDiPerdere())) return
    setVoceId(id)
  }

  const [risposteAnteprima, setRisposteAnteprima] = useState<Record<string, FormAnswerValue>>({})
  const [salva, { loading: salvando }] = useMutation(SAVE_CATALOG_FORM, { onError: (e) => showError(e) })

  const cambia = (f: (d: CatalogFormDefinition) => CatalogFormDefinition) => {
    setBozza((d) => f(d))
    setToccato(true)
  }

  const sostituisciSezione = (indice: number, s: CatalogFormSection) =>
    cambia((d) => ({ ...d, sections: d.sections.map((x, i) => (i === indice ? s : x)) }))

  /*
   * IL TRASCINAMENTO, con la tastiera accanto.
   *
   * Il motore sta in `useTrascinamento` (pointer event: mouse, dito e penna);
   * qui c'è solo cosa SIGNIFICA lasciar cadere una cosa in una zona. Ogni
   * maniglia resta un bottone con `↑` e `↓`: il trascinamento non esiste da
   * tastiera, e questa pagina è l'unico posto da cui si compone un modulo.
   */
  const trascinamento = useTrascinamento((cosa, zona) => {
    if (cosa.tipo === 'section') {
      if (zona.dove !== 'item') muoviSezione(cosa.sezione, zona.iSez)
      return
    }
    /*
     * UN TIPO non è un campo: il campo non esiste ancora, e il suo NOME sarà
     * una proprietà del ticket che non si cambia più. Quindi il rilascio non
     * crea niente: apre l'editor dove il campo è caduto e chiede l'etichetta.
     * Creare in silenzio un `campo_1` avrebbe riempito la libreria — che è
     * condivisa da tutti i moduli — di nomi che nessuno sa più cosa siano.
     */
    if (cosa.tipo === 'newField') {
      setNuovoCampo({
        iSez: zona.iSez,
        iVoce: zona.dove === 'item' ? zona.iVoce : null,
        bozza: { ...BOZZA_VUOTA, fieldType: cosa.fieldType },
      })
      setSezioneCorrente(zona.iSez)
      return
    }
    // Cadere SU una voce inserisce PRIMA di quella; cadere sulla sezione
    // accoda in fondo — è come si legge un elenco.
    const posto = zona.dove === 'item' ? zona.iVoce : (bozza.sections[zona.iSez]?.items.length ?? 0)
    if (cosa.tipo === 'palette') aggiungiCampo(zona.iSez, cosa.campo, zona.dove === 'item' ? posto : undefined)
    else muoviVoce(cosa.sezione, cosa.voce, zona.iSez, posto)
  })
  const { bersaglio } = trascinamento

  /**
   * IL CAMPO NUOVO IN CORSO DI BATTESIMO: tipo, dove cadrà, e le etichette che
   * si stanno scrivendo. Finché è qui non esiste niente sul server.
   */
  interface NuovoCampo {
    iSez:  number
    /** `null` = in fondo alla sezione. */
    iVoce: number | null
    /** Tutto il campo che si sta scrivendo: è la stessa bozza della libreria. */
    bozza: Bozza
  }
  const [nuovoCampo, setNuovoCampo] = useState<NuovoCampo | null>(null)
  const [creando, setCreando] = useState(false)
  /* `Escape` chiude il modale. Sta su `window` e non sul riquadro: il fuoco è
     dentro una casella dell'editor, e un gestore sul contenitore lo prende
     solo per caso — oltre a essere un ascoltatore su un elemento che non è
     interattivo, che è quello che dice il lint. */
  useEffect(() => {
    if (!nuovoCampo) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setNuovoCampo(null) }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('keydown', esc) }
  }, [nuovoCampo])
  const [creaCampo] = useMutation(CREATE_FORM_FIELD, { onError: (e) => showError(e) })
  const { data: enumData } = useQuery<{ enumTypes: Array<{ name: string; label: string }> }>(GET_ENUM_TYPES, { fetchPolicy: 'cache-first' })

  /** La sezione che riceve un campo aggiunto da tastiera: l'ultima toccata. */
  const [sezioneCorrente, setSezioneCorrente] = useState(0)
  /** La colonna destra: i campi da trascinare, oppure il modulo vero. */
  /** La tela o l'anteprima compilabile: due modi di guardare lo stesso modulo. */
  const [vista, setVista] = useState<'canvas' | 'preview'>('canvas')
  /**
   * QUELLO CHE È SELEZIONATO SULLA TELA, e di cui il modale mostra le
   * proprietà. Null = niente selezionato, e allora il modale non c'è: la tela
   * si guarda, non chiede niente.
   */
  const [selezione, setSelezione] = useState<Selezione | null>(null)
  /*
   * GLI ATTREZZI SONO UN ACCORDION, CHIUSO IN PARTENZA (deciso dal
   * proprietario, 18 set 2026). Due elenchi aperti — quattordici tipi più i
   * campi della libreria — riempivano la colonna e spingevano la tela in
   * fondo; e aperti tutti e due si scorre per arrivare al secondo. Uno per
   * volta: aprire il secondo chiude il primo.
   */
  const [attrezziAperti, setAttrezziAperti] = useState<'library' | 'types' | null>(null)
  /*
   * IL CAMPO SI MODIFICA DA DOVE LO SI GUARDA (18 set 2026).
   *
   * Cliccando un campo sulla tela si cambiava solo come sta in QUESTO modulo —
   * obbligatorio, larghezza, portale, condizione — e per l'etichetta, l'aiuto,
   * il vocabolario o lo script bisognava andare nella Libreria, cercarlo e
   * aprirlo: «dovrei poter cambiare le sue proprietà così come quando lo
   * inserisco».
   *
   * Qui c'è la bozza del campo di libreria mentre la si modifica; `null`
   * quando il blocco è chiuso. È lo STESSO editor della creazione, quindi
   * niente può esserci lì e mancare qui.
   */
  /*
   * LA VOCE DI CATALOGO SI CREA DA QUI (18 set 2026).
   *
   * «Per creare una service request devo prima creare la voce e poi andare nel
   * designer: preferirei fare tutto direttamente nel designer.» Ha ragione: la
   * voce e il suo modulo sono la stessa cosa vista da due parti, e mandare
   * qualcuno in un'altra pagina per il primo passo di un lavoro che continua
   * qui e un percorso che si dimentica a meta.
   *
   * Si chiede il minimo che il catalogo pretende — nome e priorita — piu le
   * due cose che si decidono all'inizio e non dopo: la categoria (da lei
   * dipende quale workflow segue) e se serve un'approvazione.
   */
  const [nuovaVoce, setNuovaVoce] = useState<{ name: string; description: string; category: string; priority: string; requiresApproval: boolean } | null>(null)
  const [creandoVoce, setCreandoVoce] = useState(false)
  const [creaVoce] = useMutation(CREATE_SERVICE_CATALOG_ITEM, { onError: (e) => showError(e) })
  const { entriesOf } = useDomainVocabularies()

  const [campoInModifica, setCampoInModifica] = useState<Bozza | null>(null)
  const [salvandoCampo, setSalvandoCampo] = useState(false)
  const [aggiornaCampo] = useMutation(UPDATE_FORM_FIELD, { onError: (e) => showError(e) })
  const idVoce = useId()

  const sostituisciVoce = (iSez: number, iVoce: number, v: CatalogFormItem) =>
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i !== iSez ? s : { ...s, items: s.items.map((x, j) => (j === iVoce ? v : x)) })),
    }))

  /** Sposta una sezione da una posizione all'altra. */
  const muoviSezione = (da: number, a: number) => {
    if (a < 0 || a >= bozza.sections.length || a === da) return
    cambia((d) => ({ ...d, sections: sposta(d.sections, da, a) }))
    setSezioneCorrente(a)
  }

  /**
   * Sposta un campo, anche DA UNA SEZIONE A UN'ALTRA: è la cosa che si vuole
   * fare più spesso quando un modulo cresce, e con le sole frecce non si
   * poteva fare affatto.
   */
  const muoviVoce = (daSez: number, daVoce: number, aSez: number, aVoce: number) => {
    if (daSez === aSez && (aVoce === daVoce || aVoce === daVoce + 1)) return
    cambia((d) => {
      const item = d.sections[daSez]?.items[daVoce]
      if (!item) return d
      const sezioni = d.sections.map((s, i) => (i !== daSez ? s : { ...s, items: s.items.filter((_, j) => j !== daVoce) }))
      const indice = daSez === aSez && aVoce > daVoce ? aVoce - 1 : aVoce
      return {
        ...d,
        sections: sezioni.map((s, i) => (i !== aSez ? s : { ...s, items: [...s.items.slice(0, indice), item, ...s.items.slice(indice)] })),
      }
    })
  }

  /**
   * Aggiunge un campo della libreria a una sezione, in una posizione.
   *
   * Un RIFERIMENTO nasce non offerto nel portale: scegliere un CI o una
   * persona vuol dire cercarli, e un utente finale non naviga la CMDB. L'API
   * rifiuta il modulo che lo offre, quindi è giusto che il costruttore non ci
   * arrivi nemmeno.
   */
  const aggiungiCampo = (iSez: number, nome: string, indice?: number) => {
    const scelto = perNome.get(nome)
    const voceNuova: CatalogFormItem = scelto && isFormReferenceType(scelto.fieldType)
      ? { field: nome, endUser: false }
      : { field: nome }
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => {
        if (i !== iSez) return s
        const dove = indice ?? s.items.length
        return { ...s, items: [...s.items.slice(0, dove), voceNuova, ...s.items.slice(dove)] }
      }),
    }))
    setSezioneCorrente(iSez)
  }

  /**
   * CREA IL CAMPO E LO METTE DOVE È CADUTO.
   *
   * Il campo nasce nella LIBRERIA — è condiviso da tutti i moduli, e il suo
   * nome diventa una proprietà del ticket — e solo dopo entra nel modulo. Se
   * la creazione fallisce (nome riservato, libreria piena, vocabolario
   * inesistente) non si tocca la bozza: meglio niente che una voce che punta
   * a un campo che non c'è.
   */
  const confermaNuovoCampo = async () => {
    if (!nuovoCampo) return
    const b = nuovoCampo.bozza
    const comune = inputDaBozza(b, b.fieldType)
    if (comune.label === '') { toast.error(t('pages.catalogForms.library.labelNeeded')); return }
    const nome = b.name.trim() === '' ? nomeDaEtichetta(comune.label, libreria.map((f) => f.name)) : b.name.trim()
    setCreando(true)
    try {
      const r = await creaCampo({ variables: { input: { ...comune, name: nome, fieldType: b.fieldType } } })
      if (!r.data) return
      // La libreria si rilegge PRIMA di mettere la voce nella bozza: se no la
      // riga comparirebbe col nome tecnico al posto dell'etichetta.
      await rileggiLibreria()
      aggiungiCampo(nuovoCampo.iSez, nome, nuovoCampo.iVoce ?? undefined)
      setNuovoCampo(null)
    } catch {
      /*
       * L'avviso lo mostra già il link degli errori di Apollo, tradotto: qui
       * si prende il rifiuto solo per non lasciare una promessa non gestita, e
       * si TIENE APERTO il modale — chi ha appena scritto dieci caselle deve
       * correggere quello che non va, non ricominciare.
       */
    } finally { setCreando(false) }
  }

  /**
   * IL MODALE DEL CAMPO NUOVO.
   *
   * Dentro c'è l'EDITOR DELLA LIBRERIA, lo stesso: etichette, aiuto,
   * obbligatorio, colonna nelle liste, il vocabolario di una tendina, le
   * colonne di una tabella, la formula e lo script di validazione. Un editor
   * ridotto avrebbe voluto dire che certe cose si possono impostare solo
   * sapendo che esiste un'altra scheda — ed è esattamente il difetto da cui
   * è nata la palette dei tipi.
   *
   * Un modale e non più un riquadro in linea: le caselle sono tante (compreso
   * il JavaScript), e infilarle dentro la sezione spingeva il modulo in fondo
   * allo schermo proprio mentre lo si sta guardando.
   */
  const modaleNuovaVoce = () => {
    if (!nuovaVoce) return null
    const pronto = nuovaVoce.name.trim() !== '' && nuovaVoce.priority !== ''
    return (
      <ModaleCentrato
        titolo={t('pages.catalogForms.builder.newItemTitle')}
        sottotitolo={t('pages.catalogForms.builder.newItemHelp')}
        largo={560}
        onChiudi={() => { setNuovaVoce(null) }}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <LabelledField label={t('pages.catalogForms.builder.newItemName')}>
            <Input value={nuovaVoce.name} onChange={(e) => { setNuovaVoce({ ...nuovaVoce, name: e.target.value }) }} />
          </LabelledField>
          <LabelledField label={t('pages.catalogForms.builder.newItemDescription')}>
            <Input value={nuovaVoce.description} onChange={(e) => { setNuovaVoce({ ...nuovaVoce, description: e.target.value }) }} />
          </LabelledField>
          <div className="og-pair">
            {/* La CATEGORIA non e un'etichetta: da lei dipende quale workflow
                segue la richiesta, se questa voce non ne fissa uno suo. */}
            <LabelledField label={t('pages.catalogForms.builder.newItemCategory')}>
              <Select value={nuovaVoce.category} onChange={(e) => { setNuovaVoce({ ...nuovaVoce, category: e.target.value }) }}>
                <option value="">{t('common.select')}</option>
                {(entriesOf('category') ?? []).map((v) => <option key={v.value} value={v.value}>{v.label || v.value}</option>)}
              </Select>
            </LabelledField>
            <LabelledField label={t('pages.catalogForms.builder.newItemPriority')}>
              <Select value={nuovaVoce.priority} onChange={(e) => { setNuovaVoce({ ...nuovaVoce, priority: e.target.value }) }}>
                <option value="">{t('common.select')}</option>
                {(entriesOf('priority') ?? []).map((v) => <option key={v.value} value={v.value}>{v.label || v.value}</option>)}
              </Select>
            </LabelledField>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
            <input type="checkbox" checked={nuovaVoce.requiresApproval}
              onChange={(e) => { setNuovaVoce({ ...nuovaVoce, requiresApproval: e.target.checked }) }} />
            {t('pages.catalogForms.builder.newItemApproval')}
          </label>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              disabled={!pronto || creandoVoce}
              onClick={() => {
                void (async () => {
                  setCreandoVoce(true)
                  try {
                    const r = await creaVoce({ variables: { input: {
                      name: nuovaVoce.name.trim(),
                      description: nuovaVoce.description.trim() || null,
                      category: nuovaVoce.category || null,
                      priority: nuovaVoce.priority,
                      requiresApproval: nuovaVoce.requiresApproval,
                    } } })
                    const creata = (r.data as { createServiceCatalogItem?: { id: string } } | null | undefined)?.createServiceCatalogItem
                    if (!creata) return
                    await rileggiVoci()
                    // Si apre SUBITO sul modulo della voce appena creata: e il
                    // motivo per cui la si crea da qui.
                    await cambiaVoce(creata.id)
                    setNuovaVoce(null)
                    toast.success(t('toast.catalog.created'))
                  } catch {
                    /* L'avviso lo mostra il link degli errori: qui si prende il
                       rifiuto per non lasciare una promessa non gestita, e si
                       tiene aperto il modale. */
                  } finally { setCreandoVoce(false) }
                })()
              }}
              style={{
                padding: '7px 14px', borderRadius: 8, border: 'none',
                background: pronto ? 'var(--color-brand)' : 'var(--color-surface-alt)',
                color: pronto ? colors.white : 'var(--color-slate-light)',
                fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium,
                cursor: pronto && !creandoVoce ? 'pointer' : 'not-allowed',
              }}
            >
              {creandoVoce ? t('common.saving') : t('pages.catalogForms.builder.newItemCreate')}
            </button>
            <button type="button" onClick={() => { setNuovaVoce(null) }} style={bottone}>{t('common.cancel')}</button>
          </div>
        </div>
      </ModaleCentrato>
    )
  }

  const modaleNuovoCampo = () => {
    if (!nuovoCampo) return null
    return (
      <ModaleCentrato
        titolo={t('pages.catalogForms.builder.newFieldOfType', { type: t(`pages.catalogForms.fieldType.${nuovoCampo.bozza.fieldType}`) })}
        sottotitolo={t('pages.catalogForms.builder.newFieldInSection', {
          section: localizedText(bozza.sections[nuovoCampo.iSez]?.title ?? {}, lingua, '') || bozza.sections[nuovoCampo.iSez]?.id || '',
        })}
        onChiudi={() => { setNuovoCampo(null) }}
      >
        {/*
          Dentro c'è l'EDITOR DELLA LIBRERIA, lo stesso: etichette, aiuto,
          obbligatorio, colonna nelle liste, vocabolario, tipi di CI di un
          riferimento, colonne di una tabella, formula e script di validazione.
          Un editor ridotto avrebbe voluto dire che certe cose si impostano solo
          sapendo che esiste un'altra scheda — il difetto da cui è nata la
          palette dei tipi.
        */}
        <FieldEditor
          bozza={nuovoCampo.bozza}
          onBozza={(b) => { setNuovoCampo({ ...nuovoCampo, bozza: b }) }}
          vocabolari={enumData?.enumTypes ?? []}
          onSalva={confermaNuovoCampo}
          onAnnulla={() => { setNuovoCampo(null) }}
          salvando={creando}
          etichettaSalva={t('pages.catalogForms.builder.createField')}
          nomeDallEtichetta
          nomiPresi={libreria.map((f) => f.name)}
          campiLeggibili={libreria.map((f) => ({ name: f.name, label: f.label }))}
        />
      </ModaleCentrato>
    )
  }

  const larghezzaInBlocco = (iSez: number, larghezza: 'full' | 'half') =>
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i !== iSez ? s : { ...s, items: s.items.map((it) => ({ ...it, width: larghezza })) })),
    }))

  const usati = new Set(bozza.sections.flatMap((s) => s.items.map((i) => i.field)))
  /*
   * NELLA BARRA SOLO I CAMPI CONDIVISI (18 set 2026).
   *
   * «Di default non devono andare in libreria, solo se lo scelgo.» Un campo
   * nato dentro un modulo resta suo: continua a vivere nella scheda «Libreria
   * dei campi», dove si modifica e si cancella, ma non si propone qui come
   * mattone da riusare. Cosi questo elenco torna a voler dire qualcosa: sono
   * le domande che il tenant ha deciso di fare piu volte.
   */
  const disponibili = libreria.filter((f) => f.shared === true && !usati.has(f.name))
  /**
   * I campi che una condizione può guardare: quelli già nel modulo che
   * diventano una PROPRIETÀ. Un allegato o un riferimento andrebbero letti dal
   * grafo, e il valutatore gira anche nel browser su quello che ha in mano.
   */
  const soggettiCondizione = [...usati].filter((n) => {
    const f = perNome.get(n)
    return f != null && canBeConditionSubject(f.fieldType)
  })

  /** Il nome della sezione in cui finisce quello che si aggiunge col «+». */
  const titoloSezioneCorrente = (() => {
    const s = bozza.sections[Math.min(sezioneCorrente, bozza.sections.length - 1)]
    return s ? (localizedText(s.title, lingua, '') || s.id) : ''
  })()

  /**
   * IL MODALE DELLE PROPRIETÀ: un campo o una sezione, mai «tutto».
   *
   * Le stesse spunte di prima — obbligatorio, mezza larghezza, portale, la
   * condizione — che sulla tela erano quaranta controlli in fila e qui sono
   * quelli di UNA cosa.
   */
  const modaleProprieta = () => {
    if (!selezione) return null
    const sezione = bozza.sections[selezione.iSez]
    if (!sezione) return null
    const chiudi = () => { setSelezione(null); setCampoInModifica(null) }

    if (selezione.tipo === 'section') {
      return (
        <ModaleCentrato
          titolo={t('pages.catalogForms.builder.sectionProperties')}
          sottotitolo={localizedText(sezione.title, lingua, '') || sezione.id}
          largo={560}
          onChiudi={chiudi}
        >
          <ProprietaSezione
            sezione={sezione}
            lingue={lingue}
            onSezione={(s) => { sostituisciSezione(selezione.iSez, s) }}
            onLarghezzaInBlocco={(l) => { larghezzaInBlocco(selezione.iSez, l) }}
            onRimuovi={() => {
              cambia((d) => ({ ...d, sections: d.sections.filter((_, i) => i !== selezione.iSez) }))
              chiudi()
            }}
          />
        </ModaleCentrato>
      )
    }

    const item = sezione.items[selezione.iVoce]
    if (!item) return null
    const campo = perNome.get(item.field)
    return (
      <ModaleCentrato
        titolo={t('pages.catalogForms.builder.fieldProperties')}
        sottotitolo={campo?.label ?? item.field}
        largo={560}
        onChiudi={chiudi}
      >
        <ProprietaVoce
          item={item}
          campo={campo}
          sezione={sezione}
          onItem={(v) => { sostituisciVoce(selezione.iSez, selezione.iVoce, v) }}
          onRimuovi={() => {
            sostituisciSezione(selezione.iSez, { ...sezione, items: sezione.items.filter((_, j) => j !== selezione.iVoce) })
            chiudi()
          }}
          campoDiLibreria={campo && (
            <EditorDelCampoDiLibreria
              campo={campo}
              bozza={campoInModifica}
              onBozza={setCampoInModifica}
              salvando={salvandoCampo}
              vocabolari={enumData?.enumTypes ?? []}
              campiLeggibili={libreria.map((f) => ({ name: f.name, label: f.label }))}
              onSalva={async () => {
                if (!campoInModifica) return
                setSalvandoCampo(true)
                try {
                  const r = await aggiornaCampo({
                    variables: { id: campo.id, input: inputDaBozza(campoInModifica, campo.fieldType) },
                  })
                  if (!r.data) return
                  await rileggiLibreria()
                  setCampoInModifica(null)
                  toast.success(t('pages.catalogForms.library.saved'))
                } catch {
                  /* L'avviso lo mostra il link degli errori di Apollo: qui si
                     prende il rifiuto per non lasciare una promessa non
                     gestita, e si TIENE APERTO l'editor. */
                } finally { setSalvandoCampo(false) }
              }}
            />
          )}
          editorCondizione={(
            <EditorCondizione
              condizione={item.visibleWhen}
              soggetti={soggettiCondizione.filter((n) => n !== item.field)}
              etichettaDi={(n) => perNome.get(n)?.label ?? n}
              campoDi={(n) => perNome.get(n)}
              onChange={(c) => { sostituisciVoce(selezione.iSez, selezione.iVoce, c ? { ...item, visibleWhen: c } : omettiCondizione(item)) }}
            />
          )}
        />
      </ModaleCentrato>
    )
  }

  const salvaModulo = async () => {
    /*
     * LA CONFERMA NOMINA LA VOCE, e per questo esiste: pubblicare scrive sul
     * modulo di UNA voce, e il 18 set 2026 un campo è finito su quella
     * sbagliata senza che niente lo dicesse. Non è una conferma di cortesia —
     * è l'ultimo punto in cui si legge il nome prima che il modulo cambi.
     */
    const sicuro = await confirm({
      title: t('pages.catalogForms.builder.publishConfirmTitle'),
      body:  t('pages.catalogForms.builder.publishConfirmBody', { item: voceScelta?.name ?? '' }),
    })
    if (!sicuro) return
    const r = await salva({ variables: { itemId: voceId, definition: JSON.stringify({ ...bozza, version: CATALOG_FORM_VERSION }) } })
    if (!r.data) return
    toast.success(t('pages.catalogForms.builder.published', { revision: (r.data as { saveCatalogForm: { revision: number } }).saveCatalogForm.revision }))
    setToccato(false)
    void refetch()
  }

  if (voci.length === 0) {
    return <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.catalogForms.builder.noItems')}</p>
  }

  return (
    <div>
      {/*
        LA BARRA DEGLI STRUMENTI IN ALTO, LA TELA SOTTO (18 set 2026).

        Il costruttore era due colonne: a sinistra un elenco di righe con le
        spunte, a destra la palette. Chiesto dal proprietario: «come layout
        vorrei qualcosa di più simile a un designer», e scelto da lui — tela
        intera, strumenti in barra, proprietà nel modale.

        Il senso non è l'estetica: con quattro controlli sotto ogni campo, un
        modulo di dieci campi mostrava quaranta controlli e zero modulo. Ora si
        vede il MODULO, e le impostazioni di una cosa si aprono quando quella
        cosa è selezionata.
      */}
      <div className="og-designer-bar" style={{
        background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12,
        boxShadow: `0 1px 2px ${alpha.black06}`,
        display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
        padding: '14px 16px', marginBottom: 18,
      }}>
        {/*
          QUALE MODULO: l'etichetta sopra, come ogni campo del prodotto.

          `flex: 1 1 300px` e non una larghezza fissa: da iPad la barra va a
          capo e questa colonna si stringeva fino a tagliare il nome della
          richiesta a meta («Scegli una service re…»). Cosi cresce con lo
          spazio che c'e, e quando la barra si impila prende la riga intera.
        */}
        <div style={{ minWidth: 220, flex: '1 1 300px' }}>
          <label htmlFor={idVoce} style={{
            display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)',
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5,
          }}>
            {t('pages.catalogForms.builder.item')}
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
              <Select id={idVoce} value={voceId} onChange={(e) => void cambiaVoce(e.target.value)}>
                <option value="">{t('pages.catalogForms.builder.chooseItem')}</option>
                {voci.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </span>
            {/* La voce si crea QUI: il modulo e la voce sono la stessa cosa
                vista da due parti, e il primo passo non deve stare in
                un'altra pagina. */}
            <button type="button" onClick={() => { setNuovaVoce({ name: '', description: '', category: '', priority: '', requiresApproval: false }) }}
              title={t('pages.catalogForms.builder.newItemTitle')}
              style={{ ...bottone, flex: '0 0 auto', whiteSpace: 'nowrap' }}>
              <Plus size={14} /> {t('pages.catalogForms.builder.newItem')}
            </button>
          </div>
        </div>

        {/*
          UN INTERRUTTORE, NON DUE LINK (18 set 2026).

          Erano due parole con una sottolineatura, appoggiate al bordo della
          barra: si leggevano come due voci di menù e non come uno stato. Un
          segmento con la pastiglia bianca dice quale delle due viste stai
          guardando anche con la coda dell'occhio.
        */}
        {voceId !== '' && (
          <div role="tablist" aria-label={t('pages.catalogForms.builder.views')} style={{
            display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999,
            background: 'var(--color-surface-alt)', alignSelf: 'flex-end', marginBottom: 1,
          }}>
            {(['canvas', 'preview'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={vista === v}
                onClick={() => { setVista(v) }}
                style={{
                  border: 'none', cursor: 'pointer', padding: '6px 16px', borderRadius: 999,
                  fontSize: 'var(--font-size-body)',
                  fontWeight: vista === v ? fontWeight.medium : 400,
                  background: vista === v ? colors.white : 'transparent',
                  color: vista === v ? 'var(--color-brand)' : 'var(--color-slate)',
                  boxShadow: vista === v ? `0 1px 2px ${alpha.black10}` : 'none',
                }}
              >
                {t(v === 'canvas' ? 'pages.catalogForms.builder.viewCanvas' : 'pages.catalogForms.builder.preview')}
              </button>
            ))}
          </div>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, alignSelf: 'flex-end' }}>
          {/* LO STATO come pastiglia: «mai pubblicata» è un avviso, una
              revisione è un fatto, e due grigi uguali non lo dicevano. */}
          <span style={{
            fontSize: 'var(--font-size-table)', padding: '4px 10px', borderRadius: 999,
            background: formData?.catalogForm?.revision ? 'var(--color-surface-alt)' : palette.warning.tint,
            color: formData?.catalogForm?.revision ? 'var(--color-slate)' : palette.warning.text,
            whiteSpace: 'nowrap',
          }}>
            {formData?.catalogForm?.revision
              ? t('pages.catalogForms.builder.revision', { revision: formData.catalogForm.revision })
              : t('pages.catalogForms.builder.neverPublished')}
          </span>
          <button type="button" onClick={() => void salvaModulo()} disabled={salvando || !toccato || !voceId}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: toccato && voceId ? 'var(--color-brand)' : 'var(--color-surface-alt)',
              color: toccato && voceId ? colors.white : 'var(--color-slate-light)',
              fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium,
              cursor: toccato && voceId ? 'pointer' : 'not-allowed',
              boxShadow: toccato && voceId ? `0 1px 2px ${alpha.black15}` : 'none',
            }}>
            {salvando ? t('common.saving') : t('pages.catalogForms.builder.publish')}
          </button>
        </span>
      </div>

      {voceId === '' && (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          {t('pages.catalogForms.builder.pickItemFirst')}
        </p>
      )}

      {voceId !== '' && vista === 'canvas' && (
        <>
          {/*
            GLI ATTREZZI, in una colonna a sinistra (chiesto dal proprietario:
            «meglio laterale»). Due gruppi, perché sono due gesti diversi: i
            campi che ESISTONO in libreria si riusano, i TIPI creano un campo
            nuovo. Si trascinano sulla tela; il «+» li mette nella sezione
            corrente, per chi non trascina.
          */}
          <div className="og-designer">
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 }}>
              {[
                /* «Libreria» e non «Campi»: sono i campi che ESISTONO già nel
                   tenant e che questo modulo non usa — si riusano, ed è il
                   motivo per cui la stessa domanda resta una colonna sola nei
                   report. «Campi» non distingueva questo gruppo dall'altro,
                   che di campi parla anche lui (deciso dal proprietario). */
                { id: 'library' as const, titolo: t('pages.catalogForms.builder.libraryGroup'), voci: disponibili.map((f) => ({ chiave: f.name, etichetta: f.label, tipo: f.fieldType, nuovo: false })) },
                { id: 'types' as const, titolo: t('pages.catalogForms.builder.fieldTypes'), voci: FORM_FIELD_TYPES.map((x) => ({ chiave: x, etichetta: t(`pages.catalogForms.fieldType.${x}`), tipo: x, nuovo: true })) },
              ].map((gruppo) => (
                <div key={gruppo.id}>
                  <button
                    type="button"
                    aria-expanded={attrezziAperti === gruppo.id}
                    onClick={() => { setAttrezziAperti((x) => (x === gruppo.id ? null : gruppo.id)) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                      background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: 6,
                      fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)',
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}
                  >
                    {attrezziAperti === gruppo.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {gruppo.titolo}
                    {/* Il conto sta sul titolo chiuso: si sa se vale la pena
                        aprirlo — una libreria vuota non si apre per scoprirlo. */}
                    <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{gruppo.voci.length}</span>
                  </button>
                  <div style={{ display: attrezziAperti === gruppo.id ? 'flex' : 'none', flexDirection: 'column', gap: 5 }}>
                    {gruppo.voci.length === 0 && (
                      <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                        {libreria.length === 0 ? t('pages.catalogForms.builder.libraryEmpty') : t('pages.catalogForms.builder.paletteEmpty')}
                      </span>
                    )}
                    {gruppo.voci.map((v) => (
                      <span
                        key={v.chiave}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          border: v.nuovo ? `1px dashed ${colors.border}` : `1px solid ${colors.border}`,
                          borderRadius: 8, background: colors.white, padding: '4px 8px 4px 5px',
                        }}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={t('pages.catalogForms.builder.dragField', { field: v.etichetta })}
                          title={t('pages.catalogForms.builder.dragField', { field: v.etichetta })}
                          onPointerDown={(e) => { trascinamento.afferra(e, v.nuovo ? { tipo: 'newField', fieldType: v.tipo } : { tipo: 'palette', campo: v.chiave }, v.etichetta) }}
                          onTouchStart={(e) => { trascinamento.afferra(e, v.nuovo ? { tipo: 'newField', fieldType: v.tipo } : { tipo: 'palette', campo: v.chiave }, v.etichetta) }}
                          className="og-grip"
                          style={{ display: 'flex', alignItems: 'center', color: 'var(--color-slate-light)', background: 'none', border: 'none', padding: 0, cursor: 'grab' }}
                        >
                          <GripVertical size={14} />
                        </button>
                        {/* La stessa icona che il campo avrà sulla tela: si
                            riconosce quello che si sta per trascinare. */}
                        <IconaTipo tipo={v.tipo} />
                        <span style={{
                          fontSize: 'var(--font-size-table)', color: 'var(--color-slate-dark)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
                        }} title={v.etichetta}>{v.etichetta}</span>
                        <button
                          type="button"
                          aria-label={v.nuovo
                            ? t('pages.catalogForms.builder.addTypeToSection', { type: v.etichetta })
                            : t('pages.catalogForms.builder.addToSection', { field: v.etichetta, section: titoloSezioneCorrente })}
                          title={v.nuovo
                            ? t('pages.catalogForms.builder.addTypeToSection', { type: v.etichetta })
                            : t('pages.catalogForms.builder.addToSection', { field: v.etichetta, section: titoloSezioneCorrente })}
                          disabled={bozza.sections.length === 0}
                          onClick={() => {
                            if (bozza.sections.length === 0) return
                            const iSez = Math.min(sezioneCorrente, bozza.sections.length - 1)
                            if (v.nuovo) setNuovoCampo({ iSez, iVoce: null, bozza: { ...BOZZA_VUOTA, fieldType: v.tipo } })
                            else aggiungiCampo(iSez, v.chiave)
                          }}
                          style={{ ...iconaAzione, color: bozza.sections.length === 0 ? 'var(--color-slate-light)' : 'var(--color-brand)' }}
                        >
                          <Plus size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </aside>

            <div>
          {/*
            L'INTESTAZIONE DELLA TELA (18 set 2026).

            La tela cominciava con la prima sezione, senza dire di CHI è: il
            nome della voce di catalogo stava solo nella tendina in alto, che
            quando si scorre esce di scena. Qui c'è il nome, e accanto le due
            misure che dicono a che punto sei — quante sezioni, quanti campi —
            e se c'è qualcosa che non hai ancora pubblicato.
          */}
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
            paddingBottom: 8, marginBottom: 12, borderBottom: `1px solid ${colors.border}`,
          }}>
            <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
              {voceScelta?.name ?? ''}
            </strong>
            {/* Le modifiche non pubblicate: il bottone «Salva e pubblica» si
                accende, ma sta in cima e da qui non si vede. */}
            {toccato && (
              <span style={{ fontSize: 'var(--font-size-table)', color: palette.warning.text, marginLeft: 'auto' }}>
                {t('pages.catalogForms.builder.unsaved')}
              </span>
            )}
          </div>

          <FormCanvas
            bozza={bozza}
            perNome={perNome}
            lingua={lingua}
            lingue={lingue}
            selezione={selezione}
            bersaglio={bersaglio}
            onSeleziona={(s) => {
              setSelezione(s)
              if (s) setSezioneCorrente(s.iSez)
            }}
            maniglia={(iSez, iVoce) => (
              <Maniglia
                etichetta={t('pages.catalogForms.builder.moveField', { field: perNome.get(bozza.sections[iSez]?.items[iVoce]?.field ?? '')?.label ?? '' })}
                onAfferra={(e) => { trascinamento.afferra(e, { tipo: 'item', sezione: iSez, voce: iVoce }, perNome.get(bozza.sections[iSez]?.items[iVoce]?.field ?? '')?.label ?? '') }}
                onSu={() => {
                  const s = bozza.sections[iSez]
                  if (s) sostituisciSezione(iSez, { ...s, items: scambia(s.items, iVoce, Math.max(0, iVoce - 1)) })
                }}
                onGiu={() => {
                  const s = bozza.sections[iSez]
                  if (s) sostituisciSezione(iSez, { ...s, items: scambia(s.items, iVoce, Math.min(s.items.length - 1, iVoce + 1)) })
                }}
              />
            )}
            manigliaSezione={(iSez) => (
              <Maniglia
                etichetta={t('pages.catalogForms.builder.moveSection', { title: localizedText(bozza.sections[iSez]?.title ?? {}, lingua, '') || String(iSez + 1) })}
                onAfferra={(e) => { trascinamento.afferra(e, { tipo: 'section', sezione: iSez }, localizedText(bozza.sections[iSez]?.title ?? {}, lingua, '') || String(iSez + 1)) }}
                onSu={() => muoviSezione(iSez, iSez - 1)}
                onGiu={() => muoviSezione(iSez, iSez + 1)}
                evidenziata={bersaglio === `ord-${String(iSez)}` || bersaglio === `sec-${String(iSez)}`}
              />
            )}
          />

          <button type="button" style={{ ...bottone, marginTop: 14 }}
            onClick={() => cambia((d) => ({ ...d, sections: [...d.sections, { id: idSezione(d.sections.map((s) => s.id)), title: {}, items: [] }] }))}>
            <Plus size={14} /> {t('pages.catalogForms.builder.addSection')}
          </button>
            </div>
          </div>
        </>
      )}

      {voceId !== '' && vista === 'preview' && (
        <div>
          <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>
            {t('pages.catalogForms.builder.previewHelp')}
          </p>
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, background: colors.white }}>
            <CatalogFormRenderer
              definition={bozza}
              fields={libreria}
              answers={risposteAnteprima as FormAnswers}
              onChange={(nome, valore) => setRisposteAnteprima((p) => ({ ...p, [nome]: valore }))}
              language={lingua}
              requiredLabel={t('forms.fieldRequired')}
              emptyChoiceLabel={t('common.select')}
              yesLabel={t('common.yes')}
              noLabel={t('common.no')}
            />
          </div>
        </div>
      )}

      {/* L'ombra che segue il dito: `position: fixed`, quindi non appartiene a
          nessun pezzo del layout. */}
      {trascinamento.posizione && (
        <OmbraTrascinata etichetta={trascinamento.etichetta} posizione={trascinamento.posizione} />
      )}

      {modaleNuovaVoce()}
      {modaleNuovoCampo()}
      {modaleProprieta()}
    </div>
  )
}

/** Sposta un elemento da una posizione all'altra, mantenendo l'ordine del resto. */
function sposta<T>(list: readonly T[], da: number, a: number): T[] {
  const out = [...list]
  const [x] = out.splice(da, 1)
  if (x === undefined) return [...list]
  out.splice(a, 0, x)
  return out
}

function scambia<T>(list: readonly T[], a: number, b: number): T[] {
  const out = [...list]
  const x = out[a]!, y = out[b]!
  out[a] = y; out[b] = x
  return out
}

/** Togliere la condizione vuol dire togliere la chiave: `undefined` non è JSON. */
function omettiCondizione(item: CatalogFormItem): CatalogFormItem {
  const { visibleWhen: _, ...resto } = item
  return resto
}

/**
 * IL VALORE DI UNA REGOLA, SCELTO E NON DIGITATO.
 *
 * Era una casella di testo sempre, anche quando il campo sceglie da un
 * vocabolario del Dizionario: l'amministratore doveva conoscere il valore
 * INTERNO (`production`), e chi scriveva «Produzione» — cioè l'etichetta che
 * il prodotto gli mostra ovunque — otteneva una condizione che non sarebbe
 * scattata mai, in silenzio. È lo stesso difetto chiuso per le business rule
 * nell'ondata 5 dei moduli e rimasto aperto qui; l'ho visto nel browser
 * guardando la regola di «Costo stimato» (revisione del 17 set 2026).
 *
 * Le scelte arrivano dalla libreria (`options`, già con le etichette nella
 * lingua di chi guarda). Un sì/no offre Sì e No. Tutto il resto resta testo,
 * perché è testo davvero.
 */
function ValoreDellaRegola({ campo, valore, onValore }: {
  campo: FormFieldRow | undefined
  valore: string
  onValore: (v: string) => void
}) {
  const { t } = useTranslation()
  const stile = { width: 'auto', minWidth: 120, padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }

  if (campo && campo.options.length > 0) {
    return (
      <Select value={valore} style={stile} onChange={(e) => onValore(e.target.value)}>
        <option value="">{t('common.select')}</option>
        {campo.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {/* Un valore salvato che il Dizionario non ha più resta visibile invece
            di sembrare un'altra scelta. */}
        {valore !== '' && !campo.options.some((o) => o.value === valore) && (
          <option value={valore}>{valore}</option>
        )}
      </Select>
    )
  }
  if (campo?.fieldType === 'boolean') {
    return (
      <Select value={valore} style={stile} onChange={(e) => onValore(e.target.value)}>
        <option value="">{t('common.select')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </Select>
    )
  }
  return (
    <Input value={valore} style={{ width: 120, padding: '2px 6px', fontSize: 'var(--font-size-table)' }}
      onChange={(e) => onValore(e.target.value)} />
  )
}

/**
 * L'editor di una condizione. Dichiarativa, non uno script: così si può
 * mostrare, spiegare e verificare — e il server la rivaluta con la stessa
 * funzione, senza eseguire codice del cliente.
 */
function EditorCondizione({ condizione, soggetti, etichettaDi, campoDi, onChange }: {
  condizione?: FormCondition
  soggetti: readonly string[]
  etichettaDi: (name: string) => string
  /** Il campo della libreria: da lì vengono il tipo e le scelte del Dizionario. */
  campoDi: (name: string) => FormFieldRow | undefined
  onChange: (c: FormCondition | undefined) => void
}) {
  const { t } = useTranslation()
  const regole = condizione?.rules ?? []

  return (
    <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: `2px solid ${colors.slateBg}` }}>
      {/*
        LA VISIBILITÀ SI VEDE SEMPRE, ANCHE QUANDO NON SI PUÒ USARE
        (19 set 2026).

        Prima, senza nessun campo da guardare, questo blocco non disegnava
        NIENTE: nelle proprietà di un campo non c'era traccia delle regole di
        visibilità, e il proprietario le ha cercate — «non vedo le regole di
        visibilità». Una funzione che sparisce quando non è disponibile si
        legge come una funzione che non esiste.

        Adesso il titolo c'è comunque, e quando manca il presupposto lo dice:
        una condizione guarda la RISPOSTA DI UN ALTRO CAMPO, quindi serve
        almeno un altro campo che porti una risposta.
      */}
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: fontWeight.medium, color: 'var(--color-slate)', marginBottom: 4 }}>
        {t('pages.catalogForms.builder.visibilityTitle')}
      </div>
      {soggetti.length === 0 && regole.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '62ch' }}>
          {t('pages.catalogForms.builder.visibilityNoSubjects')}
        </p>
      ) : regole.length === 0 ? (
        <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
          onClick={() => onChange({ match: 'all', rules: [{ field: soggetti[0]!, op: 'eq', value: '' }] })}>
          <Plus size={12} /> {t('pages.catalogForms.builder.addCondition')}
        </button>
      ) : null}
      {soggetti.length > 0 && regole.length === 0 ? (
        <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '62ch' }}>
          {t('pages.catalogForms.builder.visibilityHelp')}
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
            <span>{t('pages.catalogForms.builder.showWhen')}</span>
            <Select value={condizione!.match} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
              onChange={(e) => onChange({ ...condizione!, match: e.target.value as 'all' | 'any' })}>
              <option value="all">{t('pages.catalogForms.builder.matchAll')}</option>
              <option value="any">{t('pages.catalogForms.builder.matchAny')}</option>
            </Select>
          </div>
          {regole.map((regola, i) => (
            <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 5, flexWrap: 'wrap' }}>
              <Select value={regola.field} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)) })}>
                {soggetti.map((n) => <option key={n} value={n}>{etichettaDi(n)}</option>)}
              </Select>
              <Select value={regola.op} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => {
                  const op = e.target.value as FormConditionOp
                  const senzaValore = (FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(op)
                  onChange({
                    ...condizione!,
                    rules: condizione!.rules.map((r, j) => (j === i ? (senzaValore ? { field: r.field, op } : { field: r.field, op, value: r.value ?? '' }) : r)),
                  })
                }}>
                {FORM_CONDITION_OPS.map((op) => <option key={op} value={op}>{t(`pages.catalogForms.conditionOp.${op}`)}</option>)}
              </Select>
              {!(FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(regola.op) && (
                <ValoreDellaRegola
                  campo={campoDi(regola.field)}
                  valore={regola.value ?? ''}
                  onValore={(v) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, value: v } : r)) })}
                />
              )}
              <button type="button" aria-label={t('pages.catalogForms.builder.removeCondition')}
                onClick={() => {
                  const restanti = condizione!.rules.filter((_, j) => j !== i)
                  onChange(restanti.length === 0 ? undefined : { ...condizione!, rules: restanti })
                }}
                style={iconaAzione}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
            onClick={() => onChange({ ...condizione!, rules: [...condizione!.rules, { field: soggetti[0]!, op: 'eq', value: '' }] })}>
            <Plus size={12} /> {t('pages.catalogForms.builder.addRule')}
          </button>
        </>
      )}
    </div>
  )
}
