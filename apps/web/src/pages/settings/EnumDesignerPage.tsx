import { Pill } from '@/components/ui/Pill'
import {useState, useEffect, useRef } from 'react'
import { useApolloClient, useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { Lock, LockOpen, Package, Plus, X, Save, Trash2, Tag, Copy, Pencil, ArrowUp, ArrowDown, Star, Check } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { inputS, labelS, readOnlyInputS } from '@/components/ui/styles'
import { toast } from 'sonner'
import { GET_ENUM_TYPES, GET_ENUM_SHIPPED_DRIFT, GET_ENUM_VALUE_USAGE } from '@/graphql/queries'
import { useLingue } from '@/hooks/useLingue'
import { useConfirm } from '@/hooks/useConfirm'
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard'
import { dictionaryList } from '@/lib/dictionaryList'
import {
  CREATE_ENUM_TYPE,
  UPDATE_ENUM_TYPE,
  RENAME_ENUM_VALUE,
  REORDER_ENUM_VALUES,
  DELETE_ENUM_TYPE,
  CUSTOMIZE_ENUM_TYPE,
  ADOPT_SHIPPED_VALUES,
  ACKNOWLEDGE_SHIPPED_VALUES,
} from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
import { VALUE_COLORS, VALUE_ICONS, isValueIcon, type ValueColor } from '@opengraphity/types'
import { VALUE_ICON_DRAWINGS } from '@/lib/valueIcons'
import { valueColorStyle } from '@/lib/domainStyle'
import { clientLogger } from '@/lib/clientLogger'
import { errorMessage, showError } from '@/lib/showError'
import { DetailLayout } from '@/components/ui/DetailLayout'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LocalizedLabel { language: string; label: string }
interface EnumValueLabel { value: string; label: string; labels: LocalizedLabel[] }


interface EnumType {
  id:        string
  name:      string
  label:     string
  values:    string[]
  /**
   * Valore + etichetta con cui si legge a schermo, nell'ordine dei valori e
   * sempre completa: dove l'admin non ha scritto niente il server mette il
   * valore con le iniziali maiuscole. Ondata 1: il valore resta quello che è
   * — lo scrivono i record e le condizioni delle regole — e l'etichetta è
   * come la si legge.
   */
  valueLabels: EnumValueLabel[]
  /** Il colore dei valori che ne hanno uno (revisione del 14 set 2026 · F9). */
  valueColors: { value: string; color: ValueColor }[]
  /** The icon of the values that have one (G40): the portal draws it next to a category. */
  valueIcons?: { value: string; icon: string }[]
  /**
   * Il valore con cui si nasce quando nessuno lo indica (`null` = non
   * dichiarato). Serve a togliere una regola di dominio dalla POSIZIONE: lo
   * stato iniziale di un CI era il PRIMO valore della lista, e siccome si
   * poteva solo aggiungere in coda, rinominare un valore lo spostava in fondo
   * (revisione delle otto ondate · C·N-2).
   */
  defaultValue: string | null
  /** Protezione (non si cancella): è vero anche su copie vecchie del tenant. */
  isSystem:  boolean
  /** Spedito col prodotto (`tenant_id = 'system'`): uno per tutti i clienti. */
  isShipped: boolean
  /**
   * Perche questo vocabolario non porta etichette per valore (chiave i18n),
   * `null` se le porta. Lo decide il server: la pagina non tiene un suo elenco,
   * che divergerebbe al primo vocabolario nuovo.
   */
  valueLabelsReasonKey: string | null
  scope:     string
  createdAt: string
  updatedAt: string
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Shared design-system constants (E-09): no page-local copies.
// The former local `btnPrimary` used the compact (7px 14px / body) size; kept via override.
/** I bottoncini di riga di un valore (ordine, rinomina, default, rimozione). */
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
  display: 'flex', color: 'var(--color-slate-light)', lineHeight: 1,
}
/** Campo in sola lettura: lo stile è del sistema di design (`readOnlyInputS`). */
const readOnlyS = readOnlyInputS

/**
 * A control in a value row: one height for inputs and selects, the text
 * centred. At 26 px with the form's 7 px padding a select had 10 px left for
 * 14 px of text, and «No color» showed only its top half.
 */
const rowControlS: React.CSSProperties = { ...inputS, height: 30, paddingTop: 0, paddingBottom: 0, fontWeight: 400, minWidth: 0, flex: '1 1 auto' }

/**
 * The columns of a value row, the same on every row so the list reads by
 * column: the arrows (not on a shipped vocabulary), the value, one per
 * language. Colour, icon and actions are added by the stylesheet when the
 * editor is wide enough (`.og-dict-row` in index.css), or go to a second line.
 */
function valueRowColumns(shipped: boolean, labelColumns: number): React.CSSProperties {
  return {
    '--og-dict-cols': [...(shipped ? [] : ['20px']), 'minmax(80px, 160px)', ...Array.from({ length: labelColumns }, () => 'minmax(100px, 1fr)')].join(' '),
    '--og-dict-tools-col': shipped ? '1 / -1' : '2 / -1',
  } as React.CSSProperties
}

// ── CreateEnumDialog ──────────────────────────────────────────────────────────

function CreateEnumDialog({
  onClose,
  onCreated,
}: { onClose: () => void; onCreated: (e: EnumType) => void }) {
  const { t } = useTranslation()
  const [name, setName]   = useState('')
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<'shared' | 'itil' | 'cmdb'>('shared')
  // I valori si danno alla creazione: un vocabolario senza valori non esiste
  // (l'API lo rifiuta). Il dialogo mandava una lista vuota, quindi nessun
  // vocabolario si poteva creare dall'interfaccia (ondata 4, trovato dal vivo).
  const [valuesText, setValuesText] = useState('')
  const values = [...new Set(valuesText.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))]

  const [createEnum, { loading }] = useMutation(CREATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: (d: unknown) => {
      const result = (d as { createEnumType: EnumType }).createEnumType
      toast.success(t('pages.dictionary.created', { label: result.label }))
      onCreated(result)
    },
    onError: (e) => showError(e),
  })

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!name.match(/^[a-z][a-z0-9_]*$/)) {
      toast.error(t('pages.dictionary.invalidName'))
      return
    }
    if (values.length === 0) {
      toast.error(t('pages.dictionary.valuesRequired'))
      return
    }
    void createEnum({ variables: { input: { name, label, values, scope } } })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('pages.dictionary.createTitle')}
      width={400}
      as="form"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} style={{ padding: '7px 14px' }}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={loading} icon={<Plus size={14} aria-hidden="true" />} style={{ padding: '7px 14px', fontSize: 'var(--font-size-body)' }}>
            {t('common.create')}
          </Button>
        </>
      }
    >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label htmlFor="enum-name" style={labelS}>{t('pages.dictionary.nameFieldLabel')}</label>
            <Input
              id="enum-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('pages.dictionary.namePlaceholder')}
              required
              pattern="[a-z][a-z0-9_]*"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo "Nuovo dizionario" aperto dall'utente
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="enum-label" style={labelS}>{t('pages.dictionary.labelLabel')}</label>
            <Input
              id="enum-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('pages.dictionary.labelPlaceholder')}
              required
            />
          </div>
          <div>
            <label htmlFor="enum-scope" style={labelS}>{t('pages.dictionary.scopeLabel')}</label>
            <Select
              id="enum-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'shared' | 'itil' | 'cmdb')}
            >
              <option value="shared">{t('pages.dictionary.scopeShared')}</option>
              <option value="itil">{t('pages.dictionary.scopeItil')}</option>
              <option value="cmdb">{t('pages.dictionary.scopeCmdb')}</option>
            </Select>
          </div>
          <div>
            <label htmlFor="enum-values" style={labelS}>{t('pages.dictionary.valuesLabel')}</label>
            <Textarea
              id="enum-values"
              value={valuesText}
              onChange={(e) => setValuesText(e.target.value)}
              placeholder={t('pages.dictionary.valuesPlaceholder')}
              style={{ minHeight: 90, resize: 'vertical' }}
            />
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('pages.dictionary.valuesHint', { count: values.length })}</span>
          </div>
        </div>
    </Modal>
  )
}

// ── OwnerBadge ────────────────────────────────────────────────────────────────

/**
 * Di chi è il vocabolario. `isSystem` non lo dice (è una protezione, ed è vero
 * anche sulle copie per tenant seminate in passato): il proprietario è
 * `isShipped`. Senza questa distinzione il Dizionario mostrava allo stesso
 * modo i vocabolari del prodotto e i propri.
 */
function OwnerBadge({ shipped }: { shipped: boolean }) {
  const { t } = useTranslation()
  const label = shipped ? t('pages.dictionary.shippedBadge') : t('pages.dictionary.ownBadge')
  return (
    <Pill bg={shipped ? 'var(--color-slate-bg)' : palette.info.bg} color={shipped ? 'var(--color-slate)' : 'var(--color-brand)'} radius={20} style={{ gap: 4, flexShrink: 0, fontSize: 'var(--font-size-table)', fontWeight: 500 }}>
      {shipped
        ? <Package  size={10} aria-hidden="true" />
        : <LockOpen size={10} aria-hidden="true" />}
      {label}
    </Pill>
  )
}

// ── EnumEditor ────────────────────────────────────────────────────────────────

/**
 * The WHOLE label list, every value in every language, built from the saved
 * labels with one of them replaced: the mutation replaces the list in bulk,
 * so sending only the edited label would delete all the others. Empty labels
 * are left out ("read the value" is the absence of a label).
 */
function fullLabelList(
  values: string[],
  languages: string[],
  saved: (value: string, language: string) => string,
  edited: { value: string; language: string; label: string },
): Array<{ value: string; language: string; label: string }> {
  return values.flatMap((value) =>
    languages.flatMap((language) => {
      const label = value === edited.value && language === edited.language ? edited.label : saved(value, language)
      return label.trim() === '' ? [] : [{ value, language, label }]
    }),
  )
}

/** The icon saved for a value of the vocabulary, or '' (G40). */
function savedIcon(e: EnumType, value: string): string {
  return e.valueIcons?.find((x) => x.value === value)?.icon ?? ''
}

/** The whole icon list with ONE value changed: the list is replaced as a whole, as for the colours (G40). */
function withValueIcon(e: EnumType, value: string, icon: string): { value: string; icon: string }[] {
  return e.values.flatMap((v) => {
    const i = v === value ? icon : savedIcon(e, v)
    return i === '' ? [] : [{ value: v, icon: i }]
  })
}

/** The ICON of a value (G40): a name of the product's list, drawn next to its select; the portal draws it too. */
function ValueIconControl({ value, icon, disabled, style, onChange }: {
  value: string
  icon: string
  disabled: boolean
  style: React.CSSProperties
  onChange: (icon: string) => void
}) {
  const { t } = useTranslation()
  const Drawing = isValueIcon(icon) ? VALUE_ICON_DRAWINGS[icon] : null
  return (
    <span className="og-dict-cell">
      {Drawing && <Drawing size={13} aria-hidden="true" />}
      <Select style={style} value={icon} disabled={disabled} onChange={(ev) => onChange(ev.target.value)}
        aria-label={t('pages.dictionary.valueIconLabel', { value })}>
        <option value="">{t('pages.dictionary.valueIconNone')}</option>
        {VALUE_ICONS.map((i) => <option key={i} value={i}>{t(`pages.dictionary.valueIcons.${i}`)}</option>)}
      </Select>
    </span>
  )
}

function EnumEditor({ enumType: e, customizedFromShipped, onDeleted, onCustomized, onDirtyChange }: {
  enumType:     EnumType
  /** Copia del cliente di un vocabolario spedito (U-17): l'originale non è più nell'elenco. */
  customizedFromShipped: boolean
  onDeleted:    () => void
  onCustomized: (copy: EnumType) => void
  /** The values changed and not saved yet: the page asks before showing another dictionary (G45). */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  // G-12: le lingue del cliente, dichiarate dall'API.
  const lingue = useLingue()
  // Un vocabolario spedito col prodotto è UN nodo per tutti i clienti: non si
  // modifica in posto. L'interfaccia lo dice e offre «Personalizza», che ne
  // crea la copia del tenant (quella vince in lettura solo per chi la ha).
  const shipped = e.isShipped
  /*
   * QUESTO VOCABOLARIO NON PORTA ETICHETTE PER VALORE, e non è una mancanza.
   *
   * Per i quattro «status_*» i valori sono i nomi dei passi del workflow, e la
   * lingua si scrive sul passo; per `import_severity` i 28 valori sono chiavi
   * di riconoscimento dei dati in arrivo, non voci di menu. Senza dirlo, la
   * pagina mostrava «not written» accanto a ogni valore in entrambe le lingue:
   * tredici volte su Change Status, e la lettura naturale è «manca qualcosa»
   * (17 set 2026).
   */
  const senzaEtichette = e.valueLabelsReasonKey
  const [label, setLabel]   = useState(e.label)
  const [scope, setScope]   = useState(e.scope)
  const [values, setValues] = useState<string[]>(e.values)
  const [newVal, setNewVal] = useState('')
  const [dirty, setDirty]   = useState(false)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  /** Il valore che si sta rinominando, e il nome nuovo (null = nessuno). */
  const [renamingFrom, setRenamingFrom] = useState<string | null>(null)
  /**
   * Il fuoco sul campo di rinomina (terza revisione). Avevo tolto `autoFocus`
   * per soddisfare `jsx-a11y/no-autofocus` — e l'ho soddisfatta togliendo la
   * gestione del fuoco invece di scriverla: il campo compariva col valore
   * giusto e il fuoco restava sul bottone. Trovato in un browser vero.
   * `select()` perche si rinomina riscrivendo, non aggiungendo in coda.
   */
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renamingFrom == null) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [renamingFrom])
  const [renameTo,     setRenameTo]     = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  /**
   * Le etichette in modifica. Si scrivono SUBITO (all'uscita dal campo o con
   * Invio), non col «Salva» del vocabolario: un'etichetta non tocca né i
   * record né le matrici, quindi non ha bisogno di stare in una bozza insieme
   * ai valori — e trattarla come i valori avrebbe fatto perdere la modifica a
   * chi la scrive e poi cambia vocabolario.
   */
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({})   // chiave: `${valore}|${lingua}`

  const [updateEnum, { loading: saving }] = useMutation(UPDATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success(t('pages.dictionary.updated')); setDirty(false) },
    onError: (err) => showError(err),
  })

  const [deleteEnum, { loading: deleting }] = useMutation(DELETE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success(t('pages.dictionary.deleted')); onDeleted() },
    onError: (err) => showError(err),
  })

  /**
   * Rinominare, riordinare e scegliere il default sono **operazioni del
   * server**, non modifiche locali da salvare dopo: toccano i record, la policy
   * degli allarmi e le matrici di dominio nella stessa transazione del
   * vocabolario. Quindi partono subito, una per clic, e la lista si ricarica.
   */
  const [renameValue, { loading: renaming }] = useMutation(RENAME_ENUM_VALUE, {
    refetchQueries: [GET_ENUM_TYPES],
    awaitRefetchQueries: true,
    onCompleted: (d: unknown) => {
      const updated = (d as { renameEnumValue: EnumType }).renameEnumValue
      setValues(updated.values)
      setRenamingFrom(null); setRenameTo('')
      toast.success(t('pages.dictionary.valueRenamed'))
    },
    onError: (err) => showError(err),
  })

  const [reorderValues, { loading: reordering }] = useMutation(REORDER_ENUM_VALUES, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: (d: unknown) => { setValues((d as { reorderEnumValues: EnumType }).reorderEnumValues.values) },
    onError: (err) => showError(err),
  })

  /**
   * Etichette e colori si scrivono con la LORO mutation (revisione totale ·
   * G-2): usando quella del «Salva» dei valori, il suo `onCompleted` faceva
   * `setDirty(false)` e i bottoni Salva/Annulla sparivano mentre la lista a
   * schermo era diversa dal server — l'admin credeva di aver salvato i valori.
   */
  const [updateLabels, { loading: savingLabels }] = useMutation(UPDATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => toast.success(t('pages.dictionary.updated')),
    onError: (err) => showError(err),
  })

  const [setDefault, { loading: settingDefault }] = useMutation(UPDATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => toast.success(t('pages.dictionary.defaultSet')),
    onError: (err) => showError(err),
  })

  const [customizeEnum, { loading: customizing }] = useMutation(CUSTOMIZE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    awaitRefetchQueries: true,
    onCompleted: (d: unknown) => {
      const copy = (d as { customizeEnumType: EnumType }).customizeEnumType
      toast.success(t('pages.dictionary.customized', { label: copy.label }))
      onCustomized(copy)
    },
    onError: (err) => showError(err),
  })

  /*
    I valori spediti DOPO la copia (revisione del 14 set 2026 · F20). La copia
    del cliente non si sovrascrive mai: qui si dice cosa il prodotto ha
    aggiunto, e l'amministratore decide se prenderlo o tenerlo fuori.
  */
  const { data: driftData, error: driftError } = useQuery<{ enumTypes: { id: string; newShippedValues: string[] }[] }>(GET_ENUM_SHIPPED_DRIFT, { skip: shipped })
  useEffect(() => {
    if (driftError) clientLogger.error('Dictionary: shipped values drift could not be loaded', { error: driftError.message })
  }, [driftError])
  const newShipped = driftData?.enumTypes.find((d) => d.id === e.id)?.newShippedValues ?? []
  const [adoptShipped, { loading: adopting }] = useMutation(ADOPT_SHIPPED_VALUES, {
    refetchQueries: [GET_ENUM_TYPES, GET_ENUM_SHIPPED_DRIFT],
    awaitRefetchQueries: true,
    onCompleted: (d: unknown) => {
      setValues((d as { adoptShippedValues: EnumType }).adoptShippedValues.values)
      toast.success(t('pages.dictionary.newShipped.adopted'))
    },
    onError: (err) => showError(err),
  })
  const [acknowledgeShipped, { loading: acknowledging }] = useMutation(ACKNOWLEDGE_SHIPPED_VALUES, {
    refetchQueries: [GET_ENUM_SHIPPED_DRIFT],
    awaitRefetchQueries: true,
    onCompleted: () => toast.success(t('pages.dictionary.newShipped.kept')),
    onError: (err) => showError(err),
  })

  const setDirtyLabel = (v: string) => { setLabel(v); setDirty(true) }
  const setDirtyScope = (v: string) => { setScope(v); setDirty(true) }

  const addValue = () => {
    const v = newVal.trim()
    if (!v || values.includes(v)) return
    setValues((prev) => [...prev, v])
    setNewVal('')
    setDirty(true)
  }

  const removeValue = (v: string) => {
    setValues((prev) => prev.filter((x) => x !== v))
    setDirty(true)
  }

  /** Sposta un valore di un posto: l'ordine è una scala, e ora si modifica. */
  const move = (index: number, by: -1 | 1) => {
    const target = index + by
    if (target < 0 || target >= values.length) return
    // G-2: `reorderEnumValues` pretende la lista dei valori SALVATI; con
    // aggiunte o rimozioni non salvate la rifiutava.
    if (dirty) { toast.error(t('pages.dictionary.saveValuesFirst')); return }
    const next = [...values]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    void reorderValues({ variables: { id: e.id, values: next } })
  }

  /*
    Secondo giro UI del 15 set 2026: la rinomina riscriveva ticket, matrici e
    regole senza chiedere e senza dire quanti. Prima si conta cosa usa il
    valore (lo stesso conteggio del rifiuto della cancellazione), poi si chiede.
  */
  const apollo = useApolloClient()
  const confirm = useConfirm()
  const confirmRename = async () => {
    const to = renameTo.trim()
    const from = renamingFrom
    if (!from || to === '' || to === from) { setRenamingFrom(null); return }
    type Usage = { total: number; policyLists: string[]; matrices: string[]; configSites: string[]; records: { typeName: string; fieldName: string; count: number }[] }
    let usage: Usage
    try {
      const res = await apollo.query<{ enumValueUsage: Usage }>({ query: GET_ENUM_VALUE_USAGE, variables: { id: e.id, value: from }, fetchPolicy: 'network-only' })
      usage = res.data!.enumValueUsage
    } catch (err) {
      showError(err, t('pages.dictionary.renameUsageFailed', { error: errorMessage(err) }))
      return
    }
    const where = [
      ...usage.records.map((r) => t('pages.dictionary.renameUsageRecords', { count: r.count, type: r.typeName, field: r.fieldName })),
      // L'API dice anche la chiave o la cella («priority (chiave "high|low")»): qui basta il nome della matrice, una volta.
      ...[...new Set(usage.matrices.map((m) => m.split(' (')[0]!))].map((m) => t('pages.dictionary.renameUsageMatrix', { name: m })),
      ...usage.policyLists.map((l) => t('pages.dictionary.renameUsagePolicy', { list: l })),
      ...usage.configSites,
    ]
    const ok = await confirm({
      title: t('pages.dictionary.renameConfirmTitle', { from, to }),
      body: where.length === 0 ? t('pages.dictionary.renameConfirmNothing') : t('pages.dictionary.renameConfirmUsage', { where: where.join('; ') }),
      confirmLabel: t('pages.dictionary.renameConfirmButton'),
    })
    if (ok) void renameValue({ variables: { id: e.id, from, to } })
  }

  /**
   * I valori TOLTI e ancora usati dai record: l'API li rifiuta e accetta una
   * sostituzione esplicita (`replacements: [{from, to}]`), che il Dizionario
   * non mandava mai — «togli il valore e riscrivi i record su X» non era
   * raggiungibile dall'interfaccia, e restava solo l'errore (revisione totale
   * · G-11). Qui si contano gli usi e, se ci sono, si chiede su cosa
   * riscriverli prima di salvare.
   */
  const [replaceFor, setReplaceFor] = useState<{ from: string; total: number }[]>([])
  const [replaceWith, setReplaceWith] = useState<Record<string, string>>({})

  const handleSave = async () => {
    const removed = e.values.filter((v) => !values.includes(v))
    if (removed.length > 0 && replaceFor.length === 0) {
      type Usage = { total: number }
      const inUse: { from: string; total: number }[] = []
      for (const from of removed) {
        try {
          const res = await apollo.query<{ enumValueUsage: Usage }>({ query: GET_ENUM_VALUE_USAGE, variables: { id: e.id, value: from }, fetchPolicy: 'network-only' })
          if ((res.data?.enumValueUsage.total ?? 0) > 0) inUse.push({ from, total: res.data!.enumValueUsage.total })
        } catch (err) {
          showError(err, t('pages.dictionary.renameUsageFailed', { error: errorMessage(err) }))
          return
        }
      }
      if (inUse.length > 0) {
        // Si chiede, non si riscrive da soli: cambiare il valore di decine di
        // record è una modifica ai DATI.
        setReplaceFor(inUse)
        setReplaceWith(Object.fromEntries(inUse.map((u) => [u.from, values[0] ?? ''])))
        return
      }
    }
    const replacements = replaceFor
      .map((u) => ({ from: u.from, to: replaceWith[u.from] ?? '' }))
      .filter((r) => r.to !== '')
    setReplaceFor([])
    setReplaceWith({})
    void updateEnum({ variables: { id: e.id, input: { label, values, scope: e.isSystem ? undefined : scope, ...(replacements.length > 0 ? { replacements } : {}) } } })
  }

  const handleCancel = () => {
    setLabel(e.label)
    setScope(e.scope)
    setValues(e.values)
    setLabelDrafts({})
    setReplaceFor([])
    setReplaceWith({})
    setDirty(false)
  }

  /** L'etichetta SCRITTA per quel valore in quella lingua, o '' se non c'è. */
  const etichettaSalvata = (v: string, lingua: string) =>
    e.valueLabels.find((x) => x.value === v)?.labels.find((l) => l.language === lingua)?.label ?? ''
  /** Quella nel campo: la bozza se c'è, altrimenti quella salvata. */
  const etichettaInCampo = (v: string, lingua: string) =>
    labelDrafts[`${v}|${lingua}`] ?? etichettaSalvata(v, lingua)

  /**
   * Scrive l'etichetta di UN valore. Manda la lista intera perché la mutation
   * sostituisce in blocco: mandare solo quella toccata cancellerebbe le altre.
   * Un'etichetta uguale al valore si manda vuota — «leggi il valore» è
   * l'assenza di etichetta, non un'etichetta che ripete il valore.
   */
  const salvaEtichetta = (v: string, lingua: string) => {
    const chiave = `${v}|${lingua}`
    // No draft means the field was not edited (just focused and left, or the
    // draft was dropped with Escape): there is nothing to write. It used to be
    // read as an EMPTY label, so tabbing through a field with a saved label
    // deleted that label on the server.
    const nuova = labelDrafts[chiave]?.trim()
    if (nuova === undefined) return
    const scarta = () => setLabelDrafts((d) => { const n = { ...d }; delete n[chiave]; return n })
    if (nuova === etichettaSalvata(v, lingua)) { scarta(); return }
    // G-2: con valori aggiunti o rimossi e non salvati, scrivere le etichette
    // cancellava sul server l'etichetta dei valori rimossi localmente (la
    // mutation sostituisce in blocco) e scartava quella dei valori nuovi.
    // Prima si salvano i valori.
    if (dirty) { toast.error(t('pages.dictionary.saveValuesFirst')); return }
    // La lista INTERA, tutti i valori per tutte le lingue, dai valori SALVATI:
    // la mutation sostituisce in blocco, mandarne una sola cancellerebbe le altre.
    const lista = fullLabelList(e.values, lingue.map((l) => l.codice), etichettaSalvata, { value: v, language: lingua, label: nuova })
    scarta()
    void updateLabels({ variables: { id: e.id, input: { valueLabels: lista } } })
  }

  /** Il colore salvato per un valore, o '' se non ne ha. */
  const coloreSalvato = (v: string) => e.valueColors.find((x) => x.value === v)?.color ?? ''

  /**
   * Scrive il colore di UN valore (F9). Come per le etichette, la mutation
   * sostituisce in blocco: si manda la lista intera, nell'ordine dei valori.
   * «Nessun colore» toglie la voce.
   */
  const salvaColore = (v: string, colore: string) => {
    // G-2: come per le etichette, dai valori SALVATI e non con modifiche in
    // sospeso (un colore su un valore non ancora salvato veniva rifiutato).
    if (dirty) { toast.error(t('pages.dictionary.saveValuesFirst')); return }
    const lista = e.values.flatMap((val) => {
      const c = val === v ? colore : coloreSalvato(val)
      return c === '' ? [] : [{ value: val, color: c }]
    })
    void updateLabels({ variables: { id: e.id, input: { valueColors: lista } } })
  }

  /** Writes the icon of ONE value (G40). */
  const salvaIcona = (v: string, icona: string) => {
    if (dirty) { toast.error(t('pages.dictionary.saveValuesFirst')); return }
    void updateLabels({ variables: { id: e.id, input: { valueIcons: withValueIcon(e, v, icona) } } })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Values added and not saved were lost leaving the page, without a word (tour of 24 Sep 2026, G45). */}
      <UnsavedChangesGuard when={dirty} title={t('pages.dictionary.discardTitle')} body={t('pages.dictionary.discardBody', { label: e.label })} confirmLabel={t('pages.dictionary.discardLeave')} />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Tag size={18} style={{ color: 'var(--color-brand)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600 }}>{e.label}</h2>
        <OwnerBadge shipped={shipped} />
        {e.isSystem && !shipped && (
          <Pill bg={palette.info.bg} color="var(--color-brand)" radius={20} style={{ gap: 4, fontSize: 'var(--font-size-table)', fontWeight: 500 }}>
            <Lock size={10} aria-hidden="true" /> {t('pages.dictionary.systemBadge')}
          </Pill>
        )}
        {shipped && (
          <Button variant="primary"
            onClick={() => { void customizeEnum({ variables: { id: e.id } }) }}
            disabled={customizing}
            style={{ marginLeft: 'auto' }}
          >
            <Copy size={13} aria-hidden="true" /> {t('pages.dictionary.customizeButton')}
          </Button>
        )}
      </div>

      {customizedFromShipped && (
        <p data-testid="dictionary-customized-note" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: 0 }}>
          {t('pages.dictionary.customizedFromShipped')}
        </p>
      )}

      {(shipped || e.isSystem) && (
        <p style={{
          fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: 'var(--color-slate-bg)',
          padding: '10px 14px', borderRadius: 6, margin: 0,
        }}>
          {shipped ? t('pages.dictionary.shippedNote') : t('pages.dictionary.systemNote')}
        </p>
      )}

      {!shipped && newShipped.length > 0 && (
        <div
          role="status"
          style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            fontSize: 'var(--font-size-body)', color: palette.warning.text, background: palette.warning.bg,
            border: `1px solid ${palette.warning.border}`, padding: '10px 14px', borderRadius: 6,
          }}
        >
          <span>{t('pages.dictionary.newShipped.notice', { count: newShipped.length, values: newShipped.join(', ') })}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary"
              disabled={adopting || acknowledging}
              onClick={() => { void adoptShipped({ variables: { id: e.id } }) }}
            >
              {t('pages.dictionary.newShipped.adopt')}
            </Button>
            <Button variant="secondary"
              disabled={adopting || acknowledging}
              onClick={() => { void acknowledgeShipped({ variables: { id: e.id } }) }}
            >
              {t('pages.dictionary.newShipped.keep')}
            </Button>
          </div>
        </div>
      )}

      {/* Nome (readonly) */}
      <div>
        <label htmlFor="editor-name" style={labelS}>{t('pages.dictionary.nameLabel')}</label>
        <Input
          id="editor-name" style={{ ...readOnlyS }}
          value={e.name}
          readOnly
        />
      </div>

      {/* Label */}
      <div>
        <label htmlFor="editor-label" style={labelS}>{t('pages.dictionary.labelLabel')}</label>
        <Input
          id="editor-label" style={{ ...(shipped ? readOnlyS : {}) }}
          value={label}
          onChange={(ev) => setDirtyLabel(ev.target.value)}
          readOnly={shipped}
          aria-describedby={shipped ? 'editor-shipped-note' : undefined}
        />
      </div>

      {/* Scope */}
      <div>
        <label htmlFor="editor-scope" style={labelS}>{t('pages.dictionary.scopeLabel')}</label>
        <Select
          id="editor-scope" style={{ ...(e.isSystem || shipped ? readOnlyS : {}) }}
          value={scope}
          onChange={(ev) => setDirtyScope(ev.target.value)}
          disabled={e.isSystem || shipped}
        >
          <option value="shared">{t('pages.dictionary.scopeShared')}</option>
          <option value="itil">{t('pages.dictionary.scopeItil')}</option>
          <option value="cmdb">{t('pages.dictionary.scopeCmdb')}</option>
        </Select>
      </div>

      {/* Values */}
      <div>
        <label style={labelS}>{t('pages.dictionary.valuesLabel')}</label>
        {/* Revisione delle otto ondate · C·N-2. Erano pillole con una X: si
            potevano solo aggiungere in coda e togliere, quindi «rinominare»
            voleva dire spostare un valore in fondo — e tre regole di dominio
            leggono il vocabolario per POSIZIONE (lo stato con cui nasce un CI,
            le fasce di rischio, l'impatto più alto). Una riga per valore, con
            le operazioni che mancavano: rinomina, ordine, valore di default. */}
        <div className="og-dict-values" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, minHeight: 32 }}>
          {values.map((v, i) => (
            <div key={v} className="og-dict-row" style={{
              ...valueRowColumns(shipped, senzaEtichette ? 0 : lingue.length),
              padding: '4px 8px', background: palette.info.bg, borderRadius: 6,
              fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500,
            }}>
              {!shipped && (
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 0 }}>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || reordering}
                    style={iconBtn} aria-label={t('pages.dictionary.moveUpLabel', { value: v })}>
                    <ArrowUp size={11} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === values.length - 1 || reordering}
                    style={iconBtn} aria-label={t('pages.dictionary.moveDownLabel', { value: v })}>
                    <ArrowDown size={11} aria-hidden="true" />
                  </button>
                </span>
              )}

              {renamingFrom === v ? (
                // The rename takes the whole row after the arrows.
                <span style={{ gridColumn: '2 / -1', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <Input
                    ref={renameInputRef}
                    style={{ ...rowControlS, flex: 1 }}
                    value={renameTo}
                    onChange={(ev) => setRenameTo(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') { ev.preventDefault(); void confirmRename() }
                      if (ev.key === 'Escape') setRenamingFrom(null)
                    }}
                    aria-label={t('pages.dictionary.renameValueLabel', { value: v })}
                  />
                  <button type="button" onClick={() => void confirmRename()} disabled={renaming} style={iconBtn}
                    aria-label={t('pages.dictionary.renameConfirmLabel')}>
                    <Check size={12} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setRenamingFrom(null)} style={iconBtn} aria-label={t('common.cancel')}>
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <>
                  {/* The technical value: a long one ends in «…» and says itself whole on hover. */}
                  <span title={v} style={{ fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{v}</span>
                  {/*
                    L'ETICHETTA con cui il valore si legge a schermo (ondata 1).
                    Si scrive qui e si vede in ogni pastiglia, tendina e
                    tabella. Sul vocabolario spedito è in sola lettura, come i
                    valori: per cambiarla si usa «Personalizza», che la copia.
                  */}
                  {/* Niente colonne delle lingue quando il vocabolario non porta
                      etichette: al loro posto, sotto l'elenco, c'è la frase che
                      dice dove si scrive la lingua. Mostrare caselle vuote e
                      spiegarle a parte avrebbe lasciato in piedi l'invito a
                      compilarle. */}
                  {!senzaEtichette && lingue.map(({ codice, nome }) => (
                    shipped ? (
                      <span key={codice} style={{ fontWeight: 400, color: 'var(--color-slate)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginRight: 4 }}>{codice}</span>
                        {etichettaSalvata(v, codice) || <span style={{ fontStyle: 'italic' }}>{t('pages.dictionary.valueLabelEmpty')}</span>}
                      </span>
                    ) : (
                      <Input
                        key={codice}
                        style={rowControlS}
                        value={etichettaInCampo(v, codice)}
                        placeholder={nome}
                        onChange={(ev) => setLabelDrafts((d) => ({ ...d, [`${v}|${codice}`]: ev.target.value }))}
                        onBlur={() => salvaEtichetta(v, codice)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') { ev.preventDefault(); salvaEtichetta(v, codice) }
                          if (ev.key === 'Escape') setLabelDrafts((d) => { const n = { ...d }; delete n[`${v}|${codice}`]; return n })
                        }}
                        aria-label={t('pages.dictionary.valueLabelForLanguage', { value: v, language: nome })}
                      />
                    )
                  ))}
                  {/* How the value looks, and what can be done to it: its own line on a narrow editor. */}
                  <span className="og-dict-tools">
                    {/* Il COLORE del valore (F9): una famiglia della palette, mai un esadecimale. */}
                    <span className="og-dict-cell">
                      <span aria-hidden="true" style={{
                        width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                        background: coloreSalvato(v) ? valueColorStyle(coloreSalvato(v) as ValueColor).accent : 'transparent',
                        border: `1px solid ${palette.neutral.borderStrong}`,
                      }} />
                      <Select
                        style={{ ...rowControlS, ...(shipped ? readOnlyS : {}) }}
                        value={coloreSalvato(v)}
                        disabled={shipped || saving || savingLabels}
                        onChange={(ev) => salvaColore(v, ev.target.value)}
                        aria-label={t('pages.dictionary.valueColorLabel', { value: v })}
                      >
                        <option value="">{t('pages.dictionary.valueColorNone')}</option>
                        {VALUE_COLORS.map((c) => <option key={c} value={c}>{t(`pages.dictionary.valueColors.${c}`)}</option>)}
                      </Select>
                    </span>
                    <ValueIconControl value={v} icon={savedIcon(e, v)} disabled={shipped || saving || savingLabels}
                      style={{ ...rowControlS, ...(shipped ? readOnlyS : {}) }}
                      onChange={(icona) => salvaIcona(v, icona)} />
                    <span className="og-dict-actions">
                      {e.defaultValue === v && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-table)', fontWeight: 600 }}>
                          <Star size={10} aria-hidden="true" /> {t('pages.dictionary.defaultBadge')}
                        </span>
                      )}
                      {!shipped && (
                        <>
                          {e.defaultValue !== v && (
                            <button type="button" style={iconBtn} disabled={settingDefault}
                              onClick={() => { void setDefault({ variables: { id: e.id, input: { defaultValue: v } } }) }}
                              aria-label={t('pages.dictionary.setDefaultLabel', { value: v })}>
                              <Star size={11} aria-hidden="true" />
                            </button>
                          )}
                          <button type="button" style={iconBtn}
                            onClick={() => { setRenamingFrom(v); setRenameTo(v) }}
                            aria-label={t('pages.dictionary.renameValueLabel', { value: v })}>
                            <Pencil size={11} aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => removeValue(v)} style={iconBtn}
                            aria-label={t('pages.dictionary.removeValueLabel', { value: v })}>
                            <X size={11} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </span>
                  </span>
                </>
              )}
            </div>
          ))}
          {values.length === 0 && (
            <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('pages.dictionary.noValues')}</span>
          )}
        </div>
        {!shipped && values.length > 1 && (
          <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '0 0 8px', lineHeight: 1.45 }}>
            {t('pages.dictionary.orderNote')}
          </p>
        )}
        {/* PERCHÉ non ci sono etichette per valore: si dice qui, sotto i valori,
            dove si guardava per capire cosa mancasse. */}
        {senzaEtichette && (
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 8px', lineHeight: 1.5 }}>
            {t(senzaEtichette)}
          </p>
        )}
        {shipped ? (
          <p id="editor-shipped-note" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
            {t('pages.dictionary.shippedValuesNote')}
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Input style={{ flex: 1 }}
              value={newVal}
              onChange={(ev) => setNewVal(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addValue() } }}
              placeholder={t('pages.dictionary.addValuePlaceholder')}
              aria-label={t('pages.dictionary.addValueLabel')}
            />
            <Button variant="primary" onClick={addValue} aria-label={t('pages.dictionary.addValueLabel')}>
              <Plus size={14} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: `1px solid ${palette.neutral.borderLight}` }}>
        {/* G-11: i valori tolti e ancora usati chiedono su cosa riscrivere i
            record. Senza questa scelta l'API rifiuta, ed era un vicolo cieco. */}
        {replaceFor.length > 0 && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: `1px solid ${palette.warning.border}`, borderRadius: 8, background: palette.warning.bg, marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--font-size-body)', color: palette.warning.text }}>{t('pages.dictionary.replaceInUseIntro')}</span>
            {replaceFor.map((u) => (
              <label key={u.from} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)' }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{u.from}</span>
                <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.dictionary.replaceInUseCount', { count: u.total })}</span>
                <span aria-hidden="true">→</span>
                <Select style={{ height: 26, width: 'auto', fontWeight: 400 }}
                  value={replaceWith[u.from] ?? ''}
                  onChange={(ev) => setReplaceWith((m) => ({ ...m, [u.from]: ev.target.value }))}
                  aria-label={t('pages.dictionary.replaceInUseLabel', { value: u.from })}
                >
                  {values.map((v) => <option key={v} value={v}>{etichettaSalvata(v, lingue[0]?.codice ?? '') || v}</option>)}
                </Select>
              </label>
            ))}
          </div>
        )}
        {dirty && (
          <>
            <Button variant="primary" onClick={() => handleSave()} disabled={saving}>
              <Save size={14} aria-hidden="true" /> {t('common.save')}
            </Button>
            <Button variant="secondary" onClick={handleCancel}>
              {t('common.cancel')}
            </Button>
          </>
        )}
        {!e.isSystem && !shipped && (
          <div style={{ marginLeft: 'auto' }}>
            {!confirmDelete ? (
              <Button variant="danger" size="xs" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} aria-hidden="true" /> {t('common.delete')}
              </Button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>{t('pages.dictionary.confirmDelete')}</span>
                <Button variant="danger" size="xs"
                  onClick={() => { void deleteEnum({ variables: { id: e.id } }) }}
                  disabled={deleting}
                >
                  {t('pages.dictionary.confirmYes')}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                  {t('common.no')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function EnumDesignerPage() {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const confirm = useConfirm()
  /** Another dictionary replaces the editor: unsaved values would be lost, so it asks first (G45). */
  const choose = (id: string | null) => void (async () => {
    if (editorDirty && id !== selectedId) {
      const ok = await confirm({ title: t('pages.dictionary.discardTitle'), body: t('pages.dictionary.discardBody', { label: selected?.label ?? '' }), confirmLabel: t('pages.dictionary.discardLeave'), danger: true })
      if (!ok) return
    }
    setEditorDirty(false)
    setSelectedId(id)
  })()
  const [showCreate, setShowCreate] = useState(false)

  const { data, loading } = useQuery<{ enumTypes: EnumType[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  // U-17: un vocabolario per nome, quello che vale (la copia del cliente nasconde l'originale).
  const allEnums = dictionaryList(data?.enumTypes ?? [])

  // Group by scope (use i18n scope labels)
  const SCOPE_LABELS: Record<string, string> = {
    shared: t('pages.dictionary.scopeShared'),
    itil:   t('pages.dictionary.scopeItil'),
    cmdb:   t('pages.dictionary.scopeCmdb'),
  }

  const groups: Record<string, typeof allEnums> = {}
  for (const e of allEnums) {
    const g = SCOPE_LABELS[e.scope] ?? e.scope
    if (!groups[g]) groups[g] = []
    groups[g]!.push(e)
  }

  const selected = allEnums.find((e) => e.id === selectedId) ?? null

  const handleCreated = (e: EnumType) => {
    setShowCreate(false)
    setSelectedId(e.id)
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Tag size={22} color="var(--color-icon-accent)" />}>
          {t('pages.dictionary.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('pages.dictionary.subtitle')}
        </p>
      </div>

      <DetailLayout sideWidth={220} sideFirst gap={20}>
        {/* Left: enum list */}
        <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('pages.dictionary.listHeader')}</span>
            <Button variant="primary" size="xs"
              onClick={() => setShowCreate(true)}
              aria-label={t('pages.dictionary.createTitle')}
            >
              <Plus size={12} aria-hidden="true" /> {t('pages.dictionary.newButton')}
            </Button>
          </div>

          <div style={{ maxHeight: 'calc(var(--vh-app) - 220px)', overflowY: 'auto' }}>
            {loading && !allEnums.length && (
              <p style={{ padding: '20px 16px', fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('pages.dictionary.loading')}</p>
            )}
            {Object.entries(groups).map(([groupName, items]) => (
              <div key={groupName}>
                <div style={{
                  padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: 'var(--color-slate-light)', background: 'var(--color-slate-bg)',
                  borderBottom: `1px solid ${palette.neutral.borderLight}`,
                }}>
                  {groupName}
                </div>
                {items.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => choose(e.id)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 16px',
                      background: selectedId === e.id ? palette.info.light : 'transparent',
                      border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                      borderLeft: selectedId === e.id ? '3px solid var(--color-brand)' : '3px solid transparent',
                      borderBottom: `1px solid ${palette.neutral.borderLight}`,
                    }}
                    aria-current={selectedId === e.id ? 'true' : undefined}
                    aria-label={`${e.label} — ${e.isShipped ? t('pages.dictionary.shippedBadge') : t('pages.dictionary.ownBadge')} — ${t('pages.dictionary.valueCount', { count: e.values.length })}`}
                  >
                    {e.isShipped
                      ? <Package  size={11} style={{ color: 'var(--color-slate-light)', flexShrink: 0 }} aria-hidden="true" />
                      : <LockOpen size={11} style={{ color: 'var(--color-brand)', flexShrink: 0 }} aria-hidden="true" />
                    }
                    {/*
                      Terza revisione, trovato in un browser vero: qui c'era
                      anche `<OwnerBadge compact />`, e con `flexShrink: 0` e la
                      parola intera («Spedito col prodotto», ~105px in una
                      colonna di 220) il NOME finiva schiacciato a 16 pixel —
                      una lettera e i puntini — senza nemmeno un `title` per
                      recuperarlo. Il `compact` rimpiccioliva font e padding, non
                      la parola. Il distintivo era anche ridondante: l'icona qui
                      a sinistra dice la stessa cosa. Resta intero nel pannello
                      di destra, dove c'e spazio; qui il proprietario entra nel
                      NOME ACCESSIBILE della riga, cosi non si perde per chi non
                      vede le icone.
                    */}
                    <span
                      title={e.label}
                      style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-body)', fontWeight: selectedId === e.id ? 600 : 500, color: selectedId === e.id ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {e.label}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', flexShrink: 0 }}>
                      {e.values.length}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Right: editor */}
        <div>
          {selected ? (
            <EnumEditor
              key={selected.id}
              enumType={selected}
              customizedFromShipped={selected.customizedFromShipped}
              onDeleted={() => setSelectedId(null)}
              onCustomized={(copy) => setSelectedId(copy.id)}
              onDirtyChange={setEditorDirty}
            />
          ) : (
            <div style={{
              background: colors.white, border: '1px solid var(--border)', borderRadius: 10,
              padding: 40, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)',
            }}>
              {t('common.noResults')}
            </div>
          )}
        </div>
      </DetailLayout>

      {/* Create dialog */}
      {showCreate && (
        <CreateEnumDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </PageContainer>
  )
}
